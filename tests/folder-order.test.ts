/** The sidebar's manual folder order and removing a folder with its sessions, at the bridge. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-folders-'));
  homes.push(home);
  const dirs = ['one', 'two', 'three'].map((n) => {
    const d = path.join(home, 'code', n);
    mkdirSync(d, { recursive: true });
    return d;
  });
  return { home, dirs, app: () => new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true }) };
}

const names = (app: App) =>
  app['store'].state.projects
    .filter((p) => !p.hidden)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((p) => p.name);

describe('folder order', () => {
  it('puts a new folder on top and keeps a dragged order', async () => {
    const { dirs, app: make } = setup();
    const app = make();
    for (const d of dirs) await app.call('project.add', { path: d });
    expect(names(app)).toEqual(['three', 'two', 'one']);
    await app.call('project.reorder', { paths: [dirs[0], dirs[2], dirs[1]] });
    expect(names(app)).toEqual(['one', 'three', 'two']);
    // Using a folder does not move it.
    await app.call('session.create', { provider: 'demo', cwd: dirs[1] });
    expect(names(app)).toEqual(['one', 'three', 'two']);
    await app.dispose();
  });

  it('refuses a dropped file as a folder', async () => {
    const { home, app: make } = setup();
    const app = make();
    const file = path.join(home, 'notes.txt');
    writeFileSync(file, 'x');
    await expect(app.call('project.add', { path: file })).rejects.toThrow(/Not a folder/);
    await app.dispose();
  });

  it('hides a folder with its sessions and brings both back when it is opened again', async () => {
    const { dirs, app: make } = setup();
    const app = make();
    for (const d of dirs) await app.call('project.add', { path: d });
    const snap = await app.call('session.create', { provider: 'demo', cwd: dirs[0] });
    await app.call('project.remove', { path: dirs[0] });
    const p = app['store'].state.projects.find((x) => x.name === 'one');
    expect(p?.hidden).toBe(true);
    expect(app.runtime(snap.session.id)).toBeDefined();
    // A folder without sessions is simply forgotten.
    await app.call('project.remove', { path: dirs[1] });
    expect(app['store'].state.projects.some((x) => x.name === 'two')).toBe(false);
    await app.call('project.add', { path: dirs[0] });
    expect(app['store'].state.projects.find((x) => x.name === 'one')?.hidden).toBeUndefined();
    expect(names(app)[0]).toBe('one');
    await app.dispose();
  });

  it('gives an older profile its current order the first time', async () => {
    const { home, dirs } = setup();
    const now = Date.now();
    writeFileSync(
      path.join(home, 'state.json'),
      JSON.stringify({
        projects: dirs.map((d, i) => ({ path: d, name: path.basename(d), lastOpened: now - i * 1000 })),
        settings: { onboarded: true },
        sessions: [],
        accounts: [],
      }),
    );
    mkdirSync(path.join(home, 'sessions'), { recursive: true });
    const app = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
    expect(names(app)).toEqual(['one', 'two', 'three']);
    await app.dispose();
  });
});
