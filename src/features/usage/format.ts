import type { AuthState, LimitPace, RateLimit } from '@shared/protocol';
import { planLabel } from '@/features/connect/plan';
import { livePercent } from './room';

/**
 * Dates read in the interface's language (English day and month names), with the computer's own
 * clock style (24-hour or not): a German system must not put "Sa" or "Do., 12. Nov." into English copy.
 */
export const DATE_LOCALE = 'en-GB';
const HOUR12 = (() => {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 ?? false;
  } catch {
    return false;
  }
})();
const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: HOUR12 };
export const timeOf = (ts: number) => new Date(ts).toLocaleTimeString(DATE_LOCALE, TIME);
/** Numbers in the interface's language: "43,106.95". */
export const NUMBER_LOCALE = 'en-US';

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** "03:40" today, "Tue 03:40" on another day this week, "17 Nov, 09:00" later. */
export function clock(ts: number, now = Date.now()): string {
  const time = timeOf(ts);
  if (sameDay(ts, now)) return time;
  if (Math.abs(ts - now) < 6 * 86_400_000) return `${new Date(ts).toLocaleDateString(DATE_LOCALE, { weekday: 'short' })} ${time}`;
  return `${new Date(ts).toLocaleDateString(DATE_LOCALE, { day: 'numeric', month: 'short' })}, ${time}`;
}

/** The full date and time, for tooltips: "Monday 17 November, 09:00". */
export function exactTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString(DATE_LOCALE, { weekday: 'long', day: 'numeric', month: 'long' })}, ${timeOf(ts)}`;
}

/** "2h 14m", "38m", "3d 4h", "<1m": short enough for the reset column. */
export function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Day labels for the chart: "Mon", "3 Nov", "Today". */
export function dayLabel(day: string, style: 'weekday' | 'date' | 'long', today: string): string {
  if (day === today && style !== 'long') return 'Today';
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12);
  if (style === 'weekday') return date.toLocaleDateString(DATE_LOCALE, { weekday: 'short' });
  if (style === 'date') return date.toLocaleDateString(DATE_LOCALE, { month: 'short', day: 'numeric' });
  return date.toLocaleDateString(DATE_LOCALE, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Amber near a cap, red at it; nothing otherwise (the only colours a limit may use). */
export function windowLevel(l: RateLimit, now = Date.now()): 'amber' | 'red' | undefined {
  if (l.resetsAt && l.resetsAt <= now) return undefined;
  if (l.percent >= 100) return 'red';
  if (l.percent >= 80) return 'amber';
  return undefined;
}

/** A window that one model, or one part of the plan, has (Opus, Fable, a Codex model's own limit). */
export const isScopedWindow = (l: RateLimit) => /^model_|^(five_hour|seven_day)_/.test(l.id) || (l.id.includes(':') && !l.id.startsWith('codex:'));

/** The 5-hour window first, then the week of the whole plan, then the week of each model; as given otherwise. */
export function orderWindows(limits: RateLimit[]): RateLimit[] {
  const rank = (l: RateLimit) => ((l.windowMins ?? 0) >= 1440 ? 2 : 0) + (isScopedWindow(l) ? 1 : 0);
  return limits
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i)
    .map((x) => x.l);
}

/** The plan to show next to an account: the agent's own name for it, or the Demo's. */
export function planText(auth: AuthState | undefined): string | undefined {
  return planLabel(auth) ?? (auth?.loggedIn && auth.method === 'local' ? auth.plan : undefined);
}

/** An account whose sign-in is an API key (or a console org) has no plan limits. */
export function isApiKey(auth: AuthState | undefined): boolean {
  return planLabel(auth) === 'API key';
}

/** Limits older than this read as "as of 14:02". */
export const STALE_MS = 15 * 60_000;

/** "$0.42", "$12.40", "$3,584": cents only while they matter. */
export function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: usd >= 100 ? 0 : 2, minimumFractionDigits: usd >= 100 ? 0 : 2 });
}

/** One sentence about where the pace leads, or nothing. */
export function paceText(l: RateLimit, p: LimitPace | undefined, now: number): { text: string; warn: boolean } | undefined {
  if (!p || l.percent >= 100 || (l.resetsAt && l.resetsAt <= now)) return undefined;
  if (p.fullAt) return { text: `On pace to run out at ${clock(p.fullAt, now)}`, warn: true };
  if (p.perHour <= 0.01) return l.resetsAt ? { text: 'Steady until the reset', warn: false } : undefined;
  if (p.atReset !== undefined) return { text: `On pace for ${p.atReset}% at the reset`, warn: false };
  return undefined;
}

/**
 * The quiet line under a window: where the pace leads, a reset that has passed (the agent has not
 * reported the new window yet), or a window that has not started (no reset time, nothing used).
 */
export function windowNote(l: RateLimit, p: LimitPace | undefined, now: number): { text: string; warn: boolean } | undefined {
  const pace = paceText(l, p, now);
  if (pace) return pace;
  if (l.resetsAt && l.resetsAt <= now) return { text: `Reset at ${clock(l.resetsAt, now)}`, warn: false };
  if (!l.resetsAt && Math.round(livePercent(l, now)) === 0) return { text: 'Starts with your next message', warn: false };
  return undefined;
}
