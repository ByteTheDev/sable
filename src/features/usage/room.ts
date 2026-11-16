import type { ProviderId, RateLimit } from '@shared/protocol';

/** What ordering needs to know about one account. */
export interface RoomInput {
  key: string;
  provider: ProviderId;
  name: string;
  /** False for an agent that is missing or an account that is signed out. */
  usable: boolean;
  limits: RateLimit[] | undefined;
}

export type RoomState = 'room' | 'near' | 'cap' | 'unknown' | 'off';
export type SortBy = 'room' | 'reset' | 'agent';

export interface RoomRow<T extends RoomInput = RoomInput> {
  input: T;
  state: RoomState;
  /** Percent left in the tightest window that has not reset (0 to 100); undefined when nothing is known. */
  room: number | undefined;
  /** The tightest window: the one that decides how much is left. */
  tight: RateLimit | undefined;
  /** When the tightest window resets. */
  resetsAt: number | undefined;
}

export const NEAR_AT = 80;

/** A window whose reset time has passed counts as empty: the agent has not reported the new one yet. */
export const livePercent = (l: RateLimit, now: number) => (l.resetsAt && l.resetsAt <= now ? 0 : Math.max(0, Math.min(100, l.percent)));

/** The window that leaves the least room; among equals the one that resets later (it holds longer). */
export function tightest(limits: RateLimit[] | undefined, now: number): RateLimit | undefined {
  let best: RateLimit | undefined;
  for (const l of limits ?? []) {
    if (!best) best = l;
    else {
      const a = livePercent(l, now);
      const b = livePercent(best, now);
      if (a > b || (a === b && (l.resetsAt ?? 0) > (best.resetsAt ?? 0))) best = l;
    }
  }
  return best;
}

export function roomRow<T extends RoomInput>(input: T, now: number): RoomRow<T> {
  if (!input.usable) return { input, state: 'off', room: undefined, tight: undefined, resetsAt: undefined };
  const tight = tightest(input.limits, now);
  if (!tight) return { input, state: 'unknown', room: undefined, tight: undefined, resetsAt: undefined };
  const used = livePercent(tight, now);
  const state: RoomState = used >= 100 ? 'cap' : used >= NEAR_AT ? 'near' : 'room';
  return { input, state, room: Math.round(100 - used), tight, resetsAt: tight.resetsAt && tight.resetsAt > now ? tight.resetsAt : undefined };
}

const byName = (a: RoomRow, b: RoomRow) => a.input.name.localeCompare(b.input.name, undefined, { numeric: true });

/**
 * Rows in the chosen order. Ties always fall back to the name, so the order never depends on the
 * order accounts were added in.
 * - room: most room first; accounts with nothing known after those with figures.
 * - reset: the soonest reset first; windows without a reset time last.
 * - agent: as given (the agents' usual order), names within an agent.
 */
export function sortRows<T extends RoomInput>(rows: RoomRow<T>[], by: SortBy, agentOrder: ProviderId[] = []): RoomRow<T>[] {
  const out = [...rows];
  if (by === 'room') out.sort((a, b) => (b.room ?? -1) - (a.room ?? -1) || (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity) || byName(a, b));
  else if (by === 'reset') out.sort((a, b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity) || (b.room ?? -1) - (a.room ?? -1) || byName(a, b));
  else {
    const rank = (p: ProviderId) => {
      const i = agentOrder.indexOf(p);
      return i < 0 ? agentOrder.length : i;
    };
    out.sort((a, b) => rank(a.input.provider) - rank(b.input.provider) || a.input.provider.localeCompare(b.input.provider) || byName(a, b));
  }
  return out;
}

export interface Overview<T extends RoomInput = RoomInput> {
  /** Accounts with room, and those nothing is known about yet, in the chosen order. */
  open: RoomRow<T>[];
  /** At or near a cap: soonest back first when sorted by room (that is the question there). */
  tight: RoomRow<T>[];
  /** Signed out or not installed. */
  off: RoomRow<T>[];
  /** The account with the most room right now (always by room, whatever the order shown). */
  best: string | undefined;
}

export function overview<T extends RoomInput>(inputs: T[], now: number, by: SortBy, agentOrder: ProviderId[] = []): Overview<T> {
  const rows = inputs.map((i) => roomRow(i, now));
  const open = sortRows(rows.filter((r) => r.state === 'room' || r.state === 'unknown'), by, agentOrder);
  const tightRows = rows.filter((r) => r.state === 'near' || r.state === 'cap');
  const tight = by === 'room' ? sortRows(tightRows, 'room', agentOrder) : sortRows(tightRows, by, agentOrder);
  const off = sortRows(rows.filter((r) => r.state === 'off'), 'agent', agentOrder);
  const best = sortRows(rows.filter((r) => r.state === 'room'), 'room', agentOrder)[0]?.input.key;
  return { open, tight, off, best: rows.filter((r) => r.state !== 'off').length > 1 ? best : undefined };
}

/** How many accounts have room, of those that can be used at all: the compact figure for the footer. */
export function roomCount(inputs: RoomInput[], now: number): { free: number; of: number } {
  const rows = inputs.map((i) => roomRow(i, now)).filter((r) => r.state !== 'off');
  return { free: rows.filter((r) => r.state === 'room' || r.state === 'unknown').length, of: rows.length };
}
