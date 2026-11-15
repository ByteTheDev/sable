/** Accounts: the registry, per-account provider instances, sessions under an account, tagged events. */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT, type BridgeEvent } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function start(home?: string) {
  home ??= mkdtempSync(path.join(tmpdir(), 'sable-accounts-'));
  if (!homes.includes(home)) homes.push(home);
  const app = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
  apps.push(app);
  const events: BridgeEvent[] = [];
  app.subscribe((e) => events.push(structuredClone(e)));
  return { app, home, events };
}

async function until(pred: () => boolean, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function restart(app: App, home: string) {
  await app.dispose();
  apps.splice(apps.indexOf(app), 1);
  return start(home);
}

describe('account registry', () => {
  it('always lists the built-in default first, as the default choice', async () => {
    const { app } = start();
    const [demo] = (await app.call('app.hello', {})).providers;
    expect(demo.accounts).toEqual([
      expect.objectContaining({ id: DEFAULT_ACCOUNT, provider: 'demo', label: 'Main', isDefault: true, auth: expect.objectContaining({ loggedIn: true }) }),
    ]);
    expect(demo.accounts![0].dir).toBeUndefined();
  });

  it('adds accounts with their own folder, renames them and keeps them across a restart', async () => {
    const { app, home } = start();
    const a = await app.call('account.add', { provider: 'demo' });
    const b = await app.call('account.add', { provider: 'demo', label: '  Work  ' });
    expect(a.account).toMatchObject({ label: 'Account 2', isDefault: false, auth: { loggedIn: false } });
    expect(b.account.label).toBe('Work');
    expect(b.accounts!.map((x) => x.id)).toEqual([DEFAULT_ACCOUNT, a.account.id, b.account.id]);
    expect(a.account.dir).toBe(path.join(home, 'accounts', 'demo', a.account.id));
    expect(existsSync(a.account.dir!)).toBe(true);

    await app.call('account.rename', { provider: 'demo', accountId: a.account.id, label: 'Personal' });
    await app.call('account.rename', { provider: 'demo', accountId: DEFAULT_ACCOUNT, label: 'Company' });
    const blank = await app.call('account.rename', { provider: 'demo', accountId: b.account.id, label: '   ' });
    expect(blank.accounts!.map((x) => x.label)).toEqual(['Company', 'Personal', 'Work']);

    const again = await restart(app, home);
    const [demo] = (await again.app.call('app.hello', {})).providers;
    expect(demo.accounts!.map((x) => [x.id, x.label])).toEqual([
      [DEFAULT_ACCOUNT, 'Company'],
      [a.account.id, 'Personal'],
      [b.account.id, 'Work'],
    ]);
  });

  it('refuses to remove the default account and deletes an extra account with its folder', async () => {
    const { app } = start();
    await expect(app.call('account.remove', { provider: 'demo', accountId: DEFAULT_ACCOUNT })).rejects.toThrow(/default account/);
    const { account } = await app.call('account.add', { provider: 'demo' });
    await app.call('app.setSettings', { patch: { defaultAccounts: { demo: account.id } } });
    const info = await app.call('account.remove', { provider: 'demo', accountId: account.id });
    expect(info.accounts!.map((x) => x.id)).toEqual([DEFAULT_ACCOUNT]);
    expect(info.accounts![0].isDefault).toBe(true);
    expect(existsSync(account.dir!)).toBe(false);
    expect(app.store.state.settings.defaultAccounts?.demo).toBeUndefined();
    await expect(app.call('account.remove', { provider: 'demo', accountId: account.id })).rejects.toThrow(/not found/);
  });

  it('refuses to remove an account while one of its sessions is working, then closes idle ones', async () => {
    const { app, home } = start();
    const { account } = await app.call('account.add', { provider: 'demo' });
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: account.id });
    const rt = app.runtime(snap.session.id);
    rt.update({ status: 'running' });
    await expect(app.call('account.remove', { provider: 'demo', accountId: account.id })).rejects.toThrow(/still working/);
    rt.update({ status: 'idle' });
    await app.call('account.remove', { provider: 'demo', accountId: account.id });
    expect(rt.handle).toBeUndefined();
    // The session stays in the list but cannot run without its account.
    await expect(app.call('session.send', { sessionId: rt.id, text: 'hi' })).rejects.toThrow(/account was removed/);
  });
});

describe('provider per account', () => {
  it('creates one instance per account lazily and reuses it', async () => {
    const { app } = start();
    const { account } = await app.call('account.add', { provider: 'demo' });
    const def = app.provider('demo');
    const extra = app.provider('demo', account.id);
    expect(extra).not.toBe(def);
    expect(app.provider('demo', account.id)).toBe(extra);
    expect(app.provider('demo', DEFAULT_ACCOUNT)).toBe(def);
    expect(() => app.provider('demo', 'nope')).toThrow(/removed/);
  });

  it('creates sessions under the requested, the default or the chosen default account', async () => {
    const { app, home } = start();
    const { account } = await app.call('account.add', { provider: 'demo' });
    const cwd = path.join(home, 'p');
    const plain = await app.call('session.create', { provider: 'demo', cwd });
    expect(plain.session.accountId).toBeUndefined();
    const explicit = await app.call('session.create', { provider: 'demo', cwd, accountId: account.id });
    expect(explicit.session.accountId).toBe(account.id);
    await app.call('app.setSettings', { patch: { defaultAccounts: { demo: account.id } } });
    const chosen = await app.call('session.create', { provider: 'demo', cwd });
    expect(chosen.session.accountId).toBe(account.id);
    const own = await app.call('session.create', { provider: 'demo', cwd, accountId: DEFAULT_ACCOUNT });
    expect(own.session.accountId).toBeUndefined();
    await expect(app.call('session.create', { provider: 'demo', cwd, accountId: 'nope' })).rejects.toThrow(/removed/);

    // Sessions keep their account across a restart and resume under it.
    const again = await restart(app, home);
    expect(again.app.runtime(explicit.session.id).meta.accountId).toBe(account.id);
    await again.app.call('session.send', { sessionId: explicit.session.id, text: 'hi' });
    await until(() => again.app.runtime(explicit.session.id).meta.status === 'idle', 'idle session');
    const [demo] = (await again.app.call('app.hello', {})).providers;
    expect(demo.accounts!.find((a) => a.id === account.id)?.isDefault).toBe(true);
  });
});

describe('account events', () => {
  it('signs an extra account in with progress, limits and provider updates tagged by account', async () => {
    const { app, events } = start();
    const { account } = await app.call('account.add', { provider: 'demo' });
    expect(await app.call('provider.limits', { provider: 'demo', accountId: account.id })).toEqual([]);

    await app.call('auth.login', { provider: 'demo', accountId: account.id });
    await until(() => events.some((e) => e.type === 'auth.progress' && e.state === 'done'), 'sign-in');
    const progress = events.flatMap((e) => (e.type === 'auth.progress' ? [[e.accountId, e.state]] : []));
    expect(progress).toEqual([
      [account.id, 'started'],
      [account.id, 'url'],
      [account.id, 'done'],
    ]);
    const updated = events.filter((e) => e.type === 'provider.updated').pop();
    const signedIn = updated?.type === 'provider.updated' ? updated.provider.accounts?.find((a) => a.id === account.id) : undefined;
    expect(signedIn?.auth).toMatchObject({ loggedIn: true });
    expect(signedIn?.auth.email).toMatch(/@/);
    expect(signedIn?.auth.email).not.toBe('demo@sable.local');
    // The default account is untouched.
    expect(updated?.type === 'provider.updated' && updated.provider.auth.email).toBe('demo@sable.local');

    const own = await app.call('provider.limits', { provider: 'demo' });
    const theirs = await app.call('provider.limits', { provider: 'demo', accountId: account.id });
    expect(theirs).toHaveLength(own.length);
    expect(theirs.map((l) => l.percent)).not.toEqual(own.map((l) => l.percent));
    const tagged = events.flatMap((e) => (e.type === 'limits.updated' ? [e.accountId] : []));
    expect(tagged).toEqual([account.id, DEFAULT_ACCOUNT, account.id]);
    const [demo] = (await app.call('app.hello', {})).providers;
    expect(demo.accounts!.find((a) => a.id === account.id)?.limits).toEqual(theirs);

    await app.call('auth.logout', { provider: 'demo', accountId: account.id });
    const after = (await app.call('app.hello', {})).providers[0].accounts!;
    expect(after.find((a) => a.id === account.id)?.auth.loggedIn).toBe(false);
    expect(after.find((a) => a.id === DEFAULT_ACCOUNT)?.auth.loggedIn).toBe(true);
  });

  it('reports a cancelled sign-in once, as cancelled', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-accounts-'));
    homes.push(home);
    const app = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 1 })], quiet: true });
    apps.push(app);
    const events: BridgeEvent[] = [];
    app.subscribe((e) => events.push(structuredClone(e)));
    const { account } = await app.call('account.add', { provider: 'demo' });
    await app.call('auth.login', { provider: 'demo', accountId: account.id });
    await app.call('auth.cancel', { provider: 'demo', accountId: account.id });
    await new Promise((r) => setTimeout(r, 50));
    const states = events.flatMap((e) => (e.type === 'auth.progress' ? [e.state] : []));
    expect(states).toEqual(['started', 'url', 'cancelled']);
  });
});
