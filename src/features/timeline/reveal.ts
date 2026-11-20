import type { TimelineItem } from '@shared/protocol';

/**
 * Ask the open timeline to show an item, even one far up a long transcript whose row is not
 * built yet: the timeline builds rows up to it, scrolls it into view and highlights it briefly.
 */
export const REVEAL_EVENT = 'sable:reveal-item';

/** `quiet`: build it and open what hides it, but leave the scrolling to the caller (no centring, no glow). */
export type RevealDetail = { sessionId: string; itemId: string; quiet?: boolean };

export function revealItem(sessionId: string, itemId: string, opts?: { quiet?: boolean }) {
  window.dispatchEvent(new CustomEvent<RevealDetail>(REVEAL_EVENT, { detail: { sessionId, itemId, quiet: opts?.quiet } }));
}

/** The top-level item an item lives under (sub-agent tool calls nest under their agent). */
export function rootOf(items: Record<string, TimelineItem | undefined>, id: string): string {
  let cur = id;
  for (let guard = 0; guard < 64; guard++) {
    const parent = items[cur]?.parentId;
    if (!parent || !items[parent]) return cur;
    cur = parent;
  }
  return cur;
}
