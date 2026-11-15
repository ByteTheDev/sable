/**
 * The UI store applying a realistic stream of bridge events. The store batches deltas
 * per animation frame and touches localStorage / document, so minimal shims come first.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BridgeEvent, PermissionRequest, QuestionRequest, SessionMeta, TextItem, TimelineItem, ToolItem, UserItem } from '@shared/protocol';

const frames: FrameRequestCallback[] = [];
const g = globalThis as Record<string, unknown>;
g.requestAnimationFrame = (cb: FrameRequestCallback) => frames.push(cb);
g.cancelAnimationFrame = () => {};
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.document = { hidden: false };
g.window = globalThis;

type StoreModule = typeof import('../src/state/store');
let S: StoreModule;

beforeAll(async () => {
  S = await import('../src/state/store');
});

/** Runs the pending animation frames, as the browser would before the next paint. */
function frame() {
  for (const cb of frames.splice(0)) cb(performance.now());
}

const SID = 'sess-1';
const meta = (patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id: SID,
  provider: 'demo',
  cwd: '/work/relay-api',
  title: 'New session',
  titleSource: 'auto',
  model: 'demo-large',
  mode: 'default',
  status: 'starting',
  createdAt: 1,
  updatedAt: 1,
  usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  ...patch,
});

const feed = (...events: BridgeEvent[]) => events.forEach((e) => S.applyEvent(e));
const data = () => S.useStore.getState().data[SID]!;
const item = <T extends TimelineItem>(id: string) => data().items[id] as T;

const user: UserItem = { id: 'u1', ts: 2, type: 'user', text: 'refactor the session module', state: 'sent' };
const text: TextItem = { id: 't1', ts: 3, type: 'text', text: '', streaming: true };
const agent: ToolItem = { id: 'a1', ts: 4, type: 'tool', name: 'Agent', kind: 'agent', title: 'Run a subagent', status: 'running', detail: {} };
const subRead: ToolItem = { id: 's1', ts: 5, type: 'tool', name: 'Read', kind: 'read', title: 'Read session.ts', status: 'running', detail: {}, parentId: 'a1' };
const subBash: ToolItem = { id: 's2', ts: 6, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run tests', status: 'running', detail: {}, parentId: 'a1' };

const permission: PermissionRequest = {
  id: 'p1',
  sessionId: SID,
  itemId: 's2',
  toolName: 'Bash',
  kind: 'bash',
  title: 'Run tests',
  detail: { command: 'npm test' },
  options: [
    { id: 'allow', label: 'Allow once', tone: 'allow' },
    { id: 'deny', label: 'Deny', tone: 'deny' },
  ],
  createdAt: 7,
};
const question: QuestionRequest = { id: 'q1', sessionId: SID, questions: [{ question: 'Which logger?', options: [{ label: 'pino' }] }], createdAt: 8 };

beforeEach(() => {
  frames.length = 0;
  S.useStore.setState({ sessions: {}, data: {}, ui: { ...S.useStore.getState().ui, activeSessionId: SID } });
});

describe('store event application', () => {
  it('builds a session from added items and coalesces deltas into one write per frame', () => {
    feed({ type: 'session.added', session: meta() });
    expect(data()).toMatchObject({ loaded: true, roots: [], permissions: [], questions: [], todos: [] });

    feed(
      { type: 'session.updated', id: SID, patch: { status: 'running', title: 'refactor the session module' } },
      { type: 'item.added', sessionId: SID, item: user },
      { type: 'item.added', sessionId: SID, item: text },
    );
    expect(S.useStore.getState().sessions[SID]).toMatchObject({ status: 'running', title: 'refactor the session module' });

    let writes = 0;
    const unsub = S.useStore.subscribe(() => writes++);
    const words = "I'll start by finding everywhere session expiry is decided today.".split(/(?<= )/);
    for (const w of words) feed({ type: 'item.delta', sessionId: SID, id: 't1', field: 'text', delta: w });
    // Nothing lands until the frame runs.
    expect(item<TextItem>('t1').text).toBe('');
    expect(writes).toBe(0);
    frame();
    unsub();
    expect(writes).toBe(1);
    expect(item<TextItem>('t1').text).toBe(words.join(''));
    expect(data().roots).toEqual(['u1', 't1']);
  });

  it('nests sub-agent items under their parent and streams inputText and output', () => {
    feed({ type: 'session.added', session: meta({ status: 'running' }) }, { type: 'item.added', sessionId: SID, item: user }, { type: 'item.added', sessionId: SID, item: agent });
    feed({ type: 'item.added', sessionId: SID, item: subRead }, { type: 'item.added', sessionId: SID, item: subBash });
    expect(data().roots).toEqual(['u1', 'a1']);
    expect(data().children).toEqual({ a1: ['s1', 's2'] });

    feed(
      { type: 'item.delta', sessionId: SID, id: 's2', field: 'inputText', delta: '{"command":' },
      { type: 'item.delta', sessionId: SID, id: 's2', field: 'inputText', delta: '"npm test"}' },
      { type: 'item.delta', sessionId: SID, id: 's2', field: 'output', delta: '> vitest run\n' },
      { type: 'item.delta', sessionId: SID, id: 's2', field: 'output', delta: ' ✓ 12 tests\n' },
    );
    // A patch flushes pending deltas first, so it applies on top of them.
    feed({ type: 'item.patch', sessionId: SID, id: 's2', patch: { status: 'done', result: { exitCode: 0 } } as Partial<TimelineItem> });
    const bash = item<ToolItem>('s2');
    expect(bash.inputText).toBe('{"command":"npm test"}');
    expect(bash.output).toBe('> vitest run\n ✓ 12 tests\n');
    expect(bash.status).toBe('done');
    expect(bash.result).toEqual({ exitCode: 0 });

    // The scheduled frame finds nothing left to write.
    frame();
    expect(item<ToolItem>('s2').output).toBe('> vitest run\n ✓ 12 tests\n');
  });

  it('a delta for an item that is not there is ignored, and re-adding an item replaces it in place', () => {
    feed({ type: 'session.added', session: meta() }, { type: 'item.added', sessionId: SID, item: text });
    feed({ type: 'item.delta', sessionId: SID, id: 'missing', field: 'text', delta: 'x' });
    feed({ type: 'item.delta', sessionId: SID, id: 't1', field: 'text', delta: 'Hello' });
    feed({ type: 'item.added', sessionId: SID, item: { ...text, text: 'Hello world', streaming: false } });
    frame();
    expect(data().roots).toEqual(['t1']);
    expect(item<TextItem>('t1')).toMatchObject({ text: 'Hello world', streaming: false });
    expect(data().items.missing).toBeUndefined();
  });

  it('removes root and child items from their lists', () => {
    feed({ type: 'session.added', session: meta() }, ...[user, agent, subRead, subBash, text].map((i): BridgeEvent => ({ type: 'item.added', sessionId: SID, item: i })));
    feed({ type: 'item.removed', sessionId: SID, id: 's1' }, { type: 'item.removed', sessionId: SID, id: 't1' }, { type: 'item.removed', sessionId: SID, id: 'nope' });
    expect(data().roots).toEqual(['u1', 'a1']);
    expect(data().children.a1).toEqual(['s2']);
    expect(data().items.s1).toBeUndefined();
    expect(data().items.t1).toBeUndefined();
  });

  it('removing a parent removes its descendants too', () => {
    const nested: ToolItem = { ...subRead, id: 'n1', parentId: 's2' };
    feed({ type: 'session.added', session: meta() }, ...[user, agent, subRead, subBash, nested, text].map((i): BridgeEvent => ({ type: 'item.added', sessionId: SID, item: i })));
    feed({ type: 'item.removed', sessionId: SID, id: 'a1' });
    expect(data().roots).toEqual(['u1', 't1']);
    expect(Object.keys(data().items).sort()).toEqual(['t1', 'u1']);
    expect(data().children).toEqual({});
  });

  it('timeline.reset replaces the timeline and drops deltas already buffered', () => {
    feed({ type: 'session.added', session: meta() }, { type: 'item.added', sessionId: SID, item: user }, { type: 'item.added', sessionId: SID, item: text });
    feed({ type: 'item.delta', sessionId: SID, id: 't1', field: 'text', delta: 'stale' });
    const rewound: TimelineItem[] = [
      { ...user, id: 'u0', text: 'earlier' },
      { ...text, id: 't0', text: 'Answer', streaming: false },
      { ...subRead, id: 'c0', parentId: 'x0' },
    ];
    feed({ type: 'timeline.reset', sessionId: SID, items: rewound });
    frame();
    expect(data().roots).toEqual(['u0', 't0']);
    expect(data().children).toEqual({ x0: ['c0'] });
    expect(item<TextItem>('t0').text).toBe('Answer');
    expect(data().items.t1).toBeUndefined();
  });

  it('tracks prompts, todos and suggestions', () => {
    feed({ type: 'session.added', session: meta({ status: 'running' }) });
    feed({ type: 'permission.added', request: permission }, { type: 'question.added', request: question });
    // The same request id again replaces rather than duplicates.
    feed({ type: 'permission.added', request: { ...permission, title: 'Run the tests' } });
    feed({ type: 'session.updated', id: SID, patch: { status: 'awaiting' } });
    expect(data().permissions.map((p) => [p.id, p.title])).toEqual([['p1', 'Run the tests']]);
    expect(data().questions.map((q) => q.id)).toEqual(['q1']);
    expect(S.useStore.getState().sessions[SID].status).toBe('awaiting');

    feed({ type: 'permission.removed', sessionId: SID, id: 'p1' }, { type: 'question.removed', sessionId: SID, id: 'q1' });
    feed({ type: 'session.updated', id: SID, patch: { status: 'running' } });
    expect(data().permissions).toEqual([]);
    expect(data().questions).toEqual([]);

    feed({
      type: 'todos.updated',
      sessionId: SID,
      todos: [
        { content: 'Find expiry checks', status: 'completed' },
        { content: 'Run the test suite', activeForm: 'Running the test suite', status: 'in_progress' },
      ],
    });
    expect(data().todos.map((t) => t.status)).toEqual(['completed', 'in_progress']);

    feed({ type: 'suggestion', sessionId: SID, text: 'Now add a test' });
    expect(data().suggestion).toBe('Now add a test');
    feed({ type: 'suggestion', sessionId: SID, text: '' });
    expect(data().suggestion).toBeUndefined();
  });

  it('events for unknown sessions are ignored and session.removed clears everything', () => {
    feed({ type: 'item.added', sessionId: 'ghost', item: user }, { type: 'session.updated', id: 'ghost', patch: { title: 'x' } });
    expect(S.useStore.getState().data.ghost).toBeUndefined();
    expect(S.useStore.getState().sessions.ghost).toBeUndefined();

    feed({ type: 'session.added', session: meta() }, { type: 'item.added', sessionId: SID, item: user });
    // A second session.added keeps the loaded data.
    feed({ type: 'session.added', session: meta({ title: 'Renamed' }) });
    expect(data().roots).toEqual(['u1']);
    expect(S.useStore.getState().sessions[SID].title).toBe('Renamed');

    feed({ type: 'item.delta', sessionId: SID, id: 'u1', field: 'text', delta: '!' });
    feed({ type: 'session.removed', id: SID });
    frame();
    const st = S.useStore.getState();
    expect(st.sessions[SID]).toBeUndefined();
    expect(st.data[SID]).toBeUndefined();
    expect(st.ui.activeSessionId).toBeNull();
  });

  it('applySnapshot indexes items and keeps known caps', () => {
    feed({ type: 'session.added', session: meta() });
    const caps = { models: [], modes: [], commands: [], features: {} } as never;
    feed({ type: 'session.caps', id: SID, caps });
    S.applySnapshot({ session: meta({ status: 'idle' }), items: [user, agent, subRead], permissions: [permission], questions: [], todos: [], suggestion: 'Next', queue: [{ id: 'q1', text: 'later', createdAt: 1 }] });
    expect(data()).toMatchObject({ loaded: true, roots: ['u1', 'a1'], children: { a1: ['s1'] }, suggestion: 'Next', queue: [{ id: 'q1', text: 'later' }] });
    feed({ type: 'queue.updated', sessionId: SID, queue: [] });
    expect(data().queue).toEqual([]);
    expect(data().permissions).toHaveLength(1);
    expect(data().caps).toBe(caps);
  });
});

describe('capabilities pushed by the bridge', () => {
  it('caps.updated replaces the home composer caps, matching the folder loosely', () => {
    const caps = (id: string) => ({ models: [{ id, name: id }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '/' as const, features: { images: true, thinking: true, rewind: true, steer: true, compact: true, fast: false } });
    S.useStore.setState({ providerCaps: { [S.capsKey('codex', 'D:/work/app', null)]: caps('old') } });
    S.applyEvent({ type: 'caps.updated', provider: 'codex', cwd: 'D:\\work\\app', caps: caps('new') });
    expect(S.useStore.getState().providerCaps[S.capsKey('codex', 'D:/work/app', null)].models[0].id).toBe('new');
    // Another account's entry is left alone.
    S.applyEvent({ type: 'caps.updated', provider: 'codex', accountId: 'acc2', cwd: 'D:/work/app', caps: caps('other') });
    expect(S.useStore.getState().providerCaps[S.capsKey('codex', 'D:/work/app', null)].models[0].id).toBe('new');
    expect(S.useStore.getState().providerCaps[S.capsKey('codex', 'D:/work/app', 'acc2')].models[0].id).toBe('other');
  });
});
