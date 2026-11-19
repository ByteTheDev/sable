/** Chats without a folder and projects that group folders, at the bridge. Temporary folders only. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionMeta } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { chatFolderName, defaultChatsRoot } from '../server/core/chats';
import { buildGroups } from '@/features/sidebar/groups';

const temps: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-chats-'));
  temps.push(home);
  const dirs = ['app', 'server', 'site', 'other'].map((n) => {
    const d = path.join(home, 'code', n);
    mkdirSync(d, { recursive: true });
    return d;
  });
  const make = () => {
    const app = new App({ home: path.join(home, 'profile'), providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true, userHome: home });
    apps.push(app);
    return app;
  };
  return { home, dirs, make, chats: path.join(home, 'chats') };
}

describe('chats without a folder', () => {
  it('names a chat folder by the date and the first words, safe for any filesystem', () => {
    const d = new Date(2026, 10, 19);
    expect(chatFolderName('Refactor the session module, please!', d)).toBe('2026-11-19 Refactor the session module please');
    expect(chatFolderName('what is <this>: a/b\\c? "x" | y*', d)).toBe('2026-11-19 what is this a b c');
    expect(chatFolderName('', d)).toBe('2026-11-19 chat');
    expect(chatFolderName('...', d)).toBe('2026-11-19 chat');
    expect(chatFolderName('a'.repeat(80), d)).toBe(`2026-11-19 ${'a'.repeat(48)}`);
    expect(defaultChatsRoot('/home/u', 'linux')).toBe(path.join('/home/u', 'Sable chats'));
    expect(defaultChatsRoot('C:\\Users\\u', 'win32', () => true)).toBe('D:\\Sable chats');
    expect(defaultChatsRoot('C:\\Users\\u', 'win32', () => false)).toBe(path.join('C:\\Users\\u', 'Sable chats'));
  });

  it('makes a fresh folder per chat under the chats folder and runs the session there', async () => {
    const { make, chats } = setup();
    const app = make();
    await app.call('app.setSettings', { patch: { chatsFolder: chats } });
    expect((await app.call('chats.prepare', {})).path).toBe(path.resolve(chats));
    const a = await app.call('session.create', { provider: 'demo', cwd: '', chat: { text: 'plan a trip to Kyoto' } });
    const b = await app.call('session.create', { provider: 'demo', cwd: '', chat: { text: 'plan a trip to Kyoto' } });
    expect(a.session.chat).toBe(true);
    expect(path.dirname(a.session.cwd)).toBe(path.resolve(chats));
    expect(path.basename(a.session.cwd)).toMatch(/^\d{4}-\d\d-\d\d plan a trip to Kyoto$/);
    expect(path.basename(b.session.cwd)).toMatch(/plan a trip to Kyoto 2$/);
    expect(existsSync(a.session.cwd) && readdirSync(a.session.cwd)).toEqual([]);
    // A chat's folder is not one of the sidebar's folders.
    expect(app['store'].state.projects.some((p) => p.path === a.session.cwd)).toBe(false);
    await app.call('session.send', { sessionId: a.session.id, text: 'plan a trip to Kyoto' });

    // Deleting a chat takes its folder along only while it is empty.
    writeFileSync(path.join(b.session.cwd, 'notes.md'), 'kept');
    await app.call('session.close', { sessionId: b.session.id, remove: true });
    expect(existsSync(b.session.cwd)).toBe(true);
    const c = await app.call('session.create', { provider: 'demo', cwd: '', chat: { text: 'nothing yet' } });
    await app.call('session.close', { sessionId: c.session.id, remove: true });
    expect(existsSync(c.session.cwd)).toBe(false);
  });

  it('keeps chats out of the folders after a restart and groups them together in the sidebar', async () => {
    const { make, chats, dirs } = setup();
    const app = make();
    await app.call('app.setSettings', { patch: { chatsFolder: chats } });
    const chat = await app.call('session.create', { provider: 'demo', cwd: '', chat: { text: 'hello there' } });
    await app.call('session.create', { provider: 'demo', cwd: dirs[0] });
    await app.dispose();
    apps.splice(apps.indexOf(app), 1);
    const again = make();
    const state = await again.call('app.hello', {});
    expect(state.projects.some((p) => p.path === chat.session.cwd)).toBe(false);
    const sessions = Object.fromEntries(state.sessions.map((s) => [s.id, s])) as Record<string, SessionMeta>;
    const g = buildGroups(sessions, state.projects, 'manual', state.groups, state.chatsOrder);
    expect(g.chats?.sessions.map((s) => s.id)).toEqual([chat.session.id]);
    expect(g.projects.every((p) => p.sessions.every((s) => !s.chat))).toBe(true);
  });
});

describe('projects', () => {
  it('groups folders, renames, orders with loose folders and the chats group, and ungroups in place', async () => {
    const { make, dirs } = setup();
    const app = make();
    for (const d of dirs) await app.call('project.add', { path: d });
    // Newest on top: other, site, server, app.
    const g = await app.call('group.create', { name: '  Sable   product ', paths: [dirs[2], dirs[0]] });
    expect(g.name).toBe('Sable product');
    let st = await app.call('app.hello', {});
    const groupOf = (dir: string) => st.projects.find((p) => p.path === dir)?.group;
    expect(groupOf(dirs[0])).toBe(g.id);
    expect(groupOf(dirs[2])).toBe(g.id);
    expect(groupOf(dirs[1])).toBeUndefined();
    const sessions = {} as Record<string, SessionMeta>;
    let view = buildGroups(sessions, st.projects, 'manual', st.groups, st.chatsOrder);
    // The project stands where its first folder (site) stood; its folders in the order given.
    expect(view.top.map((e) => e.key)).toEqual([dirs[3], `group:${g.id}`, dirs[1]].map((k) => (k.startsWith('group:') ? k : k.replace(/\\/g, '/').toLowerCase())));
    const set = view.top.find((e) => e.kind === 'group');
    expect(set?.kind === 'group' && set.folders.map((f) => f.name)).toEqual(['site', 'app']);

    // Drag: server into the project at the front, the project to the top, chats between.
    await app.call('project.arrange', { top: [`group:${g.id}`, 'chats', dirs[3]], inside: { [g.id]: [dirs[1], dirs[2], dirs[0]] } });
    await app.call('group.rename', { id: g.id, name: 'Sable' });
    st = await app.call('app.hello', {});
    view = buildGroups(sessions, st.projects, 'manual', st.groups, st.chatsOrder);
    // No chats yet: the chats group keeps its place without showing.
    expect(view.top.map((e) => e.kind)).toEqual(['group', 'folder']);
    const inside = view.top[0];
    expect(inside.kind === 'group' && inside.name).toBe('Sable');
    expect(inside.kind === 'group' && inside.folders.map((f) => f.name)).toEqual(['server', 'site', 'app']);

    // Out of the project again, after it.
    await app.call('project.arrange', { top: [`group:${g.id}`, dirs[0], 'chats', dirs[3]] });
    st = await app.call('app.hello', {});
    expect(st.projects.find((p) => p.path === dirs[0])?.group).toBeUndefined();

    // Ungrouping leaves the folders where the project stood.
    await app.call('group.remove', { id: g.id });
    st = await app.call('app.hello', {});
    view = buildGroups(sessions, st.projects, 'manual', st.groups, st.chatsOrder);
    expect(st.groups).toEqual([]);
    expect(view.top.map((e) => (e.kind === 'folder' ? e.folder.name : e.kind))).toEqual(['server', 'site', 'app', 'other']);
  });

  it('shows a project with its agents and chats, and nothing changes without projects', () => {
    const s = (id: string, cwd: string, over: Partial<SessionMeta> = {}) =>
      ({ id, provider: 'claude', cwd, title: id, titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 1, usage: {}, ...over }) as SessionMeta;
    const projects = [
      { path: 'D:/p/app', name: 'app', lastOpened: 0, order: 0, group: 'g1' },
      { path: 'D:/p/api', name: 'api', lastOpened: 0, order: 1, group: 'g1' },
      { path: 'D:/p/x', name: 'x', lastOpened: 0, order: 1 },
    ];
    const sessions = { a: s('a', 'D:/p/app'), b: s('b', 'D:/p/api', { provider: 'codex', status: 'awaiting' }), c: s('c', 'D:/p/x') };
    const view = buildGroups(sessions, projects, 'manual', [{ id: 'g1', name: 'Product', order: 0, createdAt: 0 }]);
    const set = view.top[0];
    expect(set.kind).toBe('group');
    if (set.kind !== 'group') return;
    expect(set.agents).toEqual(['claude', 'codex']);
    expect(set.count).toBe(2);
    expect(set.attention).toBe('awaiting');
    // Every folder is still in the flat list.
    expect(view.projects.map((p) => p.name).sort()).toEqual(['api', 'app', 'x']);
    // A folder whose project is gone is loose again.
    const lost = buildGroups(sessions, projects, 'manual', []);
    expect(lost.top.map((e) => e.kind)).toEqual(['folder', 'folder', 'folder']);
  });
});
