/**
 * "Use up to" per account: past its cap a session moves, between turns, to the next account of its
 * agent under its own cap, carrying the conversation, with one line in the chat. Demo accounts with
 * made-up limits in temporary folders; nothing touches a real profile.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT, type NoticeItem, type RateLimit, type TimelineItem } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { capPercent, capReached, capReason, isAllModelsWeekly, isSessionWindow, windowModel } from '../server/core/limit-policy';
import { pickNextAccount } from '../server/accounts/folders';

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

async function until(pred: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function start(speed = 0) {
  const home = temp('sable-caps-');
  const app = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed })], quiet: true, userHome: temp('sable-user-') });
  apps.push(app);
  return { app, home };
}

type Profile = 'calm' | 'cap' | 'near' | 'light';

/** An extra demo account signed in with plan limits in `profile` (near: weekly 74%, light: 22%, calm: 61%). */
async function demoAccount(app: App, label: string, profile: Profile, plan = 'Max') {
  const { account } = await app.call('account.add', { provider: 'demo', label });
  writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ email: `${label.toLowerCase()}@example.dev`, plan, limits: profile }));
  await app.call('auth.refresh', { provider: 'demo', accountId: account.id });
  await app.call('provider.limits', { provider: 'demo', accountId: account.id });
  return account;
}

/** Changes how a demo account's limits stand and lets the bridge read them (as the ticker would). */
async function setProfile(app: App, account: { id: string; dir?: string }, label: string, profile: Profile) {
  writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ email: `${label.toLowerCase()}@example.dev`, plan: 'Max', limits: profile }));
  await app.call('provider.limits', { provider: 'demo', accountId: account.id });
}

const caps = (app: App, map: Record<string, { weekly?: number; session?: number }>) =>
  app.call('app.setSettings', { patch: { accountCaps: Object.fromEntries(Object.entries(map).map(([id, c]) => [`demo:${id}`, c])) } });

const notices = (items: TimelineItem[]) => items.filter((i): i is NoticeItem => i.type === 'notice');
const answered = (items: TimelineItem[]) => items.some((i) => i.type === 'text');

describe('caps: the windows they compare', () => {
  const now = 1_000_000;
  const w = (id: string, percent: number, windowMins = 10_080, label = id): RateLimit => ({ id, label, percent, resetsAt: now + 3_600_000, windowMins });

  it('reads the all-models weekly and the 5-hour window, never a per-model one', () => {
    expect(isAllModelsWeekly(w('seven_day', 1))).toBe(true);
    expect(isAllModelsWeekly(w('seven_day_opus', 1))).toBe(false);
    expect(isAllModelsWeekly(w('model_Fable', 1))).toBe(false);
    expect(isAllModelsWeekly(w('codex:secondary', 1))).toBe(true);
    expect(isSessionWindow(w('five_hour', 1, 300))).toBe(true);
    expect(isSessionWindow(w('codex:primary', 1, 300))).toBe(true);
    expect(windowModel(w('model_Fable', 1))).toBe('fable');
    expect(windowModel(w('seven_day_opus', 1))).toBe('opus');
    expect(windowModel(w('seven_day_overage_included', 1))).toBeUndefined();
    expect(capPercent(undefined)).toBe(100);
    expect(capPercent(95)).toBe(95);
    expect(capPercent(0)).toBe(100);
  });

  it('is reached by the weekly or the 5-hour cap, and by a full window only for its own model', () => {
    const limits = [w('five_hour', 40, 300, '5-hour limit'), w('seven_day', 95, 10_080, 'Weekly · all models'), w('model_Fable', 100, 10_080, 'Weekly · Fable')];
    expect(capReached(limits, { weekly: 95 }, 'opus', now)).toMatchObject({ kind: 'weekly', cap: 95 });
    expect(capReached(limits, { weekly: 96 }, 'opus', now)).toBeUndefined();
    expect(capReached(limits, { weekly: 96, session: 40 }, 'opus', now)).toMatchObject({ kind: 'session', cap: 40 });
    // Fable's own weekly is used up: it matters for a Fable session only.
    expect(capReached(limits, { weekly: 96 }, 'fable', now)).toMatchObject({ kind: 'model', label: 'Weekly · Fable' });
    // No cap: nothing is reached here (the limit itself is the agent's to refuse).
    expect(capReached(limits, undefined, 'fable', now)).toBeUndefined();
    expect(capReached(limits, { weekly: 100 }, 'fable', now)).toBeUndefined();
    // A window that has reset is not counted.
    expect(capReached([{ ...limits[1], resetsAt: now - 1 }], { weekly: 50 }, undefined, now)).toBeUndefined();
    expect(capReason('Ultra1', { kind: 'weekly', cap: 95, percent: 95, label: '' })).toBe('Ultra1 reached its 95% cap');
    expect(capReason('Ultra1', { kind: 'session', cap: 80, percent: 81, label: '' })).toBe('Ultra1 reached its 80% 5-hour cap');
  });

  it('picks an account under its own cap, the same plan first, and ignores other models’ full windows', () => {
    const lim = (weekly: number, fable = 0): RateLimit[] => [w('seven_day', weekly), w('model_Fable', fable)];
    const accounts = [
      { id: 'u1', signedIn: true, plan: 'Ultra', limits: lim(96) },
      { id: 'u2', signedIn: true, plan: 'Ultra', limits: lim(60), cap: { weekly: 50 } },
      { id: 'u3', signedIn: true, plan: 'Ultra', limits: lim(40, 100) },
      { id: 'm1', signedIn: true, plan: 'Max', limits: lim(5) },
    ];
    // u2 is past its own cap; u3's Fable window is full but the session runs Opus; same plan before more room.
    expect(pickNextAccount('u1', accounts, now, { model: 'opus', plan: 'Ultra' })).toBe('u3');
    // A Fable session cannot go to u3.
    expect(pickNextAccount('u1', accounts, now, { model: 'fable', plan: 'Ultra' })).toBe('m1');
  });

  it('moves by a cap to the next account in the person’s order, never onto an API key', () => {
    const lim = (weekly: number): RateLimit[] => [w('seven_day', weekly)];
    const accounts = [
      { id: 'key', signedIn: true, planLimits: false },
      { id: 'u1', signedIn: true, plan: 'Ultra', limits: lim(95), cap: { weekly: 95 } },
      { id: 'm1', signedIn: true, plan: 'Max', limits: lim(5) },
      { id: 'u2', signedIn: true, plan: 'Ultra' },
      { id: 'u3', signedIn: true, plan: 'Ultra', limits: lim(10) },
    ];
    // "Ultra1 up to 95%, then Ultra2": the next Ultra in the list, though Ultra3 has more room.
    expect(pickNextAccount('u1', accounts, now, { plan: 'Ultra', byCap: true })).toBe('u2');
    // From Ultra3 the list wraps round to Ultra1 (under its cap here would be needed: it is not), then Ultra2.
    expect(pickNextAccount('u3', accounts, now, { plan: 'Ultra', byCap: true })).toBe('u2');
    // No plan account left: an API key is never taken by itself (by a cap or at a limit).
    const plansGone = [accounts[0], accounts[1], { id: 'm2', signedIn: true, plan: 'Max', limits: lim(100) }];
    expect(pickNextAccount('u1', plansGone, now, { plan: 'Ultra', byCap: true })).toBeUndefined();
    expect(pickNextAccount('u1', plansGone, now, { plan: 'Ultra' })).toBeUndefined();
  });
});

describe('caps: moving a session', () => {
  it('moves before a send when the account is past its cap, with one line, and answers there', { timeout: 20_000 }, async () => {
    const { app, home } = start();
    const studio = await demoAccount(app, 'Studio', 'near');
    const work = await demoAccount(app, 'Work', 'light');
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: studio.id });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => answered(rt.items) && rt.meta.status === 'idle', 'first answer');
    expect(rt.meta.accountId).toBe(studio.id);

    // Studio's weekly is at 74%: a 70% cap is reached, and the next message goes out under Work.
    await caps(app, { [studio.id]: { weekly: 70 } });
    await app.call('session.send', { sessionId: rt.id, text: 'hi again' });
    expect(rt.meta.accountId).toBe(work.id);
    const line = notices(rt.items).pop()!;
    expect(line).toMatchObject({ variant: 'info', text: 'Moved to Work: Studio reached its 70% cap' });
    // The line stands before the message it moved for.
    const lastUser = rt.items.findLastIndex((i) => i.type === 'user');
    expect(rt.items.indexOf(line)).toBeLessThan(lastUser);
    await until(() => rt.meta.status === 'idle' && rt.items.slice(lastUser).some((i) => i.type === 'text'), 'answer under Work');
    expect(rt.meta.movedFrom).toBe(studio.id);
  });

  it('moves when a turn ends past the cap, never during it, and a queued message goes out under the new account', { timeout: 20_000 }, async () => {
    const { app, home } = start(0.2);
    const studio = await demoAccount(app, 'Studio', 'light');
    const work = await demoAccount(app, 'Work', 'light');
    await caps(app, { [studio.id]: { weekly: 70 } });
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: studio.id });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => rt.turnActive, 'turn running');
    // The limits climb past the cap while the turn runs (the ticker or the turn's own report).
    await setProfile(app, studio, 'Studio', 'near');
    const queued = await app.call('session.send', { sessionId: rt.id, text: 'hi then' });
    expect(queued.queued).toBe(true);
    expect(rt.meta.accountId).toBe(studio.id);
    await until(() => rt.meta.accountId === work.id, 'move at the turn end', 10_000);
    expect(notices(rt.items).some((n) => n.text === 'Moved to Work: Studio reached its 70% cap')).toBe(true);
    // The queued message went out after the move.
    await until(() => !rt.turnActive && rt.meta.status === 'idle' && rt.items.filter((i) => i.type === 'user').length === 2, 'queued message sent', 10_000);
    const moved = rt.items.findIndex((i) => i.type === 'notice' && i.text.startsWith('Moved to Work'));
    const second = rt.items.findLastIndex((i) => i.type === 'user');
    expect(moved).toBeLessThan(second);
  });

  it('stays when no account is under its cap, and says so once', { timeout: 20_000 }, async () => {
    const { app, home } = start();
    const studio = await demoAccount(app, 'Studio', 'near');
    const work = await demoAccount(app, 'Work', 'near');
    // The built-in account (61% weekly) and Work (74%) are past their caps too.
    await caps(app, { [studio.id]: { weekly: 70 }, [work.id]: { weekly: 70 }, [DEFAULT_ACCOUNT]: { weekly: 50 } });
    await app.call('provider.limits', { provider: 'demo' });
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: studio.id });
    const rt = app.runtime(snap.session.id);
    expect(notices(rt.items)).toHaveLength(0);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => answered(rt.items) && rt.meta.status === 'idle', 'answer');
    await app.call('session.send', { sessionId: rt.id, text: 'hi again' });
    await until(() => rt.meta.status === 'idle' && rt.items.filter((i) => i.type === 'text').length >= 2, 'second answer');
    expect(rt.meta.accountId).toBe(studio.id);
    const said = notices(rt.items).filter((n) => n.text === 'Studio reached its 70% cap');
    expect(said).toHaveLength(1);
    expect(said[0].detail).toMatch(/No other account is under its cap/);
  });

  it('does nothing with caps off, however high the usage', { timeout: 20_000 }, async () => {
    const { app, home } = start();
    const studio = await demoAccount(app, 'Studio', 'near');
    await demoAccount(app, 'Work', 'light');
    await caps(app, { [studio.id]: { weekly: 100 } });
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: studio.id });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => answered(rt.items) && rt.meta.status === 'idle', 'answer');
    expect(rt.meta.accountId).toBe(studio.id);
    expect(notices(rt.items)).toHaveLength(0);
  });

  it('starts a new session on an account under its cap', async () => {
    const { app, home } = start();
    const studio = await demoAccount(app, 'Studio', 'near');
    const work = await demoAccount(app, 'Work', 'light');
    await caps(app, { [studio.id]: { session: 80 } });
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: studio.id });
    expect(snap.session.accountId).toBe(work.id);
    expect(notices(app.runtime(snap.session.id).items)[0]).toMatchObject({ text: 'Started with Work: Studio reached its 80% 5-hour cap' });
  });
});
