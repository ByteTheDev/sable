import { useSyncExternalStore } from 'react';
import type {
  AppSettings,
  BridgeEvent,
  Capabilities,
  LimitsReport,
  PermissionRequest,
  Project,
  ProviderId,
  ProviderInfo,
  QuestionRequest,
  QueuedMessage,
  SessionMeta,
  SessionSnapshot,
  TimelineItem,
  Todo,
} from '@shared/protocol';
import { conn, type ConnState } from './conn';

/**
 * The phone's view of the desktop: sessions, folders, accounts and the open conversations, kept
 * current from the bridge's events. A tiny external store: each component subscribes with a
 * selector and re-renders only when what it selected changed (items are replaced, never mutated).
 */

export interface SessionData {
  items: Record<string, TimelineItem>;
  /** Root items in order (no parentId). */
  roots: string[];
  /** Items nested under a tool (sub-agents), by parent id. */
  children: Record<string, string[]>;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  queue: QueuedMessage[];
  todos: Todo[];
  caps?: Capabilities;
}

export interface State {
  conn: ConnState;
  connError?: string;
  desktop?: string;
  version?: string;
  providers: Partial<Record<ProviderId, ProviderInfo>>;
  projects: Project[];
  sessions: Record<string, SessionMeta>;
  settings?: AppSettings;
  data: Record<string, SessionData>;
  limits: Record<string, LimitsReport>;
  /** Capabilities for new chats, by `provider:cwd`. */
  caps: Record<string, Capabilities>;
  /** A message from the desktop to show once. */
  toast?: { text: string; level: 'info' | 'success' | 'error'; at: number };
  loaded: boolean;
}

let state: State = { conn: 'unpaired', providers: {}, projects: [], sessions: {}, data: {}, limits: {}, caps: {}, loaded: false };
const listeners = new Set<() => void>();

export const getState = () => state;

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Runs `l` after every change (outside React). */
export const subscribeStore = subscribe;

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

const EMPTY: SessionData = { items: {}, roots: [], children: {}, permissions: [], questions: [], queue: [], todos: [] };

function patchData(id: string, fn: (d: SessionData) => Partial<SessionData>) {
  const d = state.data[id];
  if (!d) return; // not open on the phone: the snapshot brings it when it is
  const p = fn(d);
  if (!Object.keys(p).length) return;
  setState({ data: { ...state.data, [id]: { ...d, ...p } } });
}

function patchSession(id: string, patch: Partial<SessionMeta>) {
  const s = state.sessions[id];
  if (!s) return;
  setState({ sessions: { ...state.sessions, [id]: { ...s, ...patch } } });
}

export function applySnapshot(snap: SessionSnapshot) {
  const items: Record<string, TimelineItem> = {};
  const roots: string[] = [];
  const children: Record<string, string[]> = {};
  for (const it of snap.items) {
    items[it.id] = it;
    if (it.parentId) (children[it.parentId] ??= []).push(it.id);
    else roots.push(it.id);
  }
  setState({
    sessions: { ...state.sessions, [snap.session.id]: snap.session },
    data: {
      ...state.data,
      [snap.session.id]: { items, roots, children, permissions: snap.permissions, questions: snap.questions, queue: snap.queue, todos: snap.todos, caps: snap.caps },
    },
  });
}

// Streamed text arrives in many small pieces: gathered per frame.
const deltas = new Map<string, string>();
let deltaFrame = 0;

function flushDeltas() {
  if (deltaFrame) cancelAnimationFrame(deltaFrame);
  deltaFrame = 0;
  if (!deltas.size) return;
  const bySession = new Map<string, [string, string, string][]>();
  for (const [key, text] of deltas) {
    const [sid, id, field] = key.split('\u0000');
    let list = bySession.get(sid);
    if (!list) bySession.set(sid, (list = []));
    list.push([id, field, text]);
  }
  deltas.clear();
  const data = { ...state.data };
  for (const [sid, list] of bySession) {
    const d = data[sid];
    if (!d) continue;
    const items = { ...d.items };
    for (const [id, field, text] of list) {
      const it = items[id] as unknown as Record<string, unknown> | undefined;
      if (!it) continue;
      items[id] = { ...it, [field]: String(it[field] ?? '') + text } as unknown as TimelineItem;
    }
    data[sid] = { ...d, items };
  }
  setState({ data });
}

function removeTree(d: SessionData, id: string): Partial<SessionData> {
  const items = { ...d.items };
  const children = { ...d.children };
  const drop = (x: string) => {
    for (const c of children[x] ?? []) drop(c);
    delete children[x];
    delete items[x];
  };
  const it = d.items[id];
  drop(id);
  if (it?.parentId && children[it.parentId]) children[it.parentId] = children[it.parentId].filter((c) => c !== id);
  return { items, children, roots: d.roots.filter((r) => r !== id) };
}

export function applyEvent(e: BridgeEvent) {
  switch (e.type) {
    case 'item.delta': {
      deltas.set(`${e.sessionId}\u0000${e.id}\u0000${e.field}`, (deltas.get(`${e.sessionId}\u0000${e.id}\u0000${e.field}`) ?? '') + e.delta);
      if (!deltaFrame) deltaFrame = requestAnimationFrame(flushDeltas);
      return;
    }
    case 'item.added':
      flushDeltas();
      return patchData(e.sessionId, (d) => {
        if (d.items[e.item.id]) return { items: { ...d.items, [e.item.id]: e.item } };
        const next: Partial<SessionData> = { items: { ...d.items, [e.item.id]: e.item } };
        if (e.item.parentId) next.children = { ...d.children, [e.item.parentId]: [...(d.children[e.item.parentId] ?? []), e.item.id] };
        else next.roots = [...d.roots, e.item.id];
        return next;
      });
    case 'item.patch':
      flushDeltas();
      return patchData(e.sessionId, (d) => {
        const it = d.items[e.id];
        return it ? { items: { ...d.items, [e.id]: { ...it, ...e.patch } as TimelineItem } } : {};
      });
    case 'item.removed':
      return patchData(e.sessionId, (d) => removeTree(d, e.id));
    case 'timeline.reset': {
      const s = state.sessions[e.sessionId];
      const d = state.data[e.sessionId];
      if (s && d) applySnapshot({ session: s, items: e.items, caps: d.caps, permissions: d.permissions, questions: d.questions, todos: d.todos, queue: d.queue });
      return;
    }
    case 'session.added':
      return setState({ sessions: { ...state.sessions, [e.session.id]: e.session } });
    case 'session.updated':
      return patchSession(e.id, e.patch);
    case 'session.removed': {
      const sessions = { ...state.sessions };
      delete sessions[e.id];
      const data = { ...state.data };
      delete data[e.id];
      return setState({ sessions, data });
    }
    case 'session.caps':
      return patchData(e.id, () => ({ caps: e.caps }));
    case 'permission.added':
      return patchData(e.request.sessionId, (d) => ({ permissions: [...d.permissions.filter((p) => p.id !== e.request.id), e.request] }));
    case 'permission.removed':
      return patchData(e.sessionId, (d) => ({ permissions: d.permissions.filter((p) => p.id !== e.id) }));
    case 'question.added':
      return patchData(e.request.sessionId, (d) => ({ questions: [...d.questions.filter((q) => q.id !== e.request.id), e.request] }));
    case 'question.removed':
      return patchData(e.sessionId, (d) => ({ questions: d.questions.filter((q) => q.id !== e.id) }));
    case 'todos.updated':
      return patchData(e.sessionId, () => ({ todos: e.todos }));
    case 'queue.updated':
      return patchData(e.sessionId, () => ({ queue: e.queue }));
    case 'provider.updated':
      return setState({ providers: { ...state.providers, [e.provider.id]: e.provider } });
    case 'projects.updated':
      return setState({ projects: e.projects });
    case 'settings.updated':
      return setState({ settings: e.settings });
    case 'limits.report':
      return setState({ limits: { ...state.limits, [`${e.report.provider}:${e.report.accountId}`]: e.report } });
    case 'caps.updated':
      if (e.accountId) return;
      return setState({ caps: { ...state.caps, [`${e.provider}:${e.cwd ?? ''}`]: e.caps } });
    case 'toast':
      return setState({ toast: { text: e.text, level: e.level, at: Date.now() } });
    default:
      return;
  }
}

/** Loads everything the phone shows after each (re)connect, and the open conversations again. */
export async function refresh(openIds: string[]) {
  const hello = await conn.call('app.hello', {});
  const sessions: Record<string, SessionMeta> = {};
  for (const s of hello.sessions) sessions[s.id] = s;
  const providers: State['providers'] = {};
  for (const p of hello.providers) providers[p.id] = p;
  setState({ sessions, providers, projects: hello.projects, settings: hello.settings, version: hello.version, desktop: conn.pairing?.desktop, loaded: true });
  void conn
    .call('usage.limits', {})
    .then((reports) => {
      const limits: State['limits'] = {};
      for (const r of reports) limits[`${r.provider}:${r.accountId}`] = r;
      setState({ limits });
    })
    .catch(() => {});
  await Promise.all(openIds.filter((id) => sessions[id]).map((id) => openSession(id).catch(() => {})));
}

export async function openSession(id: string) {
  const snap = await conn.call('session.snapshot', { sessionId: id });
  applySnapshot(snap);
}

export function closeSessionData(id: string) {
  if (!state.data[id]) return;
  const data = { ...state.data };
  delete data[id];
  setState({ data });
}

export const sessionData = (s: State, id: string): SessionData => s.data[id] ?? EMPTY;

conn.on(applyEvent);
conn.onState(() => setState({ conn: conn.state, connError: conn.error, desktop: conn.pairing?.desktop ?? state.desktop }));
