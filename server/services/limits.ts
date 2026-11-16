import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LimitPace, LimitsMeta, LimitsReport, ProviderId, RateLimit } from '../../shared/protocol';

/**
 * Plan limits per account as last read, with when they were read and a short history of samples
 * per window, kept in one small JSON file under the Sable data dir. The history is what the view
 * draws (how a window filled up) and what the pace is computed from.
 */

type Sample = [number, number];

interface Entry extends LimitsMeta {
  limits: RateLimit[];
  readAt?: number;
  history: Record<string, Sample[]>;
}

interface BookFile {
  v: 1;
  accounts: Record<string, Entry>;
}

const HOUR = 3_600_000;
const WEEK_MINS = 10_080;
/** Samples kept per window, newest last. */
const MAX_SAMPLES = 480;
/** A sample with the same percent as the last one is kept only after this long (a flat stretch still counts for the pace). */
const SAME_GAP_MS = 5 * 60_000;

export const bookKey = (provider: ProviderId, accountId: string) => `${provider}:${accountId}`;

export class LimitsBook {
  private data: BookFile = { v: 1, accounts: {} };
  private timer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as BookFile;
      if (raw?.v === 1 && raw.accounts && typeof raw.accounts === 'object') this.data = raw;
    } catch {
      /* first run, or an unreadable file: start empty */
    }
  }

  keys(): string[] {
    return Object.keys(this.data.accounts);
  }

  /** Records a read. An empty list with `planLimits` false means the account has no plan limits. */
  record(provider: ProviderId, accountId: string, limits: RateLimit[], meta: LimitsMeta = {}, now = Date.now()): LimitsReport {
    const key = bookKey(provider, accountId);
    const prev = this.data.accounts[key];
    // An empty read without news (no session to ask, or a failed read) keeps what was known.
    if (!limits.length && meta.planLimits !== false && prev?.limits.length) return this.report(provider, accountId, now);
    const entry: Entry = { history: { ...prev?.history }, limits, readAt: now };
    for (const k of ['planLimits', 'extra', 'credits'] as const) {
      const v = meta[k] ?? prev?.[k];
      if (v !== undefined) (entry as unknown as Record<string, unknown>)[k] = v;
    }
    if (meta.planLimits === undefined && limits.length) entry.planLimits = true;
    for (const l of limits) entry.history[l.id] = addSample(entry.history[l.id] ?? [], [now, clampPct(l.percent)], l, now);
    this.data.accounts[key] = entry;
    this.save();
    return this.report(provider, accountId, now);
  }

  /** Adds samples read from elsewhere (Codex transcripts carry them), merged by time. */
  seed(provider: ProviderId, accountId: string, id: string, samples: Sample[], now = Date.now()) {
    if (!samples.length) return;
    const key = bookKey(provider, accountId);
    const entry = (this.data.accounts[key] ??= { limits: [], history: {} });
    const limit = entry.limits.find((l) => l.id === id);
    const merged = [...(entry.history[id] ?? []), ...samples].sort((a, b) => a[0] - b[0]);
    const out: Sample[] = [];
    for (const s of merged) if (!out.length || s[0] - out[out.length - 1][0] > 1000) out.push(s);
    entry.history[id] = prune(out, limit, now);
    this.save();
  }

  report(provider: ProviderId, accountId: string, now = Date.now()): LimitsReport {
    const e = this.data.accounts[bookKey(provider, accountId)];
    const report: LimitsReport = { provider, accountId, limits: e?.limits ?? [], readAt: e?.readAt, history: {}, pace: {} };
    if (!e) return report;
    if (e.planLimits !== undefined) report.planLimits = e.planLimits;
    if (e.extra) report.extra = e.extra;
    if (e.credits) report.credits = e.credits;
    for (const l of e.limits) {
      const samples = windowSamples(e.history[l.id] ?? [], l);
      report.history[l.id] = samples;
      const p = pace(l, samples, now);
      if (p) report.pace[l.id] = p;
    }
    return report;
  }

  remove(provider: ProviderId, accountId: string) {
    if (delete this.data.accounts[bookKey(provider, accountId)]) this.save();
  }

  private save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 1500);
    this.timer.unref?.();
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const text = JSON.stringify(this.data);
    this.writing = this.writing
      .then(async () => {
        mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, text, 'utf8');
        await rename(tmp, this.file);
      })
      .catch(() => {
        /* best effort: the next read writes again */
      });
    await this.writing;
  }
}

const clampPct = (p: number) => Math.max(0, Math.min(100, Number.isFinite(p) ? p : 0));

function addSample(list: Sample[], s: Sample, limit: RateLimit, now: number): Sample[] {
  const last = list[list.length - 1];
  const out = list.slice();
  if (last && last[1] === s[1] && s[0] - last[0] < SAME_GAP_MS) return prune(out, limit, now);
  if (last && s[0] <= last[0]) out[out.length - 1] = s;
  else out.push(s);
  return prune(out, limit, now);
}

/** Keeps the current window and a little before it (a week plus a day at most). */
function prune(list: Sample[], limit: RateLimit | undefined, now: number): Sample[] {
  const span = ((limit?.windowMins ?? WEEK_MINS) * 60_000) * 1.25 + 6 * HOUR;
  const cut = now - Math.min(span, (WEEK_MINS * 60_000) + 24 * HOUR);
  const kept = list.filter((s) => s[0] >= cut);
  return kept.length > MAX_SAMPLES ? kept.slice(kept.length - MAX_SAMPLES) : kept;
}

/** When the window that `limit` describes began, when its length and reset are known. */
export function windowStart(limit: RateLimit): number | undefined {
  if (!limit.resetsAt || !limit.windowMins) return undefined;
  return limit.resetsAt - limit.windowMins * 60_000;
}

/**
 * The samples of the current window: after its start (when known) and after the last drop (a
 * reset the start did not tell about).
 */
export function windowSamples(list: Sample[], limit: RateLimit): Sample[] {
  const start = windowStart(limit);
  let from = 0;
  if (start !== undefined) {
    const i = list.findIndex((s) => s[0] >= start);
    from = i < 0 ? list.length : i;
  }
  for (let i = list.length - 1; i > from; i--) {
    if (list[i][1] + 1 < list[i - 1][1]) {
      from = i;
      break;
    }
  }
  return list.slice(from);
}

/**
 * How fast `limit` fills. From the recent samples when they span long enough (the last 90 minutes
 * of a five-hour window, the last day of a weekly one), otherwise the average since the window
 * began. Nothing when the window is full, or when neither can be told yet.
 */
export function pace(limit: RateLimit, samples: Sample[], now = Date.now()): LimitPace | undefined {
  const p = clampPct(limit.percent);
  if (p >= 100) return undefined;
  const mins = limit.windowMins ?? (limit.resetsAt && limit.resetsAt - now > 6 * HOUR ? WEEK_MINS : 300);
  const weekly = mins >= 24 * 60;
  const lookback = weekly ? 24 * HOUR : Math.min(90 * 60_000, (mins * 60_000) / 3);
  const minSpan = weekly ? 2 * HOUR : 15 * 60_000;

  let perHour: number | undefined;
  let basis: LimitPace['basis'] = 'recent';
  const pts = samples.filter((s) => s[0] <= now + 60_000);
  if (pts.length >= 2) {
    const last = pts[pts.length - 1];
    // The oldest sample inside the lookback, or the one just before it as the anchor.
    let first = pts[0];
    for (const s of pts) {
      if (s[0] >= last[0] - lookback) break;
      first = s;
    }
    const span = last[0] - first[0];
    if (span >= minSpan) perHour = Math.max(0, (last[1] - first[1]) / (span / HOUR));
  }
  if (perHour === undefined) {
    const start = windowStart({ ...limit, windowMins: mins });
    if (start === undefined || now - start < minSpan) return undefined;
    perHour = p / ((now - start) / HOUR);
    basis = 'window';
  }
  perHour = Math.round(perHour * 100) / 100;
  const out: LimitPace = { perHour, basis };
  if (limit.resetsAt && limit.resetsAt > now) out.atReset = Math.min(100, Math.round(p + perHour * ((limit.resetsAt - now) / HOUR)));
  if (perHour > 0.01) {
    const fullAt = now + ((100 - p) / perHour) * HOUR;
    if (!limit.resetsAt || fullAt < limit.resetsAt) out.fullAt = Math.round(fullAt);
  }
  return out;
}
