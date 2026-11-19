/**
 * The triage deck: what waits across sessions and in which order, how the stack moves, which key
 * does what, and how prompts of sessions the window never loaded reach the store.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionOption, PermissionRequest, QuestionRequest, SessionMeta, UserItem } from '@shared/protocol';
import { deckAction, deckKeyAllowed, deckReducer, emptyDeck, exitOf, optionKeys, type DeckState } from '../src/features/triage/deck';
import { collectPending, selectPending, selectWaitingCount } from '../src/state/pending';
import type { SessionData } from '../src/state/store';

// The store module touches the browser at import: minimal shims first (as in store.test.ts).
const g = globalThis as Record<string, unknown>;
g.requestAnimationFrame ??= () => 0;
g.cancelAnimationFrame ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.document ??= { hidden: false };
g.window ??= globalThis;

type StoreModule = typeof import('../src/state/store');
let S: StoreModule;
beforeAll(async () => {
  S = await import('../src/state/store');
});

const meta = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  provider: 'demo',
  cwd: `/work/${id}`,
  title: id,
  titleSource: 'auto',
  model: 'demo-large',
  mode: 'default',
  status: 'awaiting',
  createdAt: 1,
  updatedAt: 1,
  usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  ...patch,
});

const perm = (id: string, sessionId: string, createdAt: number, options?: PermissionOption[]): PermissionRequest => ({
  id,
  sessionId,
  toolName: 'Bash',
  kind: 'bash',
  title: 'npm test',
  detail: { command: 'npm test' },
  options: options ?? [
    { id: 'allow', label: 'Allow once', tone: 'allow' },
    { id: 'always', label: 'Always allow npm test', tone: 'always' },
    { id: 'deny', label: 'Deny', tone: 'deny' },
  ],
  createdAt,
});
const ask = (id: string, sessionId: string, createdAt: number): QuestionRequest => ({ id, sessionId, questions: [{ question: 'Which logger?', options: [{ label: 'pino' }, { label: 'winston' }] }], createdAt });

const blank = (patch: Partial<SessionData> = {}): SessionData => ({ loaded: true, items: {}, roots: [], children: {}, permissions: [], questions: [], todos: [], queue: [], ...patch });

describe('what waits, across sessions', () => {
  const sessions = { a: meta('a'), b: meta('b'), c: meta('c') };

  it('lists every permission and question oldest first, and leaves out sessions the window no longer knows', () => {
    const data = {
      a: blank({ permissions: [perm('p-a', 'a', 30)] }),
      b: blank({ questions: [ask('q-b', 'b', 10)], permissions: [perm('p-b', 'b', 20)] }),
      ghost: blank({ permissions: [perm('p-x', 'ghost', 1)] }),
      c: blank(),
    };
    const list = collectPending(data, sessions);
    expect(list.map((p) => p.key)).toEqual(['question:q-b', 'permission:p-b', 'permission:p-a']);
    expect(list[0]).toMatchObject({ kind: 'question', sessionId: 'b', since: 10 });
  });

  it('keeps a stable order for prompts asked at the same moment (session, then permission before question)', () => {
    const data = { a: blank({ questions: [ask('q', 'a', 5)], permissions: [perm('p', 'a', 5)] }), b: blank({ permissions: [perm('p2', 'b', 5)] }) };
    expect(collectPending(data, sessions).map((p) => p.key)).toEqual(['permission:p', 'question:q', 'permission:p2']);
  });

  it('hands back the same list while no prompt changed, however often the store changes', () => {
    const permissions = [perm('p', 'a', 1)];
    const s1 = { sessions, data: { a: blank({ permissions }), b: blank() } };
    const first = selectPending(s1);
    // Streaming replaces data and the other entries every frame; the prompts stay the same arrays.
    const s2 = { sessions, data: { a: { ...s1.data.a, items: { x: {} as never } }, b: blank() } };
    expect(selectPending(s2)).toBe(first);
    const s3 = { sessions, data: { ...s2.data, b: blank({ questions: [ask('q', 'b', 2)] }) } };
    expect(selectPending(s3)).not.toBe(first);
    expect(selectPending(s3).map((p) => p.key)).toEqual(['permission:p', 'question:q']);
  });

  it('counts for the top bar only while something waits outside the open session', () => {
    const ui = (activeSessionId: string | null) => ({ activeSessionId }) as never;
    const data = { a: blank({ permissions: [perm('p', 'a', 1), perm('p2', 'a', 2)] }) };
    expect(selectWaitingCount({ sessions, data, ui: ui('a') })).toBe(0);
    expect(selectWaitingCount({ sessions, data, ui: ui(null) })).toBe(2);
    expect(selectWaitingCount({ sessions, data: { ...data, b: blank({ questions: [ask('q', 'b', 3)] }) }, ui: ui('a') })).toBe(3);
  });
});

describe('the stack', () => {
  const run = (s: DeckState, ...events: Parameters<typeof deckReducer>[1][]) => events.reduce(deckReducer, s);

  it('keeps its order while open: a new prompt joins at the back, one answered elsewhere leaves', () => {
    let s = emptyDeck(['p1', 'p2']);
    s = run(s, { type: 'next' });
    expect(s.order).toEqual(['p2', 'p1']);
    // A new prompt is the newest: at the back, whatever the deck's own order.
    s = run(s, { type: 'sync', keys: ['p1', 'p2', 'p3'] });
    expect(s.order).toEqual(['p2', 'p1', 'p3']);
    s = run(s, { type: 'sync', keys: ['p1', 'p3'] });
    expect(s.order).toEqual(['p1', 'p3']);
    // Nothing changed: the same state back (no render).
    expect(deckReducer(s, { type: 'sync', keys: ['p1', 'p3'] })).toBe(s);
  });

  it('moves the front card to the back and the back card to the front', () => {
    const s = emptyDeck(['a', 'b', 'c']);
    expect(run(s, { type: 'next' }).order).toEqual(['b', 'c', 'a']);
    expect(run(s, { type: 'prev' }).order).toEqual(['c', 'a', 'b']);
    expect(run(s, { type: 'next' }, { type: 'prev' }).order).toEqual(['a', 'b', 'c']);
    const one = emptyDeck(['a']);
    expect(run(one, { type: 'next' })).toBe(one);
  });

  it('an answered card leaves at once, does not come back before the bridge confirms, and keeps how it left', () => {
    let s = emptyDeck(['a', 'b']);
    s = run(s, { type: 'answer', key: 'a', exit: 'allow' });
    expect(s.order).toEqual(['b']);
    expect(s.answered).toBe(1);
    // The bridge has not dropped it yet: still listed, still not back in the stack.
    s = run(s, { type: 'sync', keys: ['a', 'b'] });
    expect(s.order).toEqual(['b']);
    // Confirmed: it keeps its exit, so a card still flying off keeps its path.
    s = run(s, { type: 'sync', keys: ['b'] });
    expect(exitOf(s, 'a', new Set(['b']))).toBe('allow');
    s = run(s, { type: 'answer', key: 'b', exit: 'deny' });
    expect(s).toMatchObject({ order: [], answered: 2 });
    // Answering a card that is not there changes nothing.
    expect(run(s, { type: 'answer', key: 'zzz', exit: 'deny' })).toBe(s);
  });

  it('tells how a card that is no longer drawn left', () => {
    const s = run(emptyDeck(['a', 'b', 'c', 'd']), { type: 'answer', key: 'a', exit: 'deny' });
    expect(exitOf(s, 'a', new Set(['a', 'b', 'c', 'd']))).toBe('deny');
    // Still waiting but beyond the drawn cards: sent to the back.
    expect(exitOf(s, 'd', new Set(['b', 'c', 'd']))).toBe('back');
    // Gone without an answer here: answered elsewhere.
    expect(exitOf(s, 'c', new Set(['b', 'd']))).toBe('away');
  });
});

describe('keys', () => {
  const k = (key: string, mods: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) => ({ key, ...mods });

  it('answers a permission: Enter allows once, Shift+Enter always, D denies, digits by position', () => {
    expect(deckAction(k('Enter'), 'permission')).toEqual({ type: 'allow' });
    expect(deckAction(k('Enter', { shiftKey: true }), 'permission')).toEqual({ type: 'always' });
    expect(deckAction(k('d'), 'permission')).toEqual({ type: 'deny' });
    expect(deckAction(k('D'), 'permission')).toEqual({ type: 'deny' });
    expect(deckAction(k('3'), 'permission')).toEqual({ type: 'pick', index: 2 });
    expect(deckAction(k('s'), 'permission')).toBeNull();
    expect(deckAction(k('ArrowRight'), 'permission')).toBeNull();
  });

  it('answers a question: digits pick, Enter goes on or sends, S skips, arrows step between its parts', () => {
    expect(deckAction(k('1'), 'question')).toEqual({ type: 'pick', index: 0 });
    expect(deckAction(k('Enter'), 'question')).toEqual({ type: 'advance' });
    expect(deckAction(k('Enter', { shiftKey: true }), 'question')).toBeNull();
    expect(deckAction(k('s'), 'question')).toEqual({ type: 'skip' });
    expect(deckAction(k('d'), 'question')).toBeNull();
    expect(deckAction(k('ArrowRight'), 'question')).toEqual({ type: 'step', by: 1 });
    expect(deckAction(k('ArrowLeft'), 'question')).toEqual({ type: 'step', by: -1 });
  });

  it('moves between cards with J and K or the arrows, O opens the chat, Escape closes', () => {
    for (const kind of ['permission', 'question'] as const) {
      expect(deckAction(k('j'), kind)).toEqual({ type: 'next' });
      expect(deckAction(k('ArrowDown'), kind)).toEqual({ type: 'next' });
      expect(deckAction(k('k'), kind)).toEqual({ type: 'prev' });
      expect(deckAction(k('ArrowUp'), kind)).toEqual({ type: 'prev' });
      expect(deckAction(k('o'), kind)).toEqual({ type: 'open' });
    }
    expect(deckAction(k('Escape'), null)).toEqual({ type: 'close' });
    // An empty deck takes nothing else.
    expect(deckAction(k('Enter'), null)).toBeNull();
    expect(deckAction(k('j'), null)).toBeNull();
  });

  it('leaves shortcuts with Ctrl, Alt or the command key to the app (Ctrl+I closes the deck)', () => {
    expect(deckAction(k('i', { ctrlKey: true }), 'permission')).toBeNull();
    expect(deckAction(k('Enter', { ctrlKey: true }), 'permission')).toBeNull();
    expect(deckAction(k('d', { metaKey: true }), 'permission')).toBeNull();
    expect(deckAction(k('1', { altKey: true }), 'question')).toBeNull();
  });

  it('takes no held key, no key while composing or typing in a field, and leaves Enter to a focused button', () => {
    const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra }) as unknown as EventTarget;
    expect(deckKeyAllowed({ key: 'Enter' })).toBe(true);
    expect(deckKeyAllowed({ key: 'Enter', target: el('DIV') })).toBe(true);
    // A held Enter must not approve card after card.
    expect(deckKeyAllowed({ key: 'Enter', repeat: true })).toBe(false);
    expect(deckKeyAllowed({ key: 'd', isComposing: true })).toBe(false);
    expect(deckKeyAllowed({ key: 'd', defaultPrevented: true })).toBe(false);
    expect(deckKeyAllowed({ key: 'd', target: el('INPUT') })).toBe(false);
    expect(deckKeyAllowed({ key: '1', target: el('TEXTAREA') })).toBe(false);
    expect(deckKeyAllowed({ key: 'j', target: el('DIV', { isContentEditable: true }) })).toBe(false);
    expect(deckKeyAllowed({ key: 'Enter', target: el('BUTTON') })).toBe(false);
    expect(deckKeyAllowed({ key: ' ', target: el('BUTTON') })).toBe(false);
    expect(deckKeyAllowed({ key: 'd', target: el('BUTTON') })).toBe(true);
  });

  it('finds the answer for each key whatever the agent offers', () => {
    // Claude and the Demo agent: allow, always, deny.
    const claude = optionKeys(perm('p', 'a', 1).options);
    expect([claude.allow?.id, claude.always?.id, claude.deny?.id]).toEqual(['allow', 'always', 'deny']);
    expect(claude.hints).toEqual(['↵', '⇧↵', 'D']);
    // Codex: two "always" and two deny answers; the extra ones keep their number.
    const codex = optionKeys([
      { id: 'accept', label: 'Allow once', tone: 'allow' },
      { id: 'acceptForSession', label: 'Allow for this session', tone: 'always' },
      { id: 'amend', label: 'Always allow “npm test”', tone: 'always' },
      { id: 'decline', label: 'Decline', tone: 'deny' },
      { id: 'cancel', label: 'Decline and stop', tone: 'deny' },
    ]);
    expect([codex.allow?.id, codex.always?.id, codex.deny?.id]).toEqual(['accept', 'acceptForSession', 'decline']);
    expect(codex.hints).toEqual(['↵', '⇧↵', '3', 'D', '5']);
    // A plan: "always" first, the plain approval is Enter.
    const plan = optionKeys([
      { id: 'plan-auto', label: 'Approve and accept edits', tone: 'always' },
      { id: 'plan-ask', label: 'Approve, ask before edits', tone: 'allow' },
      { id: 'deny', label: 'Keep planning', tone: 'deny' },
    ]);
    expect(plan.hints).toEqual(['⇧↵', '↵', 'D']);
    // No allow answer at all: Enter takes the first that is not a denial, never a denial.
    const noAllow = optionKeys([
      { id: 'deny', label: 'Deny', tone: 'deny' },
      { id: 'always', label: 'Always', tone: 'always' },
    ]);
    expect(noAllow.allow?.id).toBe('always');
    expect(noAllow.always).toBeUndefined();
    expect(optionKeys([{ id: 'deny', label: 'Deny', tone: 'deny' }]).allow).toBeUndefined();
  });
});

describe('prompts of sessions this window never loaded', () => {
  const st = () => S.useStore.getState();
  const user: UserItem = { id: 'u1', ts: 2, type: 'user', text: 'hi', state: 'sent' };

  beforeEach(() => {
    S.useStore.setState({ sessions: { a: meta('a'), b: meta('b') }, data: {}, ui: { ...st().ui, activeSessionId: null } });
  });

  it('a prompt for a known session without view state is kept on its own (not as a timeline)', () => {
    S.applyEvent({ type: 'permission.added', request: perm('p', 'a', 5) });
    expect(st().data.a).toMatchObject({ loaded: false, roots: [], permissions: [{ id: 'p' }] });
    // Timeline events still wait for the snapshot that loads it.
    S.applyEvent({ type: 'item.added', sessionId: 'a', item: user });
    S.applyEvent({ type: 'todos.updated', sessionId: 'a', todos: [{ content: 'x', status: 'pending' }] });
    expect(st().data.a.roots).toEqual([]);
    expect(st().data.a.todos).toEqual([]);
    S.applyEvent({ type: 'question.added', request: ask('q', 'a', 6) });
    S.applyEvent({ type: 'permission.removed', sessionId: 'a', id: 'p' });
    expect(st().data.a).toMatchObject({ loaded: false, permissions: [], questions: [{ id: 'q' }] });
    // Unknown sessions and unknown prompts change nothing.
    const before = st().data;
    S.applyEvent({ type: 'permission.added', request: perm('x', 'ghost', 1) });
    S.applyEvent({ type: 'question.removed', sessionId: 'b', id: 'nope' });
    expect(st().data).toBe(before);
    // Opening it later replaces the entry with the full snapshot.
    S.applySnapshot({ session: meta('a'), items: [user], permissions: [], questions: [ask('q', 'a', 6)], todos: [], queue: [] });
    expect(st().data.a).toMatchObject({ loaded: true, roots: ['u1'], questions: [{ id: 'q' }] });
  });

  it("app.hello's list replaces what each session held and adds sessions not loaded yet", () => {
    const keep = [perm('p1', 'a', 1)];
    const data = { a: blank({ permissions: keep }), b: blank({ questions: [ask('stale', 'b', 2)] }) };
    const next = S.withPrompts(data, { permissions: [perm('p1', 'a', 1), perm('p9', 'c', 9)], questions: [] }, { a: meta('a'), b: meta('b'), c: meta('c') });
    // Unchanged prompts keep their entry (no re-render), stale ones go, new sessions come in unloaded.
    expect(next.a).toBe(data.a);
    expect(next.b.questions).toEqual([]);
    expect(next.c).toMatchObject({ loaded: false, permissions: [{ id: 'p9' }] });
    // Nothing to change: the same object back.
    expect(S.withPrompts(next, { permissions: [perm('p1', 'a', 1), perm('p9', 'c', 9)], questions: [] }, { a: meta('a'), b: meta('b'), c: meta('c') })).toBe(next);
    // A prompt of a session the window does not know is left out.
    expect(S.withPrompts({}, { permissions: [perm('x', 'ghost', 1)], questions: [] }, {})).toEqual({});
  });
});
