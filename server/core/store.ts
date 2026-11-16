import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isBackdropImageId, migrateBackdrop, normalizeBackdrop } from '../../shared/backdrop';
import { DEFAULT_SETTINGS, type AppSettings, type Project, type ProviderId, type QueuedMessage, type SessionMeta, type TimelineItem, type Todo } from '../../shared/protocol';

/** An account in the registry. The built-in `default` account of each provider is stored too (for its label). */
export interface StoredAccount {
  id: string;
  provider: ProviderId;
  label: string;
  createdAt: number;
  /** A folder the user already had ("Use an existing folder"): used in place, forgotten on removal, never deleted. */
  dir?: string;
  /** The label was given by Sable ("Account 2"): the first sign-in names the account instead. */
  autoLabel?: boolean;
}

interface StateFile {
  projects: Project[];
  settings: AppSettings;
  sessions: SessionMeta[];
  accounts: StoredAccount[];
}

interface SessionFile {
  items: TimelineItem[];
  todos: Todo[];
  /** Messages waiting for the running turn to end (absent in older files). */
  queue?: QueuedMessage[];
}

/** JSON persistence under ~/.sable. Writes are debounced and atomic. */
export class Store {
  readonly dir: string;
  state: StateFile;
  private timers = new Map<string, NodeJS.Timeout>();
  private pending = new Map<string, () => unknown>();

  constructor(dir?: string) {
    this.dir = dir ?? process.env.SABLE_HOME ?? path.join(homedir(), '.sable');
    mkdirSync(path.join(this.dir, 'sessions'), { recursive: true });
    this.state = this.readJson<StateFile>(this.statePath) ?? { projects: [], settings: { ...DEFAULT_SETTINGS }, sessions: [], accounts: [] };
    this.state.settings = { ...DEFAULT_SETTINGS, ...this.state.settings };
    // One-time move to the current default backdrop for profiles saved before it existed
    // (their stored value is the old default, not a choice the user made).
    const versioned = this.state.settings as AppSettings & { rev?: number };
    if (!versioned.rev || versioned.rev < 2) {
      versioned.backdrop = DEFAULT_SETTINGS.backdrop;
      versioned.rev = 2;
    }
    // The backdrop config replaces the ambience / backdrop / texture switches (read once, here).
    if (versioned.rev < 3) {
      versioned.backdropConfig = migrateBackdrop(versioned);
      versioned.rev = 3;
    }
    versioned.backdropImages = (Array.isArray(versioned.backdropImages) ? versioned.backdropImages : []).filter((i) => isBackdropImageId(i?.id));
    versioned.backdropConfig = normalizeBackdrop(
      versioned.backdropConfig,
      versioned.backdropImages.map((i) => i.id),
    );
    this.state.projects ??= [];
    this.state.sessions ??= [];
    this.state.accounts ??= [];
  }

  private get statePath() {
    return path.join(this.dir, 'state.json');
  }

  private sessionPath(id: string) {
    return path.join(this.dir, 'sessions', `${id}.json`);
  }

  private readJson<T>(file: string): T | null {
    try {
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private schedule(file: string, data: () => unknown, delay: number) {
    this.pending.set(file, data);
    if (this.timers.has(file)) return;
    this.timers.set(
      file,
      setTimeout(() => {
        this.timers.delete(file);
        void this.flushFile(file);
      }, delay),
    );
  }

  private async flushFile(file: string) {
    const data = this.pending.get(file);
    if (!data) return;
    this.pending.delete(file);
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data()), 'utf8');
      await rename(tmp, file);
    } catch {
      /* best effort */
    }
  }

  saveState() {
    this.schedule(this.statePath, () => this.state, 400);
  }

  loadSession(id: string): SessionFile {
    return this.readJson<SessionFile>(this.sessionPath(id)) ?? { items: [], todos: [] };
  }

  saveSession(id: string, data: () => SessionFile) {
    this.schedule(this.sessionPath(id), data, 1500);
  }

  deleteSession(id: string) {
    const file = this.sessionPath(id);
    const t = this.timers.get(file);
    if (t) clearTimeout(t);
    this.timers.delete(file);
    this.pending.delete(file);
    try {
      rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  }

  async flush() {
    for (const [file, t] of this.timers) {
      clearTimeout(t);
      this.timers.delete(file);
    }
    await Promise.all([...this.pending.keys()].map((f) => this.flushFile(f)));
  }
}
