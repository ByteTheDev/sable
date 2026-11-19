import type { PermissionRequest, QuestionRequest, SessionMeta } from '@shared/protocol';
import type { SessionData, Store } from './store';

/** One prompt waiting on the user, in any session (the triage deck's card). */
export type PendingPrompt =
  | { key: string; kind: 'permission'; sessionId: string; since: number; req: PermissionRequest }
  | { key: string; kind: 'question'; sessionId: string; since: number; req: QuestionRequest };

export const promptKey = (kind: PendingPrompt['kind'], id: string) => `${kind}:${id}`;

/**
 * Every open permission request and question across sessions, oldest first (ties keep a stable
 * order: session, then permissions before questions). Prompts of sessions the window no longer
 * knows are left out.
 */
export function collectPending(data: Record<string, SessionData>, sessions: Record<string, SessionMeta>): PendingPrompt[] {
  const out: PendingPrompt[] = [];
  for (const [sessionId, d] of Object.entries(data)) {
    if (!sessions[sessionId]) continue;
    for (const req of d.permissions) out.push({ key: promptKey('permission', req.id), kind: 'permission', sessionId, since: req.createdAt, req });
    for (const req of d.questions) out.push({ key: promptKey('question', req.id), kind: 'question', sessionId, since: req.createdAt, req });
  }
  // Array.prototype.sort is stable: equal times keep the order above.
  return out.sort((a, b) => a.since - b.since);
}

let memo: { refs: unknown[]; out: PendingPrompt[] } = { refs: [], out: [] };

/**
 * `collectPending` for a store subscription: the same array back until some session's prompts
 * change, so streaming (which replaces `data` every frame) re-renders nothing that reads it.
 */
export function selectPending(s: Pick<Store, 'data' | 'sessions'>): PendingPrompt[] {
  const refs: unknown[] = [];
  for (const [id, d] of Object.entries(s.data)) {
    if (!d.permissions.length && !d.questions.length) continue;
    refs.push(id, d.permissions, d.questions, !!s.sessions[id]);
  }
  if (refs.length === memo.refs.length && refs.every((r, i) => r === memo.refs[i])) return memo.out;
  memo = { refs, out: collectPending(s.data, s.sessions) };
  return memo.out;
}

/**
 * How many prompts wait, for the top bar's count: all of them, but only while at least one is
 * outside the open session (the open session's own prompt is already in front of the user).
 */
export function selectWaitingCount(s: Pick<Store, 'data' | 'sessions' | 'ui'>): number {
  let total = 0;
  let elsewhere = false;
  for (const [id, d] of Object.entries(s.data)) {
    const n = d.permissions.length + d.questions.length;
    if (!n || !s.sessions[id]) continue;
    total += n;
    if (id !== s.ui.activeSessionId) elsewhere = true;
  }
  return elsewhere ? total : 0;
}
