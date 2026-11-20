/**
 * Race at the bridge: two Demo chats on one task, each in a lane of its own made from one
 * temporary git folder. The Demo applies its edits for real inside a lane, so each lane holds the
 * refactor's files. Keep lands one lane and discards the other; Discard both drops both; the
 * pairing survives a restart. Temporary folders only.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoticeItem } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';

const temps: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  // A deleted chat's lane check may still run git there for a moment (Windows holds the folder meanwhile).
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function until(pred: () => boolean, what: string, ms = 45_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const TASK = 'refactor the session module';

function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-race-'));
  temps.push(home);
  const repo = path.join(home, 'code', 'relay');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(repo, 'README.md'), '# relay\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  const open = () => {
    const app = new App({ home: path.join(home, 'profile'), providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true, userHome: home });
    apps.push(app);
    return app;
  };
  const app = open();
  const meta = (id: string, a = app) => a.runtime(id).meta;
  const settled = (id: string, a = app) => {
    const rt = a.runtime(id);
    return rt.meta.status === 'idle' && !rt.turnActive && rt.items.some((i) => i.type === 'turn');
  };
  const notices = (id: string, a = app) => a.runtime(id).items.filter((i): i is NoticeItem => i.type === 'notice').map((n) => n.text);
  /** Starts a race of two Demo models and waits for both turns to end. */
  const race = async (a = app) => {
    const res = await a.call('race.start', { cwd: repo, task: TASK, provider: 'demo', modes: { demo: 'bypassPermissions' } });
    expect(res.ok).toBe(true);
    const [left, right] = res.sessions!.map((s) => s.session.id);
    await until(() => settled(left, a) && settled(right, a), 'both turns');
    return { res, left, right };
  };
  return { home, repo, app, open, meta, notices, race, lanes: path.join(home, 'profile', 'lanes') };
}

describe('race with two Demo chats', { timeout: 180_000 }, () => {
  it('refuses outside a git folder and without a task', async () => {
    const { app, home, repo } = setup();
    const plain = path.join(home, 'plain');
    mkdirSync(plain);
    expect(await app.call('race.start', { cwd: plain, task: TASK, provider: 'demo' })).toEqual({ ok: false, error: 'Race needs a folder in a git repository.' });
    expect((await app.call('race.start', { cwd: repo, task: '   ', provider: 'demo' })).ok).toBe(false);
    // Nothing was made.
    expect([...app['sessions'].keys()]).toEqual([]);
  });

  it('starts two chats in two lanes, paired, each sent the task, with real work in each lane', async () => {
    const { app, repo, meta, notices, race, lanes } = setup();
    const { res, left, right } = await race();
    const a = meta(left);
    const b = meta(right);
    // Two models of the Demo agent, each its own chat.
    expect(a.provider).toBe('demo');
    expect(b.provider).toBe('demo');
    expect(a.model).toBe('demo-large');
    expect(b.model).not.toBe(a.model);
    expect(a.mode).toBe('bypassPermissions');
    // Paired both ways.
    expect(a.race).toMatchObject({ id: res.raceId, rival: right, side: 0, task: TASK, folder: path.resolve(repo) });
    expect(b.race).toMatchObject({ id: res.raceId, rival: left, side: 1, task: TASK, folder: path.resolve(repo) });
    expect(a.race!.outcome).toBeUndefined();
    // Each in a lane of its own, from the same folder, on its own branch.
    expect(a.lane!.folder).toBe(path.resolve(repo));
    expect(b.lane!.folder).toBe(path.resolve(repo));
    expect(a.lane!.path).not.toBe(b.lane!.path);
    expect(a.lane!.path.startsWith(lanes)).toBe(true);
    expect(a.cwd).toBe(a.lane!.path);
    expect(a.lane!.branch).toMatch(/^sable\/race-refactor-the-session-demo-large$/);
    expect(b.lane!.branch).not.toBe(a.lane!.branch);
    expect(notices(left)[0]).toBe(`Working in lane ${a.lane!.branch}`);
    // Both got the task as their first message.
    for (const id of [left, right]) expect(app.runtime(id).items.find((i) => i.type === 'user')).toMatchObject({ text: TASK });
    // The Demo's edits are in each lane, and only there.
    for (const m of [a, b]) expect(readFileSync(path.join(m.lane!.path, 'src', 'server', 'session.ts'), 'utf8')).toContain('validate');
    expect(existsSync(path.join(repo, 'src'))).toBe(false);
    // The lane's changes, file by file.
    const diff = await app.call('lane.diff', { sessionId: left });
    expect(diff.map((d) => d.path).sort()).toEqual(['src/auth/middleware.ts', 'src/server/session.ts']);
    expect(diff.every((d) => d.status === 'added' && d.additions > 0)).toBe(true);
    // The folder stays the sidebar's place.
    expect(app['store'].state.projects.map((p) => p.path)).toEqual([path.resolve(repo)]);
  });

  it('keeps one: lands it on the branch, then discards the other lane and archives its chat', async () => {
    const { app, repo, meta, notices, race } = setup();
    const { left, right } = await race();
    const kept = meta(left).lane!;
    const dropped = meta(right).lane!;
    const head = git(repo, 'rev-parse', 'HEAD');
    const res = await app.call('race.keep', { sessionId: left });
    expect(res).toMatchObject({ ok: true, how: 'fast-forward', target: 'main', commits: 1, discarded: true });
    // Landed: the refactor is on main, committed with the task as its message.
    expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(head);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe(TASK);
    expect(readFileSync(path.join(repo, 'src', 'server', 'session.ts'), 'utf8')).toContain('validate');
    // The kept chat is back in its folder, its lane gone; the race says how it ended.
    expect(meta(left)).toMatchObject({ cwd: path.resolve(repo), lane: null });
    expect(meta(left).race).toMatchObject({ outcome: 'kept' });
    expect(meta(left).archived).toBeFalsy();
    expect(notices(left)).toContain(`Landed ${kept.branch} on main`);
    // The other lane is gone with its branch; its chat is archived, not deleted.
    expect(existsSync(dropped.path)).toBe(false);
    expect(existsSync(kept.path)).toBe(false);
    expect(git(repo, 'branch', '--list', 'sable/*')).toBe('');
    expect(meta(right)).toMatchObject({ archived: true, lane: null });
    expect(meta(right).race).toMatchObject({ outcome: 'dropped' });
    expect(notices(right)).toContain(`Discarded lane ${dropped.branch}`);
    // Decided: nothing more to keep or discard.
    expect(await app.call('race.keep', { sessionId: right })).toMatchObject({ ok: false, error: 'This race is decided.' });
    expect(await app.call('race.discard', { sessionId: left })).toMatchObject({ ok: false });
  });

  it('refuses to keep a lane that conflicts with the branch, and changes nothing', async () => {
    const { app, repo, meta, race } = setup();
    const { left, right } = await race();
    // The folder's branch got its own session.ts meanwhile.
    mkdirSync(path.join(repo, 'src', 'server'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'server', 'session.ts'), 'export const TTL = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Own session');
    const head = git(repo, 'rev-parse', 'HEAD');
    const res = await app.call('race.keep', { sessionId: right });
    expect(res).toMatchObject({ ok: false, conflicts: ['src/server/session.ts'], target: 'main' });
    expect(res.error).toBe('It conflicts with main. Nothing was changed.');
    // Nothing landed, nothing discarded, nothing archived: the race is still open.
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    for (const id of [left, right]) {
      expect(existsSync(meta(id).lane!.path)).toBe(true);
      expect(meta(id).race!.outcome).toBeUndefined();
      expect(meta(id).archived).toBeFalsy();
    }
  });

  it('discards both: both lanes and branches go, both chats are archived, the folder is untouched', async () => {
    const { app, repo, meta, race } = setup();
    const { left, right } = await race();
    const paths = [meta(left).lane!.path, meta(right).lane!.path];
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(await app.call('race.discard', { sessionId: right })).toEqual({ ok: true });
    for (const p of paths) expect(existsSync(p)).toBe(false);
    expect(git(repo, 'branch', '--list', 'sable/*')).toBe('');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    for (const id of [left, right]) {
      expect(meta(id)).toMatchObject({ archived: true, lane: null, cwd: path.resolve(repo) });
      expect(meta(id).race!.outcome).toBe('dropped');
    }
  });

  it('keeping one while the other still works stops it first', async () => {
    const { app, meta, race } = setup();
    const { left, right } = await race();
    // The right side is sent another turn that waits on the person (an edit to approve).
    await app.call('session.setMode', { sessionId: right, mode: 'default' });
    void app.call('session.send', { sessionId: right, text: 'refactor it again' });
    await until(() => meta(right).status === 'awaiting', 'the right side to wait');
    const kept = await app.call('race.keep', { sessionId: left });
    expect(kept).toMatchObject({ ok: true, discarded: true });
    expect(app.runtime(right).turnActive).toBe(false);
    expect(meta(right)).toMatchObject({ archived: true, lane: null });
  });

  it('survives a restart: the pairing comes back with the sessions, and the race can be decided', async () => {
    const { app, open, repo, meta, race } = setup();
    const { res, left, right } = await race();
    await app.dispose();
    apps.splice(apps.indexOf(app), 1);
    const again = open();
    const a = meta(left, again);
    const b = meta(right, again);
    expect(a.race).toMatchObject({ id: res.raceId, rival: right, side: 0 });
    expect(b.race).toMatchObject({ id: res.raceId, rival: left, side: 1 });
    expect(existsSync(a.lane!.path)).toBe(true);
    const kept = await again.call('race.keep', { sessionId: right, message: 'Keep the second one' });
    expect(kept).toMatchObject({ ok: true, discarded: true });
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Keep the second one');
    expect(meta(left, again)).toMatchObject({ archived: true, lane: null });
  });

  it('a deleted chat leaves its rival out of the race, with its lane', async () => {
    const { app, meta, race } = setup();
    const { left, right } = await race();
    const lane = meta(right).lane!;
    const logs: string[] = [];
    app.log = (...args: unknown[]) => void logs.push(args.join(' '));
    await app.call('session.close', { sessionId: left, remove: true });
    expect(meta(right).race).toBeNull();
    expect(meta(right).lane).toEqual(lane);
    expect(await app.call('race.keep', { sessionId: right })).toMatchObject({ ok: false, error: 'This chat is not in a race.' });
    // The deleted chat's lane holds work: its branch keeps it (the check runs git a moment longer).
    await until(() => logs.some((l) => l.startsWith('lane: kept with its work')), 'the deleted chat’s lane check');
  });
});
