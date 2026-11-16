/** The Usage view's sums: days, groups with "Other", ranked lists, axis scale and compact figures. */
import { describe, expect, it } from 'vitest';
import type { UsageReport, UsageRow } from '@shared/protocol';
import { compact, dayKey, dayKeys, niceScale, summarize, type Namers } from '../src/features/usage/aggregate';

const NOW = new Date(2026, 10, 16, 15, 0).getTime();
const DAY = 86_400_000;
const names: Namers = { model: (id) => id.toUpperCase(), account: (p, a) => `${p}/${a}`, paysPerToken: (p, a) => p === 'claude' && a === 'default' };

function row(daysAgo: number, session: string, model: string, output: number, extra: Partial<UsageRow> = {}): UsageRow {
  return { day: dayKey(NOW - daysAgo * DAY), session, model, input: 0, output, cacheRead: 0, cacheWrite: 0, replies: 1, ...extra };
}

const report: UsageReport = {
  days: 30,
  scanning: false,
  files: 3,
  rows: [
    row(0, 'claude:a', 'm1', 100, { costUsd: 1.5 }),
    row(0, 'claude:b', 'm2', 50),
    row(1, 'claude:a', 'm3', 30),
    row(2, 'codex:c', 'm4', 20),
    row(3, 'codex:c', 'm5', 10),
    row(20, 'codex:c', 'm1', 1000),
  ],
  sessions: {
    'claude:a': { provider: 'claude', accountId: 'default', project: '/w/alpha', title: 'A', lastAt: NOW },
    'claude:b': { provider: 'claude', accountId: 'work', project: '/w/beta', title: 'B', lastAt: NOW },
    'codex:c': { provider: 'codex', accountId: 'default', project: '/w/alpha', lastAt: NOW },
  },
};

describe('usage summary', () => {
  it('sums days in range, today, groups with Other, ranked lists and cost', () => {
    const s = summarize(report, 7, 'model', names, NOW);
    expect(s.days).toHaveLength(7);
    expect(s.days[6]).toBe(dayKey(NOW));
    expect(s.total).toBe(210);
    expect(s.today).toBe(150);
    expect(s.costUsd).toBe(1.5);
    // Five models in range: the top three get their own tone, the rest is "Other".
    expect(s.groups.map((g) => g.label)).toEqual(['M1', 'M2', 'M3', 'Other']);
    expect(s.groups[3].total).toBe(30);
    expect(s.bars[6].parts).toEqual([100, 50, 0, 0]);
    expect(s.bars[3].parts).toEqual([0, 0, 0, 10]);
    expect(s.projects.map((p) => [p.label, p.total])).toEqual([
      ['/w/alpha', 160],
      ['/w/beta', 50],
    ]);
    expect(s.accounts.map((a) => a.label)).toEqual(['claude/default', 'claude/work', 'codex/default']);
    expect(s.sessions.map((x) => [x.key, x.label, x.total])).toEqual([
      ['claude:a', 'A', 130],
      ['claude:b', 'B', 50],
      ['codex:c', 'Untitled session', 30],
    ]);
  });

  it('leaves cache reads out of every total and shows cost only where it is money paid', () => {
    const r: UsageReport = {
      ...report,
      rows: [row(0, 'claude:a', 'm1', 10, { input: 5, cacheWrite: 3, cacheRead: 1000, costUsd: 2 }), row(0, 'claude:b', 'm1', 10, { cacheRead: 500, costUsd: 9 })],
    };
    const s = summarize(r, 7, 'model', names, NOW);
    expect(s.total).toBe(28);
    expect(s.today).toBe(28);
    expect(s.tokens.cacheRead).toBe(1500);
    expect(s.models[0].total).toBe(28);
    // claude:b is on a plan: its reported cost is an estimate and is left out.
    expect(s.costUsd).toBe(2);
    expect(summarize(r, 7, 'model', { ...names, paysPerToken: undefined }, NOW).costUsd).toBeUndefined();
  });

  it('keeps every group when there are only a few, and the longer range picks up older days', () => {
    const s = summarize(report, 30, 'project', names, NOW);
    expect(s.groups.map((g) => g.label)).toEqual(['/w/alpha', '/w/beta']);
    expect(s.total).toBe(1210);
  });

  it('lists the days ending today', () => {
    const d = dayKeys(3, NOW);
    expect(d).toEqual([dayKey(NOW - 2 * DAY), dayKey(NOW - DAY), dayKey(NOW)]);
  });
});

describe('figures', () => {
  it('scales an axis to round steps', () => {
    expect(niceScale(0)).toEqual({ top: 1, step: 1 });
    expect(niceScale(930)).toEqual({ top: 1000, step: 500 });
    expect(niceScale(12_400_000).top).toBe(15_000_000);
  });

  it('writes compact token counts', () => {
    expect(compact(312)).toBe('312');
    expect(compact(4_210)).toBe('4.2k');
    expect(compact(860_400)).toBe('860k');
    expect(compact(1_240_000)).toBe('1.24M');
    expect(compact(48_300_000)).toBe('48.3M');
    expect(compact(2_100_000_000)).toBe('2.10B');
  });
});

describe('limit level', () => {
  it('is near at 80%, at the cap at 100%, and nothing once a full window has reset', async () => {
    // The hooks module brings the UI store, which expects a browser.
    const g = globalThis as Record<string, unknown>;
    g.window ??= globalThis;
    g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    g.document ??= { hidden: false };
    const { limitLevel } = await import('../src/state/hooks');
    const now = Date.now();
    expect(limitLevel([{ id: 'a', label: 'a', percent: 40 }], now)).toBeUndefined();
    expect(limitLevel([{ id: 'a', label: 'a', percent: 82 }], now)).toBe('near');
    expect(limitLevel([{ id: 'a', label: 'a', percent: 82 }, { id: 'b', label: 'b', percent: 100, resetsAt: now + 1000 }], now)).toBe('cap');
    expect(limitLevel([{ id: 'b', label: 'b', percent: 100, resetsAt: now - 1000 }], now)).toBeUndefined();
  });
});
