import type { AuthState, RateLimit } from '@shared/protocol';
import { planLabel } from '@/features/connect/plan';

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** "03:40" today, "Tue 03:40" on another day this week, "17 Nov, 09:00" later. */
export function clock(ts: number, now = Date.now()): string {
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay(ts, now)) return time;
  if (Math.abs(ts - now) < 6 * 86_400_000) return `${new Date(ts).toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

/** The full date and time, for tooltips: "Monday 17 November, 09:00". */
export function exactTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** "2h 14m", "38m", "3d 4h", "under a minute". */
export function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Day labels for the chart: "Mon", "Nov 3", "Today". */
export function dayLabel(day: string, style: 'weekday' | 'date' | 'long', today: string): string {
  if (day === today && style !== 'long') return 'Today';
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12);
  if (style === 'weekday') return date.toLocaleDateString([], { weekday: 'short' });
  if (style === 'date') return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Amber near a cap, red at it; nothing otherwise (the only colours a limit may use). */
export function windowLevel(l: RateLimit, now = Date.now()): 'amber' | 'red' | undefined {
  if (l.resetsAt && l.resetsAt <= now) return undefined;
  if (l.percent >= 100) return 'red';
  if (l.percent >= 80) return 'amber';
  return undefined;
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
