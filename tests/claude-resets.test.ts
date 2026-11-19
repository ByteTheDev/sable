/**
 * Claude's limit resets and usage credits, as Claude Code's usage answer carries them
 * (`rate_limits.cedar_ember`, `juniper_tide`, `spend`; see scratch/overnight2/RESETS.md). Every
 * answer here is made up: no usage read and no reset ever reaches a real account.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type BridgeEvent, type LimitsMeta, type RateLimit } from '@shared/protocol';
import { ClaudeProvider, claudeResets, claudeSpend } from '../server/providers/claude';
import { LimitsBook } from '../server/services/limits';
import { offersText, untilText } from '../src/features/usage/LimitReset';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const limits: RateLimit[] = [
  { id: 'five_hour', label: '5-hour limit', percent: 17, windowMins: 300 },
  { id: 'seven_day', label: 'Weekly · all models', percent: 19, windowMins: 10_080 },
  { id: 'model_Fable', label: 'Weekly · Fable', percent: 100, windowMins: 10_080 },
];

const grant = (o: object) => ({ id: 'g1', label: 'Full reset', resets_total: 1, resets_left: 1, ends_at: '2026-12-10T22:00:00Z', clears: ['five_hour', 'seven_day', 'seven_day_overage_included'], paused: false, usable_now: true, use_requires_limit: false, type: 'full', ...o });

describe('Claude limit resets', () => {
  it('reads granted resets the way Claude Code does: kind, uses left, end date, the windows they clear', () => {
    const r = claudeResets({ cedar_ember: { eligible: true, grants: [grant({})] } }, limits, NOW)!;
    expect(r.available).toBe(1);
    expect(r.spendable).toBe(false);
    expect(r.windows).toEqual(['five_hour', 'seven_day', 'model_Fable']);
    expect(r.offers).toEqual([{ kind: 'full', label: 'Full reset', left: 1, total: 1, expiresAt: Date.parse('2026-12-10T22:00:00Z'), windows: ['five_hour', 'seven_day', 'model_Fable'] }]);
  });

  it('says nothing when the answer has them as null (the plain read): that is no claim about the account', () => {
    expect(claudeResets({ cedar_ember: null, juniper_tide: null }, limits, NOW)).toBeUndefined();
    expect(claudeResets({ five_hour: null }, limits, NOW)).toBeUndefined();
  });

  it('drops grants used up, ended or malformed; a paused one is listed but not counted', () => {
    const r = claudeResets(
      {
        cedar_ember: {
          eligible: true,
          grants: [grant({ id: 'a', resets_left: 0 }), grant({ id: 'b', ends_at: '2026-11-01T00:00:00Z' }), { id: 'c', resets_left: 'x' }, grant({ id: 'd', type: 'weekly', clears: ['seven_day'], paused: true }), grant({ id: 'e', type: undefined, clears: ['five_hour'], resets_left: 2, resets_total: 3 })],
        },
      },
      limits,
      NOW,
    )!;
    expect(r.offers?.map((o) => [o.kind, o.left, !!o.paused])).toEqual([
      ['weekly', 1, true],
      ['session', 2, false],
    ]);
    expect(r.available).toBe(2);
    expect(r.windows).toEqual(['five_hour']);
  });

  it('an account that is not eligible has none (said, so stale offers go)', () => {
    expect(claudeResets({ cedar_ember: { eligible: false, ineligible_reason: 'tier' } }, limits, NOW)).toEqual({ available: 0, windows: [], offers: [], spendable: false });
  });

  it('the weekly 5-hour reset counts when it is offered', () => {
    const r = claudeResets({ juniper_tide: { eligible: true, arm: 'reset', available: true } }, limits, NOW)!;
    expect(r.offers).toEqual([{ kind: 'session', left: 1, windows: ['five_hour'], atLimitOnly: true }]);
    expect(claudeResets({ juniper_tide: { eligible: true, arm: 'control', available: true } }, limits, NOW)!.available).toBe(0);
  });

  it('the provider passes them on with the limits read, and has no way to spend one', async () => {
    const events: BridgeEvent[] = [];
    const p = new ClaudeProvider({ emit: (e) => events.push(e), log: () => {}, settings: () => DEFAULT_SETTINGS });
    const q = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 17, resets_at: '2026-11-19T22:40:00Z' }, seven_day: { utilization: 19, resets_at: '2026-11-25T14:00:00Z' }, model_scoped: [], cedar_ember: { eligible: true, grants: [grant({ ends_at: '2099-12-10T22:00:00Z' })] } },
      }),
    };
    await (p as unknown as { readLimitsNow: (q: unknown) => Promise<RateLimit[]> }).readLimitsNow(q);
    const meta = events.find((e): e is Extract<BridgeEvent, { type: 'limits.updated' }> => e.type === 'limits.updated')?.meta;
    expect(meta?.resets?.available).toBe(1);
    expect(meta?.resets?.spendable).toBe(false);
    expect((p as unknown as { useReset?: unknown }).useReset).toBeUndefined();
  });

  it('the limits book keeps the offers with the count', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sable-resets-'));
    try {
      const book = new LimitsBook(path.join(dir, 'limits.json'));
      const resets = claudeResets({ cedar_ember: { eligible: true, grants: [grant({ ends_at: '2099-01-01T00:00:00Z' })] } }, limits, NOW);
      const r = book.record('claude', 'default', limits, { resets } as LimitsMeta, NOW);
      expect(r.resets?.offers?.[0].kind).toBe('full');
      // A later plain read (no resets in it) keeps what was known.
      expect(book.record('claude', 'default', limits, {}, NOW + 1000).resets?.available).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Claude usage credits', () => {
  it('reads the spend block in cents, with the balance left', () => {
    expect(claudeSpend({ used: { amount_minor: 1240, currency: 'EUR', exponent: 2 }, limit: { amount_minor: 5000, currency: 'EUR', exponent: 2 }, balance: { amount_minor: 3760, currency: 'EUR', exponent: 2 }, percent: 24.8, enabled: true })).toEqual({
      enabled: true,
      used: 1240,
      limit: 5000,
      balance: 3760,
      percent: 25,
      currency: 'EUR',
    });
    // Other exponents become hundredths too; nulls stay out.
    expect(claudeSpend({ used: { amount_minor: 12345, currency: 'JPY', exponent: 0 }, limit: null, balance: null, enabled: false })).toEqual({ enabled: false, used: 1234500, currency: 'JPY' });
    expect(claudeSpend(null)).toBeUndefined();
  });

  it('the provider fills extra usage from it and keeps extra_usage first', async () => {
    const events: BridgeEvent[] = [];
    const p = new ClaudeProvider({ emit: (e) => events.push(e), log: () => {}, settings: () => DEFAULT_SETTINGS });
    const q = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          seven_day: { utilization: 19, resets_at: '2026-11-25T14:00:00Z' },
          model_scoped: [],
          extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1000, utilization: 20, currency: 'USD' },
          spend: { used: { amount_minor: 1000, currency: 'USD', exponent: 2 }, limit: { amount_minor: 5000, currency: 'USD', exponent: 2 }, balance: { amount_minor: 2500, currency: 'USD', exponent: 2 }, percent: 20, enabled: true },
          cedar_ember: null,
        },
      }),
    };
    await (p as unknown as { readLimitsNow: (q: unknown) => Promise<RateLimit[]> }).readLimitsNow(q);
    const meta = events.find((e): e is Extract<BridgeEvent, { type: 'limits.updated' }> => e.type === 'limits.updated')?.meta;
    expect(meta?.extra).toMatchObject({ enabled: true, limit: 5000, used: 1000, percent: 20, balance: 2500, currency: 'USD' });
    expect(meta?.resets).toBeUndefined();
  });
});

describe('Reset offers in words', () => {
  it('names each kind with its uses left and when it ends', () => {
    const now = Date.parse('2026-11-19T12:00:00');
    const at = Date.parse('2026-12-10T23:00:00');
    expect(untilText(at, now)).toBe('until 10 Dec');
    expect(untilText(Date.parse('2027-01-03T10:00:00'), now)).toBe('until 3 Jan 2027');
    expect(offersText({ available: 1, windows: [], offers: [{ kind: 'full', left: 1, expiresAt: at, windows: [] }], spendable: false }, now)).toBe('1 full reset, until 10 Dec');
    expect(
      offersText(
        {
          available: 4,
          windows: [],
          offers: [
            { kind: 'session', left: 2, windows: [] },
            { kind: 'weekly', left: 1, expiresAt: at, windows: [] },
            { left: 1, expiresAt: at + 1, windows: [] },
          ],
        },
        now,
      ),
    ).toBe('1 weekly reset, until 10 Dec · 1 reset, until 10 Dec · 2 more');
    // Codex says only how many.
    expect(offersText({ available: 2, windows: ['codex:primary'] }, now)).toBe('2 resets');
    // Offers that ended fall back to the count.
    expect(offersText({ available: 1, windows: [], offers: [{ kind: 'full', left: 1, expiresAt: now - 1, windows: [] }] }, now)).toBe('1 reset');
  });
});
