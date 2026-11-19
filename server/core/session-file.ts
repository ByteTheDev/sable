import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { open, rename, writeFile } from 'node:fs/promises';
import type { QueuedMessage, TimelineItem, Todo } from '../../shared/protocol';

/**
 * A session's timeline on disk, as a base file and a small tail.
 *
 * A long chat holds hundreds of megabytes (images in tool output, long outputs). Writing all of it
 * again after every streamed word kept the bridge (the desktop's main process) busy for about a
 * second at a time and wrote tens of gigabytes an hour. Now:
 *
 * - `<id>.json`, the base: `{ gen, items, todos, queue }`, the same shape as before (older files
 *   have no `gen`, read as 0). It holds the items up to some point and is written again only when
 *   one of those changes, is removed or moves (a rewind, a late patch to an old step), or when the
 *   tail has grown past `TAIL_MAX`. That write goes out in pieces of about a megabyte, so it never
 *   blocks for long.
 * - `<id>.tail.json`: `{ baseGen, items, todos, queue }`, the items after the base. Small; written
 *   on every save.
 *
 * Every write goes to a temporary file first and is renamed into place, so a crash leaves either
 * the old or the new file. The tail names the base it continues (`baseGen`): after a crash between
 * a new base and the removal of the old tail, the tail no longer matches and is ignored (the new
 * base already holds everything). Reading combines the base's items with a matching tail's.
 *
 * The runtime says which items changed since the last save (`dirty`), so the store can tell
 * whether the base still holds: everything that changes an item goes through the runtime.
 */

export interface SessionData {
  items: TimelineItem[];
  todos: Todo[];
  queue?: QueuedMessage[];
}

export interface SessionSave extends SessionData {
  /** Ids of items changed or added since the last save; 'all' when unknown (a reload, a reset). */
  dirty: Set<string> | 'all';
}

/** The tail is folded into the base once it is bigger than this. */
export const TAIL_MAX = 8 * 1024 * 1024;
/** A base smaller than this is simply written whole every time (as before). */
export const SMALL_BASE = 4 * 1024 * 1024;
/** Pieces of the base written per step (characters). */
const CHUNK = 1 << 20;

interface Base {
  gen: number;
  ids: string[];
  idSet: Set<string>;
  /** The base file's size in characters as written (an estimate for the small-base rule). */
  size: number;
}

const readJson = <T>(file: string): T | null => {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

export class SessionFiles {
  private bases = new Map<string, Base>();
  /** The write in progress per session: the next waits for it (two writes never share a temporary file). */
  private writing = new Map<string, Promise<void>>();
  /** Sessions whose last write failed: what changed is no longer known, so the next write is whole. */
  private force = new Set<string>();

  constructor(private readonly pathOf: (id: string) => string) {}

  private tailOf(id: string) {
    return this.pathOf(id).replace(/\.json$/, '.tail.json');
  }

  load(id: string): SessionData {
    const base = readJson<SessionData & { gen?: number }>(this.pathOf(id));
    if (!base) return { items: [], todos: [] };
    const gen = typeof base.gen === 'number' ? base.gen : 0;
    const items = Array.isArray(base.items) ? base.items : [];
    let size = 0;
    try {
      size = statSync(this.pathOf(id)).size;
    } catch {
      /* gone meanwhile: written whole next time */
    }
    this.bases.set(id, { gen, ids: items.map((i) => i.id), idSet: new Set(items.map((i) => i.id)), size });
    const tail = readJson<SessionData & { baseGen?: number }>(this.tailOf(id));
    if (tail && tail.baseGen === gen && Array.isArray(tail.items)) {
      return { items: items.concat(tail.items), todos: tail.todos ?? base.todos ?? [], queue: tail.queue ?? base.queue };
    }
    return { items, todos: base.todos ?? [], queue: base.queue };
  }

  /** Writes what changed. Calls for one session run one after another. */
  save(id: string, data: () => SessionSave): Promise<void> {
    const prev = this.writing.get(id) ?? Promise.resolve();
    const next = prev.then(() => this.write(id, data())).catch(() => void this.force.add(id));
    this.writing.set(id, next);
    void next.finally(() => this.writing.get(id) === next && this.writing.delete(id));
    return next;
  }

  remove(id: string) {
    this.bases.delete(id);
    this.force.delete(id);
    for (const f of [this.pathOf(id), this.tailOf(id)]) {
      try {
        rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /** Waits for the writes in progress. */
  async idle() {
    await Promise.all([...this.writing.values()]);
  }

  private async write(id: string, save: SessionSave) {
    const base = this.bases.get(id);
    const { items } = save;
    let whole = !base || this.force.has(id) || save.dirty === 'all' || base.size < SMALL_BASE || items.length < base.ids.length;
    if (!whole && base) {
      for (let i = 0; i < base.ids.length; i++) {
        if (items[i].id !== base.ids[i]) {
          whole = true;
          break;
        }
      }
      if (!whole && save.dirty !== 'all') {
        for (const d of save.dirty) {
          if (base.idSet.has(d)) {
            whole = true;
            break;
          }
        }
      }
    }
    if (!whole && base) {
      const tail = JSON.stringify({ baseGen: base.gen, items: items.slice(base.ids.length), todos: save.todos, queue: save.queue });
      if (tail.length <= TAIL_MAX) {
        await atomicWrite(this.tailOf(id), tail);
        return;
      }
    }
    const gen = (base?.gen ?? 0) + 1;
    const size = await writeBase(this.pathOf(id), gen, save);
    this.bases.set(id, { gen, ids: items.map((i) => i.id), idSet: new Set(items.map((i) => i.id)), size });
    this.force.delete(id);
    // The new base holds everything: the old tail no longer matches it (and is ignored if this fails).
    try {
      rmSync(this.tailOf(id), { force: true });
    } catch {
      /* ignored on the next read: its baseGen is old */
    }
  }
}

async function atomicWrite(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

/** The whole timeline as the base, in pieces of about a megabyte so the event loop keeps running. Returns its size in characters. */
async function writeBase(file: string, gen: number, save: SessionData): Promise<number> {
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await open(tmp, 'w');
  let size = 0;
  try {
    let buf = `{"gen":${gen},"items":[`;
    for (let i = 0; i < save.items.length; i++) {
      buf += (i ? ',' : '') + JSON.stringify(save.items[i]);
      if (buf.length >= CHUNK) {
        size += buf.length;
        await fh.write(buf, null, 'utf8');
        buf = '';
      }
    }
    buf += `],"todos":${JSON.stringify(save.todos ?? [])}${save.queue ? `,"queue":${JSON.stringify(save.queue)}` : ''}}`;
    size += buf.length;
    await fh.write(buf, null, 'utf8');
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
  return size;
}
