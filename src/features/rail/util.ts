import { useMemo, useRef } from 'react';
import type { ToolItem } from '@shared/protocol';
import { useStore } from '@/state/store';

export function splitPath(path: string): [dir: string, base: string] {
  const p = path.replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

const NONE: string[] = [];

/**
 * Ids of this session's tool items (top level and inside sub-agents) that pass `test`,
 * in timeline order. Returns the same array until the matching set changes, so
 * streaming text elsewhere in the session does not re-render the caller.
 */
export function useToolIds(sessionId: string, test: (it: ToolItem) => boolean): string[] {
  const selector = useMemo(() => {
    let lastItems: unknown = null;
    let lastKey = '';
    let lastIds: string[] = NONE;
    return (s: ReturnType<typeof useStore.getState>): string[] => {
      const d = s.data[sessionId];
      if (!d) return NONE;
      if (d.items === lastItems) return lastIds;
      lastItems = d.items;
      const ids: string[] = [];
      for (const id in d.items) {
        const it = d.items[id];
        if (it.type === 'tool' && test(it)) ids.push(id);
      }
      ids.sort((a, b) => (d.items[a].ts - d.items[b].ts) || 0);
      const key = ids.join('\u0000');
      if (key !== lastKey) {
        lastKey = key;
        lastIds = ids.length ? ids : NONE;
      }
      return lastIds;
    };
    // `test` is expected to be a stable predicate; callers pass inline arrows that only read the item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  return useStore(selector);
}

export function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(p);
}

export function isAbsolute(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(p);
}

export function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + rel.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep);
}

/**
 * Keys that joined a list while it was on screen: those rows arrive with a short rise (`data-new`).
 * The first set is simply there, and so is a whole batch (a tree that just loaded, a new plan).
 */
export function useArrivals(keys: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  if (!seen.current) seen.current = new Set(keys);
  else {
    const news = keys.filter((k) => !seen.current!.has(k));
    const quiet = seen.current.size === 0 || news.length > 6;
    for (const k of news) {
      seen.current.add(k);
      if (!quiet) fresh.current.add(k);
    }
  }
  return fresh.current;
}
