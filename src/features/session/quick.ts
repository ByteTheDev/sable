/** What the quick switcher needs of a session. */
export interface QuickSession {
  id: string;
  updatedAt: number;
  archived?: boolean;
}

/**
 * Sessions in the order Ctrl+Tab walks them: the ones visited in this run of the app, most recent
 * first, then the rest by their last activity. Archived sessions are left out.
 */
export function recentOrder<T extends QuickSession>(sessions: T[], visits: string[], limit = 9): T[] {
  const live = sessions.filter((s) => !s.archived);
  const byId = new Map(live.map((s) => [s.id, s]));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const id of visits) {
    const s = byId.get(id);
    if (s && !seen.has(id)) {
      seen.add(id);
      out.push(s);
    }
  }
  for (const s of [...live].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (!seen.has(s.id)) out.push(s);
  }
  return out.slice(0, limit);
}

/** A visit moves a session to the front. */
export function visit(visits: string[], id: string, keep = 30): string[] {
  return [id, ...visits.filter((v) => v !== id)].slice(0, keep);
}

/**
 * Where the first press lands: the session before the open one (the usual "back to the last
 * one"), or the most recent session when none is open.
 */
export function firstIndex(ids: string[], active: string | null, dir: 1 | -1): number {
  if (!ids.length) return -1;
  const at = active ? ids.indexOf(active) : -1;
  if (at < 0) return dir === 1 ? 0 : ids.length - 1;
  return (at + dir + ids.length) % ids.length;
}

export const cycle = (index: number, len: number, dir: 1 | -1) => (len ? (index + dir + len) % len : -1);
