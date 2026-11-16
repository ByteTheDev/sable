import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@shared/protocol';
import { buildGroups, createGroupsSelector } from '@/features/sidebar/groups';

const s = (id: string, over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, provider: 'claude', cwd: 'D:/code/app', title: id, titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: {}, ...over }) as SessionMeta;

const map = (...list: SessionMeta[]) => Object.fromEntries(list.map((x) => [x.id, x]));

describe('sidebar groups', () => {
  it('orders rows by recency and folders by their latest row', () => {
    const g = buildGroups(map(s('a', { updatedAt: 1 }), s('b', { updatedAt: 3 }), s('c', { cwd: 'D:/code/other', updatedAt: 2 })), []);
    expect(g.projects.map((p) => p.name)).toEqual(['app', 'other']);
    expect(g.projects[0].sessions.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('marks only a folder that mixes agents, and names the agent most rows run', () => {
    const g = buildGroups(map(s('a'), s('b'), s('c', { provider: 'codex' })), []);
    expect(g.projects[0].mix).toBe('agent');
    expect(g.projects[0].major).toBe('claude');
    const one = buildGroups(map(s('a'), s('b', { accountId: 'work' })), []);
    expect(one.projects[0].mix).toBe('account');
    expect(one.projects[0].major).toBeUndefined();
  });

  it('puts the most pressing state on a folder', () => {
    const g = buildGroups(map(s('a', { unread: true }), s('b', { status: 'running' }), s('c', { status: 'awaiting' })), []);
    expect(g.projects[0].attention).toBe('awaiting');
  });

  it('keeps the same groups while only what rows show changes', () => {
    const select = createGroupsSelector();
    const projects: never[] = [];
    const first = select({ sessions: map(s('a', { updatedAt: 1 }), s('b', { updatedAt: 2 })), projects });
    const touched = select({ sessions: map(s('a', { updatedAt: 1, title: 'renamed', activity: 'Reading' }), s('b', { updatedAt: 2 })), projects });
    expect(touched).toBe(first);
    const moved = select({ sessions: map(s('a', { updatedAt: 3 }), s('b', { updatedAt: 2 })), projects });
    expect(moved).not.toBe(first);
    expect(moved.projects[0].sessions.map((x) => x.id)).toEqual(['a', 'b']);
  });
});
