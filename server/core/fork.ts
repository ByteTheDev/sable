import type { TimelineItem, UserItem } from '../../shared/protocol';

/**
 * Forking a conversation at an answer: everything up to the end of the turn that holds the
 * answer stays, the next message the person sent (and all after it) does not.
 */
export function cutAt(items: TimelineItem[], itemId: string): { kept: TimelineItem[]; next?: UserItem } | null {
  const at = items.findIndex((i) => i.id === itemId);
  if (at < 0) return null;
  for (let i = at + 1; i < items.length; i++) {
    const it = items[i];
    if (it.type === 'user' && !it.parentId && it.state !== 'queued') return { kept: items.slice(0, i), next: it };
  }
  return { kept: items.filter((i) => !(i.type === 'user' && i.state === 'queued')) };
}

/**
 * Claude Code: the message to fork up to (inclusive), from the session's main chain of message
 * uuids. The entry right before the next sent message ends the turn; with no next message the
 * whole conversation is copied (`undefined`). `null` when the point cannot be found in the chain.
 */
export function claudeForkPoint(chain: string[], next: UserItem | undefined): string | undefined | null {
  if (!next) return undefined;
  const k = next.providerId ? chain.indexOf(next.providerId) : -1;
  return k > 0 ? chain[k - 1] : null;
}

/** Codex: the last turn to keep (item ids are `turnId:itemId`), or null when none carries one. */
export function codexForkTurn(kept: TimelineItem[]): string | null {
  for (let i = kept.length - 1; i >= 0; i--) {
    const id = kept[i].id;
    const cut = id.indexOf(':');
    if (cut > 0) return id.slice(0, cut);
  }
  return null;
}
