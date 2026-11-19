/**
 * Spare: the planner (which waiting chat starts now, on which account) against made-up accounts,
 * the waits' bookkeeping against a fake host (one timer only while something waits, the parallel
 * limit, a spare turn stopped when its account goes onto credits), and the whole flow in the App
 * with the Demo agent: `/spare` held in the queue and started on the account with spare, and
 * "Continue at reset" carrying a refused turn on once its window resets.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT, type AuthState, type LimitPace, type NoticeItem, type ProviderId, type RateLimit, type SessionMeta, type SpareWait, type TimelineItem } from '@shared/protocol';
import { planSpare, planWeight, spareRoom, SpareWaits, stillFull, SPARE_RECHECK_MS, type SpareAccount, type SpareHost, type SpareItem } from '../server/core/spare';
import { SessionRuntime } from '../server/core/runtime';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import type { ProviderContext } from '../server/providers/types';
import { registerUsage } from '../server/services/usage';
import { planSize } from '../src/features/usage/plans';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const H = 3_600_000;

const week = (percent: number, resetIn = 48 * H, id = 'seven_day'): RateLimit => ({ id, label: 'Weekly · all models', percent, resetsAt: NOW + resetIn, windowMins: 10_080 });
const five = (percent: number, resetIn = 2 * H): RateLimit => ({ id: 'five_hour', label: '5-hour limit', percent, resetsAt: NOW + resetIn, windowMins: 300 });
const pace = (atReset: number): LimitPace => ({ perHour: 0.3, atReset, basis: 'recent' });

/** An account whose week is at `used` and projected to end at `end` (so `100 - end` would go unused). */
function acct(id: string, used: number, end: number, more: Partial<SpareAccount> & { resetIn?: number; five?: number } = {}): SpareAccount {
  const { resetIn, five: fiveAt, ...rest } = more;
  const limits = [five(fiveAt ?? 10), week(used, resetIn)];
  return { id, signedIn: true, planLimits: true, limits, pace: { seven_day: pace(end) }, weight: 1, ...rest };
}

let since = 0;
const item = (sessionId: string, wait: Partial<SpareWait> = {}, more: Partial<SpareItem> = {}): SpareItem => ({
  sessionId,
  provider: 'claude',
  wait: { reason: 'spare', since: wait.since ?? ++since, held: ['q'], ...wait },
  ...more,
});

const plan = (accounts: SpareAccount[], items: SpareItem[], running = 0) => planSpare({ now: NOW, accounts: { claude: accounts }, items, running });

// ─────────────────────────────────── the planner ───────────────────────────────────

describe('which account has spare', () => {
  it('counts what the pace leaves unused at the reset, within the weekly cap', () => {
    expect(spareRoom(acct('a', 30, 60), NOW)).toMatchObject({ ok: true, unused: 40 });
    // A weekly cap of 70%: only up to there is Sable's to use.
    expect(spareRoom(acct('a', 30, 60, { cap: { weekly: 70 } }), NOW)).toMatchObject({ ok: true, unused: 10 });
    expect(spareRoom(acct('a', 30, 65, { cap: { weekly: 70 } }), NOW)).toBeUndefined();
    // Too little left over (below the floor), or past the cap already.
    expect(spareRoom(acct('a', 80, 95), NOW)).toBeUndefined();
    expect(spareRoom(acct('a', 72, 72, { cap: { weekly: 70 } }), NOW)).toBeUndefined();
  });

  it('never counts an account without a pace, without plan limits, signed out or on credits', () => {
    expect(spareRoom({ ...acct('a', 10, 20), pace: {} }, NOW)).toBeUndefined();
    expect(spareRoom(acct('a', 10, 20, { planLimits: false }), NOW)).toBeUndefined();
    expect(spareRoom(acct('a', 10, 20, { signedIn: false }), NOW)).toBeUndefined();
    expect(spareRoom(acct('a', 10, 20, { onCredits: true }), NOW)).toBeUndefined();
  });

  it('holds an account whose 5-hour window is near full, until it resets', () => {
    expect(spareRoom(acct('a', 10, 30, { five: 79 }), NOW)).toMatchObject({ ok: true });
    expect(spareRoom(acct('a', 10, 30, { five: 80 }), NOW)).toEqual({ ok: false, unused: 70, score: expect.any(Number), until: NOW + 2 * H });
    // Its own 5-hour cap is lower: that one counts.
    expect(spareRoom(acct('a', 10, 30, { five: 50, cap: { session: 50 } }), NOW)).toMatchObject({ ok: false, until: NOW + 2 * H });
    // A full window (credits would carry it) holds it too; one whose reset passed does not.
    const full = { ...acct('a', 10, 30), limits: [five(100), week(10)] };
    expect(spareRoom(full, NOW)).toMatchObject({ ok: false, until: NOW + 2 * H });
    expect(spareRoom({ ...full, limits: [{ ...five(100), resetsAt: NOW - 1 }, week(10)] }, NOW)).toMatchObject({ ok: true });
  });

  it('weighs plans as the Usage page does', () => {
    const claude = (plan: string, planId?: string): AuthState => ({ loggedIn: true, method: 'claude.ai', plan, planId });
    const cases: [ProviderId, AuthState][] = [
      ['claude', claude('Ultra', 'max')],
      ['claude', claude('Team', 'team')],
      ['claude', claude('Team Standard', 'team')],
      ['claude', claude('Pro', 'pro')],
      ['claude', claude('Max', 'max')],
      ['claude', claude('Max 20x')],
      ['claude', claude('Max', 'max_20x')],
      ['claude', claude('Max', 'default_claude_max_5x')],
      ['claude', claude('max20x')],
      ['claude', { loggedIn: true, method: 'apiKey' }],
      ['codex', { loggedIn: true, method: 'chatgpt', plan: 'pro', planId: 'pro' }],
      ['demo', { loggedIn: true, method: 'local', plan: 'Max' }],
      ['demo', { loggedIn: true, method: 'local', plan: 'Pro' }],
    ];
    for (const [provider, auth] of cases) expect(planWeight(provider, auth), `${provider} ${auth.plan}`).toBe(planSize(provider, auth)?.weight ?? 1);
  });
});

describe('planning spare', () => {
  it('starts on the account whose unused quota expires soonest', () => {
    const p = plan([acct('late', 20, 50, { resetIn: 90 * H }), acct('soon', 20, 50, { resetIn: 10 * H })], [item('s1')]);
    expect(p.start).toEqual([{ sessionId: 's1', accountId: 'soon', reason: 'spare' }]);
  });

  it('weighs the unused quota by plan size', () => {
    const accounts = [acct('pro', 20, 40, { weight: 1 }), acct('ultra', 20, 70, { weight: 10 })];
    expect(plan(accounts, [item('s1')]).start[0].accountId).toBe('ultra');
  });

  it('respects caps and never starts where nothing would go unused', () => {
    const p = plan([acct('capped', 30, 50, { cap: { weekly: 55 } }), acct('busy', 70, 98)], [item('s1')]);
    expect(p.start).toEqual([]);
    expect(p.waits.s1).toEqual({});
    expect(p.wakeAt).toBe(NOW + SPARE_RECHECK_MS);
  });

  it('waits for a full 5-hour window and says when and where it may start', () => {
    const p = plan([acct('a', 10, 30, { five: 92, resetIn: 30 * H }), { ...acct('b', 10, 30), limits: [five(100, H), week(10)] }], [item('s1')]);
    expect(p.start).toEqual([]);
    expect(p.waits.s1).toEqual({ at: NOW + H, accountId: 'b' });
    // It looks again at least every half hour (the pace moves), sooner when the window resets sooner.
    expect(p.wakeAt).toBe(NOW + SPARE_RECHECK_MS);
    const soon = plan([{ ...acct('b', 10, 30), limits: [five(100, 10 * 60_000), week(10)] }], [item('s2')]);
    expect(soon.wakeAt).toBe(NOW + 10 * 60_000);
  });

  it('never uses credits: an account on credits or at a full window is passed over', () => {
    const p = plan([acct('credits', 10, 20, { onCredits: true }), { ...acct('full', 10, 20), limits: [five(100), week(10)] }, acct('ok', 40, 60)], [item('s1')]);
    expect(p.start).toEqual([{ sessionId: 's1', accountId: 'ok', reason: 'spare' }]);
  });

  it('runs at most two spare turns, one new start per account, first come first served', () => {
    const accounts = [acct('a', 10, 30), acct('b', 10, 40), acct('c', 10, 50)];
    const items = [item('late', { since: 30 }), item('first', { since: 10 }), item('second', { since: 20 })];
    const p = plan(accounts, items);
    expect(p.start).toEqual([
      { sessionId: 'first', accountId: 'a', reason: 'spare' },
      { sessionId: 'second', accountId: 'b', reason: 'spare' },
    ]);
    expect(p.waits.late).toEqual({});
    // One spare turn already runs: one more.
    expect(plan(accounts, items, 1).start.map((s) => s.sessionId)).toEqual(['first']);
    expect(plan(accounts, items, 2).start).toEqual([]);
    // One account with spare takes one start per round; a busy chat waits for its turn to end.
    expect(plan([acct('a', 10, 30)], items).start.map((s) => s.sessionId)).toEqual(['first']);
    expect(plan(accounts, [item('x', {}, { busy: true })]).start).toEqual([]);
  });

  it('starts a pinned reset at its time on its account, whatever its week', () => {
    const studio = { ...acct('studio', 99, 100), limits: [five(100, -1), week(99)] };
    const pinned = item('s1', { reason: 'reset', at: NOW + 5 * 60_000, accountId: 'studio', held: undefined });
    const before = plan([studio], [pinned]);
    expect(before.start).toEqual([]);
    expect(before.waits.s1).toEqual({ at: NOW + 5 * 60_000, accountId: 'studio' });
    expect(before.wakeAt).toBe(NOW + 5 * 60_000);
    const due = item('s1', { reason: 'reset', at: NOW - 1000, accountId: 'studio', held: undefined });
    expect(plan([studio], [due]).start).toEqual([{ sessionId: 's1', accountId: 'studio', reason: 'reset' }]);
    // Pinned starts do not wait for the parallel limit.
    expect(plan([studio], [due], 2).start).toHaveLength(1);
  });

  it('pins a reset again when the account still reads full', () => {
    const later = NOW + 3 * H;
    const studio = { ...acct('studio', 100, 100), limits: [five(40), { ...week(100), resetsAt: later }] };
    const due = item('s1', { reason: 'reset', at: NOW - 1000, accountId: 'studio', held: undefined });
    const p = plan([studio], [due]);
    expect(p.start).toEqual([]);
    expect(p.waits.s1).toEqual({ at: later, accountId: 'studio' });
    expect(stillFull(studio.limits, NOW)).toBe(later);
  });
});

// ─────────────────────────────────── the waits ───────────────────────────────────

function meta(id: string, more: Partial<SessionMeta> = {}): SessionMeta {
  return { id, provider: 'claude', cwd: '/tmp', title: 't', titleSource: 'user', model: '', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, ...more };
}

function fakeHost(accounts: SpareAccount[], sessions: SessionRuntime[]) {
  const started: { id: string; accountId: string; reason: string }[] = [];
  const stopped: string[] = [];
  const host: SpareHost = {
    now: () => NOW,
    sessions: () => sessions,
    hydrate: () => {},
    busy: (rt) => rt.turnActive,
    accounts: async () => accounts,
    refresh: async () => {},
    start: async (rt, accountId, wait) => {
      started.push({ id: rt.id, accountId, reason: wait.reason });
      if (wait.reason === 'spare') rt.takeQueued(wait.held![0]);
      rt.beginTurn();
    },
    send: async () => {},
    stop: async (rt) => void stopped.push(rt.id),
    accountLabel: (_p, id) => id,
    log: () => {},
  };
  return { host, started, stopped };
}

describe('the waits', () => {
  it('keeps no timer while nothing waits, one while something does', async () => {
    const rt = new SessionRuntime(meta('s1'), () => {}, () => {});
    const { host, started } = fakeHost([acct('a', 80, 98)], [rt]);
    const waits = new SpareWaits(host);
    await waits.run();
    expect(waits.armed).toBe(false);
    waits.hold(rt, 'later please');
    await waits.run();
    expect(started).toEqual([]);
    expect(waits.armed).toBe(true);
    expect(rt.queue.map((q) => q.text)).toEqual(['later please']);
    waits.cancel(rt);
    await waits.run();
    expect(waits.armed).toBe(false);
    // Cancelled: the message stays in the queue, no longer held.
    expect(rt.queue).toHaveLength(1);
    expect(waits.held(rt).size).toBe(0);
    waits.dispose();
  });

  it('starts at most two at once and counts a spare turn until it ends', async () => {
    const rts = ['s1', 's2', 's3'].map((id) => new SessionRuntime(meta(id), () => {}, () => {}));
    const { host, started } = fakeHost([acct('a', 10, 30), acct('b', 10, 40), acct('c', 10, 50)], rts);
    const waits = new SpareWaits(host);
    for (const rt of rts) waits.hold(rt, `task ${rt.id}`);
    await waits.run();
    expect(started.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(rts[0].meta.spare).toBeNull();
    expect(rts[2].meta.spare).toMatchObject({ reason: 'spare' });
    rts[0].turnActive = false;
    waits.turnEnded(rts[0]);
    await waits.run();
    expect(started.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    waits.dispose();
  });

  it('stops a spare turn whose account went onto credits, and lets go of a message sent by hand', async () => {
    const rt = new SessionRuntime(meta('s1'), () => {}, () => {});
    const other = new SessionRuntime(meta('s2'), () => {}, () => {});
    const { host, stopped } = fakeHost([acct('a', 10, 30)], [rt, other]);
    const waits = new SpareWaits(host);
    waits.hold(rt, 'go');
    await waits.run();
    expect(waits.running.has('s1')).toBe(true);
    waits.limitsChanged('claude', DEFAULT_ACCOUNT, true);
    waits.limitsChanged('claude', 'a', true);
    expect(stopped).toEqual(['s1']);

    const q = waits.hold(other, 'held');
    expect(q.held).toHaveLength(1);
    other.takeQueued(q.held![0]);
    waits.queueChanged(other);
    expect(other.meta.spare).toBeNull();
    waits.dispose();
  });

  it('ends a wait for the reset when the person carries on by hand', () => {
    const rt = new SessionRuntime(meta('s1'), () => {}, () => {});
    rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'limit', limit: { provider: 'claude', accountId: 'a', resetsAt: NOW + H, window: '5-hour limit' } });
    const { host } = fakeHost([], [rt]);
    const waits = new SpareWaits(host);
    rt.onTurnStart = (r) => waits.turnStarted(r);
    expect(waits.atReset(rt)).toMatchObject({ ok: true, spare: { reason: 'reset', at: NOW + H, accountId: 'a' } });
    rt.beginTurn();
    expect(rt.meta.spare).toBeNull();
    // Nothing to wait for without a limit notice.
    const bare = new SessionRuntime(meta('s2'), () => {}, () => {});
    expect(waits.atReset(bare)).toMatchObject({ ok: false });
    waits.dispose();
  });
});

// ─────────────────────────────────── in the App ───────────────────────────────────

const temps: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (name: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  temps.push(dir);
  return dir;
};

async function until(pred: () => boolean, what: string, ms = 6000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The Demo, with fixed plan limits for the accounts named in `fixed` (by account id; `default` for the built-in one). */
class FixedDemo extends DemoProvider {
  static fixed = new Map<string, RateLimit[]>();
  constructor(private c: ProviderContext) {
    super(c, { speed: 0 });
  }
  async limits(): Promise<RateLimit[]> {
    const own = FixedDemo.fixed.get(this.c.account?.id ?? DEFAULT_ACCOUNT);
    if (!own) return super.limits();
    this.c.emit({ type: 'limits.updated', provider: 'demo', limits: own, meta: { planLimits: true } });
    return own;
  }
}

function startApp() {
  const home = temp('sable-spare-');
  const app = new App({ home, providers: [(ctx) => new FixedDemo(ctx)], quiet: true, userHome: temp('sable-spare-user-') });
  registerUsage(app, { sources: () => [] });
  apps.push(app);
  return { app, home };
}

async function demoAccount(app: App, label: string, profile: 'cap' | 'light' | 'calm') {
  const { account } = await app.call('account.add', { provider: 'demo', label });
  writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ email: `${label.toLowerCase()}@example.dev`, plan: 'Max', limits: profile }));
  await app.call('auth.refresh', { provider: 'demo', accountId: account.id });
  return account;
}

const texts = (items: TimelineItem[]) => items.filter((i) => i.type === 'text');
const weekIn = (percent: number, hours: number): RateLimit => ({ id: 'seven_day', label: 'Weekly · all models', percent, resetsAt: Date.now() + hours * H, windowMins: 10_080 });
const fiveIn = (percent: number): RateLimit => ({ id: 'five_hour', label: '5-hour limit', percent, resetsAt: Date.now() + 2 * H, windowMins: 300 });

describe('Spare in the App', () => {
  it('holds a /spare message in the queue and starts it on the account whose week has spare', { timeout: 15_000 }, async () => {
    FixedDemo.fixed.clear();
    FixedDemo.fixed.set(DEFAULT_ACCOUNT, [fiveIn(20), weekIn(96, 30)]);
    const { app, home } = startApp();
    await app.call('provider.limits', { provider: 'demo' });
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), mode: 'bypassPermissions' });
    const rt = app.runtime(snap.session.id);
    await until(() => rt.meta.status === 'idle', 'session open');

    const res = await app.call('spare.send', { sessionId: rt.id, text: 'hello there friend' });
    expect(res).toMatchObject({ ok: true, spare: { reason: 'spare' } });
    expect(rt.meta.title).toBe('hello there friend');
    expect(rt.queue.map((q) => q.text)).toEqual(['hello there friend']);
    // A turn of its own (a normal message) ends without taking the held message.
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => texts(rt.items).length === 1 && rt.meta.status === 'idle', 'normal turn');
    await new Promise((r) => setTimeout(r, 60));
    expect(rt.queue).toHaveLength(1);
    expect(rt.meta.spare).toMatchObject({ reason: 'spare' });

    // An account whose week will go mostly unused arrives: the chat moves there and starts.
    const work = await demoAccount(app, 'Work', 'light');
    FixedDemo.fixed.set(work.id, [fiveIn(10), weekIn(20, 30)]);
    await app.call('provider.limits', { provider: 'demo', accountId: work.id });
    await until(() => rt.meta.accountId === work.id && texts(rt.items).length >= 2 && rt.meta.status === 'idle', 'spare start');
    expect(rt.meta.spare).toBeNull();
    expect(rt.queue).toHaveLength(0);
    expect(rt.items.some((i) => i.type === 'notice' && i.text === 'Started with Work')).toBe(true);
  });

  it('continues a refused turn on the same account once its window resets', { timeout: 15_000 }, async () => {
    FixedDemo.fixed.clear();
    // The built-in account is used up too: nothing else can take the turn.
    FixedDemo.fixed.set(DEFAULT_ACCOUNT, [fiveIn(100), weekIn(100, 30)]);
    const { app, home } = startApp();
    await app.call('provider.limits', { provider: 'demo' });
    const studio = await demoAccount(app, 'Studio', 'cap');
    await app.call('demo.limitResetIn', { accountId: studio.id, ms: 400 });
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: studio.id });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => rt.items.some((i) => i.type === 'notice' && !!i.limit?.provider), 'limit notice');
    const hit = rt.items.find((i): i is NoticeItem => i.type === 'notice' && !!i.limit)!;
    expect(hit.limit!.next).toBeUndefined();

    const res = await app.call('spare.atReset', { sessionId: rt.id });
    expect(res).toMatchObject({ ok: true, spare: { reason: 'reset', accountId: studio.id } });
    expect(rt.meta.spare?.at).toBe(hit.limit!.resetsAt);
    await until(() => texts(rt.items).length === 1 && rt.meta.status === 'idle', 'continued at reset', 8000);
    expect(rt.meta.spare).toBeNull();
    expect(rt.meta.accountId).toBe(studio.id);
    expect(rt.get<NoticeItem>(hit.id)!.limit).toMatchObject({ continuedWith: studio.id, atReset: true });
    // The refused message went out again: no second copy in the conversation.
    expect(rt.items.filter((i) => i.type === 'user')).toHaveLength(1);
  });

  it('cancels, or starts now as an ordinary send', { timeout: 10_000 }, async () => {
    FixedDemo.fixed.clear();
    FixedDemo.fixed.set(DEFAULT_ACCOUNT, [fiveIn(20), weekIn(96, 30)]);
    const { app, home } = startApp();
    await app.call('provider.limits', { provider: 'demo' });
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p') });
    const rt = app.runtime(snap.session.id);
    await app.call('spare.send', { sessionId: rt.id, text: 'hey one' });
    expect(await app.call('spare.cancel', { sessionId: rt.id })).toEqual({ ok: true });
    expect(rt.meta.spare).toBeNull();
    expect(rt.queue).toHaveLength(1);
    await app.call('queue.remove', { sessionId: rt.id, id: rt.queue[0].id });

    await app.call('spare.send', { sessionId: rt.id, text: 'hey two' });
    expect(await app.call('spare.startNow', { sessionId: rt.id })).toEqual({ ok: true });
    await until(() => texts(rt.items).length === 1 && rt.meta.status === 'idle', 'started now');
    expect(rt.meta.spare).toBeNull();
    expect(rt.queue).toHaveLength(0);
    expect(await app.call('spare.send', { sessionId: rt.id, text: '  ' })).toMatchObject({ ok: false });
  });
});
