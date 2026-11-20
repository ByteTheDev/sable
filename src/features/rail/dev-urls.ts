import { useSyncExternalStore } from 'react';
import { gitKey } from './git-state';

/**
 * The last dev-server address each folder printed (in the panel terminal) or opened (from a chip),
 * kept in this viewer's local storage, so an empty Browser tab can offer it as one quiet line.
 */

export interface RememberedUrl {
  url: string;
  /** What printed it: a script's name or the command ("pnpm run dev"). */
  from?: string;
  ts: number;
}

const KEY = 'sable.devUrls.v1';
const MAX = 40;
const listeners = new Set<() => void>();
let map: Record<string, RememberedUrl> | null = null;

function load(): Record<string, RememberedUrl> {
  if (map) return map;
  map = {};
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, Partial<RememberedUrl>>)) {
        if (typeof v?.url === 'string' && /^https?:\/\//.test(v.url)) map[k] = { url: v.url, from: typeof v.from === 'string' ? v.from.slice(0, 200) : undefined, ts: Number(v.ts) || 0 };
      }
    }
  } catch {
    /* start empty */
  }
  return map;
}

/** Notes a folder's dev-server address; the newest wins. */
export function rememberDevUrl(cwd: string, url: string, from?: string) {
  if (!cwd || !/^https?:\/\//.test(url)) return;
  const all = load();
  const k = gitKey(cwd);
  const cur = all[k];
  const label = from?.trim().slice(0, 200) || undefined;
  if (cur && cur.url === url && (cur.from === label || !label)) return;
  const next = { ...all, [k]: { url, from: label ?? (cur?.url === url ? cur.from : undefined), ts: Date.now() } };
  // The oldest folders go first beyond the bound.
  const keys = Object.keys(next).sort((a, b) => next[b].ts - next[a].ts);
  for (const old of keys.slice(MAX)) delete next[old];
  map = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode: kept for this run only */
  }
  for (const l of listeners) l();
}

export function lastDevUrlFor(cwd: string): RememberedUrl | undefined {
  return cwd ? load()[gitKey(cwd)] : undefined;
}

export function useRememberedUrl(cwd: string): RememberedUrl | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => lastDevUrlFor(cwd),
  );
}
