/** What find-in-conversation looks through: your messages and the agent's text, in order. */
export interface FindSource {
  id: string;
  text: string;
}

export interface FindHit {
  itemId: string;
  /** How many times the query occurs in this item. */
  count: number;
}

/** Occurrences of `needle` in `hay`, case-insensitive, not overlapping. */
export function countIn(hay: string, needle: string): number {
  const n = needle.toLowerCase();
  if (!n) return 0;
  const h = hay.toLowerCase();
  let count = 0;
  for (let i = h.indexOf(n); i >= 0; i = h.indexOf(n, i + n.length)) count++;
  return count;
}

/** The items that contain the query, in conversation order, with their occurrence counts. */
export function findHits(sources: FindSource[], query: string): FindHit[] {
  const q = query.trim();
  if (!q) return [];
  const hits: FindHit[] = [];
  for (const s of sources) {
    const count = countIn(s.text, q);
    if (count) hits.push({ itemId: s.id, count });
  }
  return hits;
}

export interface Cursor {
  /** Index into the hits. */
  hit: number;
  /** Which occurrence within that item. */
  nth: number;
}

export const totalOf = (hits: FindHit[]) => hits.reduce((n, h) => n + h.count, 0);

/** The cursor's place among all occurrences, 1-based; 0 when there is none. */
export function ordinal(hits: FindHit[], c: Cursor | null): number {
  if (!c || !hits[c.hit]) return 0;
  let n = 0;
  for (let i = 0; i < c.hit; i++) n += hits[i].count;
  return n + Math.min(c.nth, hits[c.hit].count - 1) + 1;
}

/** One occurrence forward or back, wrapping at the ends. */
export function step(hits: FindHit[], c: Cursor | null, dir: 1 | -1): Cursor | null {
  if (!hits.length) return null;
  if (!c || !hits[c.hit]) return dir === 1 ? { hit: 0, nth: 0 } : { hit: hits.length - 1, nth: hits[hits.length - 1].count - 1 };
  const nth = c.nth + dir;
  if (nth >= 0 && nth < hits[c.hit].count) return { hit: c.hit, nth };
  const hit = (c.hit + dir + hits.length) % hits.length;
  return { hit, nth: dir === 1 ? 0 : hits[hit].count - 1 };
}

/**
 * Where to start: the last occurrence (the most recent part of the conversation is what people
 * look for first), or the cursor's item when it still matches.
 */
export function startAt(hits: FindHit[], prevItem?: string): Cursor | null {
  if (!hits.length) return null;
  const same = prevItem ? hits.findIndex((h) => h.itemId === prevItem) : -1;
  if (same >= 0) return { hit: same, nth: 0 };
  const last = hits.length - 1;
  return { hit: last, nth: hits[last].count - 1 };
}

/** The next message of yours to jump to from the one at `from` (-1: none above the view yet). */
export function jumpTarget(userIds: string[], from: number, dir: 1 | -1): string | undefined {
  if (!userIds.length) return undefined;
  const i = from + dir;
  if (i < 0) return userIds[0];
  if (i >= userIds.length) return undefined;
  return userIds[i];
}
