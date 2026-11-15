import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Last known answers that are slow to get (provider sign-in, capabilities), kept on disk under
 * `<home>/cache/` so start-up can show them at once and refresh in the background. Every entry
 * is a hint: a missing, unreadable or stale file simply means "ask the agent".
 */
export class DiskCache {
  readonly dir: string;
  private mem = new Map<string, unknown>();
  private writing = new Map<string, Promise<void>>();

  constructor(home: string) {
    this.dir = path.join(home, 'cache');
  }

  private file(key: string) {
    const slug = key.replace(/[^\w.-]+/g, '_').slice(0, 48);
    return path.join(this.dir, `${slug}-${createHash('sha1').update(key).digest('hex').slice(0, 10)}.json`);
  }

  get<T>(key: string): T | undefined {
    if (this.mem.has(key)) return this.mem.get(key) as T;
    let value: T | undefined;
    try {
      const raw = JSON.parse(readFileSync(this.file(key), 'utf8')) as { key: string; value: T };
      if (raw?.key === key) value = raw.value;
    } catch {
      /* no entry yet */
    }
    this.mem.set(key, value);
    return value;
  }

  /** Stores a value; returns false when it equals what was there (nothing to tell anyone). */
  set<T>(key: string, value: T): boolean {
    const before = this.get<T>(key);
    if (before !== undefined && JSON.stringify(before) === JSON.stringify(value)) return false;
    this.mem.set(key, value);
    const file = this.file(key);
    const prev = this.writing.get(key) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        mkdirSync(this.dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify({ key, value }), 'utf8');
        await rename(tmp, file);
      })
      .catch(() => {
        /* the cache is best effort */
      });
    this.writing.set(key, next);
    void next.finally(() => {
      if (this.writing.get(key) === next) this.writing.delete(key);
    });
    return true;
  }

  async flush() {
    await Promise.all([...this.writing.values()]);
  }
}
