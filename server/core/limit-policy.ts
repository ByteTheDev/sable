import type { LimitsMeta, ProviderId, RateLimit } from '../../shared/protocol';

/**
 * What a session does at a plan limit, in this order: carry on with credits (or extra usage) when
 * the account allows it in Sable and the agent has them, otherwise move to the next account when
 * that setting is on and one has room, otherwise stop with the notice.
 */
export type AtLimit = 'credits' | 'next' | 'stop';

export function decideAtLimit(o: { creditsAllowed: boolean; creditsAvailable: boolean; continueAtLimit: boolean; next?: string }): AtLimit {
  if (o.creditsAllowed && o.creditsAvailable) return 'credits';
  if (o.continueAtLimit && o.next) return 'next';
  return 'stop';
}

/** The agent says the account has credits or extra usage that can carry it past a limit. */
export function creditsAvailable(meta: LimitsMeta | undefined): boolean {
  if (!meta) return false;
  if (meta.extra?.enabled) return !meta.extra.limit || (meta.extra.used ?? 0) < meta.extra.limit;
  const c = meta.credits;
  if (!c) return false;
  if (c.unlimited) return true;
  const n = Number(c.balance);
  return c.balance !== undefined ? Number.isFinite(n) && n > 0 : !!c.has;
}

/** The session's account is past a limit and the agent carries it on credits or extra usage. */
export const runningOnCredits = (meta: LimitsMeta | undefined) => !!(meta?.extra?.inUse || meta?.credits?.inUse);

/** The key a per-account credits choice is stored under (`AppSettings.creditsAtLimit`). */
export const creditsKey = (provider: ProviderId, accountId: string) => `${provider}:${accountId}`;

export interface ResetAlert {
  at: number;
  provider: ProviderId;
  accountId: string;
  window: string;
}

/**
 * The next moment a full window resets, among the accounts given: windows at 100% whose reset is
 * after `now`. Undefined when no capped window has a reset ahead. Ties keep the order given.
 */
export function nextResetAlert(accounts: { provider: ProviderId; accountId: string; limits: RateLimit[] }[], now: number): ResetAlert | undefined {
  let best: ResetAlert | undefined;
  for (const a of accounts)
    for (const l of a.limits) {
      if (l.percent < 100 || !l.resetsAt || l.resetsAt <= now) continue;
      if (!best || l.resetsAt < best.at) best = { at: l.resetsAt, provider: a.provider, accountId: a.accountId, window: l.label };
    }
  return best;
}

/** Full windows whose reset fell in (since, now]: what to announce when the timer fires. */
export function dueResets(accounts: { provider: ProviderId; accountId: string; limits: RateLimit[] }[], since: number, now: number): ResetAlert[] {
  const out: ResetAlert[] = [];
  for (const a of accounts)
    for (const l of a.limits) if (l.percent >= 100 && l.resetsAt && l.resetsAt > since && l.resetsAt <= now) out.push({ at: l.resetsAt, provider: a.provider, accountId: a.accountId, window: l.label });
  return out.sort((x, y) => x.at - y.at);
}
