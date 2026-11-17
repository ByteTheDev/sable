/**
 * A speed billed outside the plan (Claude Code's fast mode) is asked for once per session: the
 * sessions that said yes, and an ask `/fast` leaves for the effort popover to show.
 */
const confirmed = new Set<string>();
let pending: { sessionId: string; speed: string } | null = null;

export const paidConfirmed = (sessionId: string | null | undefined) => !!sessionId && confirmed.has(sessionId);

export function confirmPaid(sessionId: string) {
  confirmed.add(sessionId);
}

/** `/fast` on a paid speed: the popover opens with the question instead of switching. */
export function paidAsk(sessionId: string, speed: string) {
  pending = { sessionId, speed };
}

/** The ask left for this session, taken once. */
export function takePaidAsk(sessionId: string | null | undefined): string | undefined {
  if (!pending || pending.sessionId !== sessionId) return undefined;
  const s = pending.speed;
  pending = null;
  return s;
}

/** Tests only. */
export function resetPaid() {
  confirmed.clear();
  pending = null;
}
