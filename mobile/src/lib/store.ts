import { useSyncExternalStore } from 'react';
import { DEFAULT_ACCOUNT } from '@shared/protocol';
import type {
  AppSettings,
  BridgeEvent,
  Capabilities,
  LimitsReport,
  PermissionRequest,
  PhoneItem,
  PhoneReset,
  PhoneTail,
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
  items: Record<string, PhoneItem>;
  /** Root items in order (no parentId). */
  roots: string[];
  /** Items nested under a tool (sub-agents), by parent id. */
  children: Record<string, string[]>;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  queue: QueuedMessage[];
  todos: Todo[];
  caps?: Capabilities;
  /** Pass to `phone.tail` for the page before the oldest one here; absent once the start is in. */
  cursor?: string;
  /** Shown from the phone's cache while the desktop is asked. */
  cached?: boolean;
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
  /** Another chat started waiting on you while a screen covers home (a line at the top says so). */
  attention?: { id: string; at: number };
  /** The list of chats is there (maybe from the cache, see `fresh`). */
  loaded: boolean;
  /** The list came from the desktop in this run (not only from the cache). */
  fresh?: boolean;
  /** When the whole list last came from the desktop (statuses that changed meanwhile are not news). */
  listAt?: number;
}

// A phone with a list from the last run was paired then: it starts as connecting (not on the pairing screen).
const hadHome = (() => {
  try {
    return !!localStorage.getItem('sable.home');
  } catch {
    return false;
  }
})();

let state: State = { conn: hadHome ? 'connecting' : 'unpaired', providers: {}, projects: [], sessions: {}, data: {}, limits: {}, caps: {}, loaded: false };
const listeners = new Set<() => void>();

export const getState = () => state;

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  if (deferring) return scheduleNotify();
  notifyNow();
}

// Events from the desktop come one per socket message; a burst (many chats at work, a reconnect)
// would render once per message. The state changes at once, the screen once per frame.
let deferring = false;
let notifyFrame = 0;
let notifyTimer = 0;
function notifyNow() {
  if (notifyFrame) cancelAnimationFrame(notifyFrame);
  clearTimeout(notifyTimer);
  notifyFrame = 0;
  notifyTimer = 0;
  for (const l of listeners) l();
}
function scheduleNotify() {
  if (notifyFrame || notifyTimer) return;
  notifyFrame = requestAnimationFrame(notifyNow);
  // No frames while the app is in the background: the notifications watcher still hears it.
  notifyTimer = window.setTimeout(notifyNow, 120);
}

/** Applies a bridge event; listeners hear of it with the next frame. */
export function applyEventSoon(e: BridgeEvent) {
  deferring = true;
  try {
    applyEvent(e);
  } finally {
    deferring = false;
  }
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

// Streamed text arrives in many small pieces: gathered per frame.
const deltas = new Map<string, string>();
let deltaFrame = 0;

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

type Tail = (SessionSnapshot | PhoneTail) & { cursor?: string };

export function applySnapshot(snap: Tail, cached = false) {
  // Streamed pieces still waiting for the next frame are already in the snapshot: adding them again would repeat words.
  for (const key of [...deltas.keys()]) if (key.startsWith(`${snap.session.id}\u0000`)) deltas.delete(key);
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
      [snap.session.id]: {
        items,
        roots,
        children,
        permissions: snap.permissions,
        questions: snap.questions,
        queue: snap.queue,
        todos: snap.todos,
        caps: snap.caps,
        cursor: snap.cursor,
        ...(cached ? { cached: true } : {}),
      },
    },
  });
  if (!cached) saveTailSoon(snap.session.id);
}

/** A streamed text grows on the phone up to this length; the rest is a tap away (`phone.item`). */
const STREAM_CAP = 60_000;


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
      // A text the desktop shortened for the phone does not grow here (it would grow from the wrong place).
      if (!it || it.cut) continue;
      const next = String(it[field] ?? '') + text;
      items[id] = (next.length > STREAM_CAP ? { ...it, [field]: next.slice(0, STREAM_CAP), cut: true } : { ...it, [field]: next }) as unknown as TimelineItem;
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
        const items = { ...d.items, [e.item.id]: e.item };
        const next: Partial<SessionData> = { items };
        const pid = e.item.parentId;
        if (pid) {
          next.children = { ...d.children, [pid]: [...(d.children[pid] ?? []), e.item.id] };
          // The parent's count of nested steps (the desktop's count when the page came, then live).
          const parent = d.items[pid] as PhoneItem | undefined;
          if (parent) items[pid] = { ...parent, kids: (parent.kids ?? 0) + 1 };
        } else next.roots = [...d.roots, e.item.id];
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
      const r = e as unknown as PhoneReset;
      if (s && d) applySnapshot({ session: s, items: r.items, cursor: r.cursor, caps: d.caps, permissions: d.permissions, questions: d.questions, todos: d.todos, queue: d.queue });
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
  setState({ sessions, providers, projects: hello.projects, settings: hello.settings, version: hello.version, desktop: conn.pairing?.desktop, loaded: true, fresh: true, listAt: Date.now() });
  saveHome();
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

/** A desktop from before pages answers only `session.snapshot` (all of it). */
let pages = true;

/** Opens a conversation on its newest page (from the cache at once when the phone has it, then from the desktop). */
export async function openSession(id: string) {
  showCached(id);
  let snap: Tail | undefined;
  if (pages) {
    try {
      snap = await conn.call('phone.tail', { sessionId: id });
    } catch (err) {
      if (!/Not available from the phone/.test((err as Error).message)) throw err;
      pages = false;
    }
  }
  snap ??= await conn.call('session.snapshot', { sessionId: id });
  applySnapshot(snap);
}

const opensTurn = (it: TimelineItem | undefined) => it?.type === 'user' && !it.steered;

/**
 * The pages before the oldest one shown, newest first, back to the message that opened the
 * oldest turn (a long turn's steps fold into one line, so one page of them would show nothing
 * new). Empty when the start is in. Apply each with `applyOlder`, in order.
 */
export async function fetchOlder(id: string, maxPages = 12): Promise<{ before: string; page: PhoneTail }[]> {
  const d = state.data[id];
  if (!d?.cursor || !pages || d.cached) return [];
  const out: { before: string; page: PhoneTail }[] = [];
  let before: string | undefined = d.cursor;
  while (before && out.length < maxPages) {
    const page: PhoneTail = await conn.call('phone.tail', { sessionId: id, before });
    out.push({ before, page });
    if (!page.items.length || opensTurn(page.items[0])) break;
    before = page.cursor;
  }
  return out;
}

/** Puts an older page in front of what is shown (only when nothing moved the start meanwhile). */
export function applyOlder(id: string, older: { before: string; page: PhoneTail }) {
  const d = state.data[id];
  if (!d || d.cursor !== older.before) return;
  const items = { ...d.items };
  const add: string[] = [];
  for (const it of older.page.items) {
    if (items[it.id]) continue;
    items[it.id] = it;
    add.push(it.id);
  }
  setState({ data: { ...state.data, [id]: { ...d, items, roots: [...add, ...d.roots], cursor: older.page.cursor } } });
}

const capsAsked = new Set<string>();

/**
 * What an agent offers in a folder (models, modes, efforts), for a chat whose agent is not running
 * (it has no caps of its own until it starts): asked once per agent and folder, as the desktop does.
 */
export function ensureFolderCaps(provider: ProviderId, cwd: string, accountId?: string) {
  const key = `${provider}:${cwd}`;
  if (state.caps[key] || capsAsked.has(key) || state.conn !== 'open') return;
  capsAsked.add(key);
  void conn
    .call('provider.caps', { provider, cwd, ...(accountId && accountId !== DEFAULT_ACCOUNT ? { accountId } : {}) })
    .then((c) => setState((st) => ({ caps: { ...st.caps, [key]: c } })))
    .catch(() => capsAsked.delete(key));
}

/** One item with more of it (a step's output, a long text in full) and the last steps nested under it. */
export function fetchItem(sid: string, itemId: string) {
  return conn.call('phone.item', { sessionId: sid, itemId });
}

/** A sub-agent's last steps, from `phone.item`, merged with those that arrived live. */
export function applyChildren(sid: string, parentId: string, list: PhoneItem[]) {
  patchData(sid, (d) => {
    const items = { ...d.items };
    const have = d.children[parentId] ?? [];
    const add: string[] = [];
    for (const c of list) {
      if (!items[c.id]) add.push(c.id);
      items[c.id] = c;
    }
    return { items, children: { ...d.children, [parentId]: [...add, ...have] } };
  });
}

/** Replaces a shortened text with the whole of it. */
export function applyFull(sid: string, item: PhoneItem) {
  patchData(sid, (d) => (d.items[item.id] ? { items: { ...d.items, [item.id]: { ...d.items[item.id], ...item, cut: false } as PhoneItem } } : {}));
}

export function closeSessionData(id: string) {
  if (!state.data[id]) return;
  saveTail(id);
  const data = { ...state.data };
  delete data[id];
  setState({ data });
}

export const sessionData = (s: State, id: string): SessionData => s.data[id] ?? EMPTY;

conn.on(applyEventSoon);
conn.onState(() => {
  if (conn.state === 'unpaired') clearCache();
  setState({ conn: conn.state, connError: conn.error, desktop: conn.pairing?.desktop ?? state.desktop });
});

// ── the phone's cache: the list of chats and the newest page of the last chats opened ──
// Shown at once at the next start (Android closes apps in the background), then refreshed.

const HOME = 'sable.home';
const TAILS = 'sable.tails';
const TAIL = (id: string) => `sable.tail.${id}`;
const TAIL_KEEP = 6;
const TAIL_ROOTS = 60;

function saveHome() {
  try {
    const { sessions, providers, projects, settings, version } = state;
    localStorage.setItem(HOME, JSON.stringify({ desktop: conn.pairing?.desktop, sessions: Object.values(sessions), providers, projects, settings, version }));
  } catch {
    /* full or unavailable: the next start asks the desktop */
  }
}

/** True when the list from the last run is there to show at once (read synchronously, before the pairing). */
export const hasCachedHome = () => hadHome;

/** The list of chats from the last run, before the desktop answers. */
export function loadCachedHome() {
  try {
    const raw = localStorage.getItem(HOME);
    if (!raw || state.fresh) return;
    const c = JSON.parse(raw) as { desktop?: string; sessions: SessionMeta[]; providers: State['providers']; projects: Project[]; settings?: AppSettings; version?: string };
    const sessions: Record<string, SessionMeta> = {};
    for (const s of c.sessions) sessions[s.id] = s;
    setState({ sessions, providers: c.providers ?? {}, projects: c.projects ?? [], settings: c.settings, version: c.version, desktop: c.desktop, loaded: true });
  } catch {
    /* a broken cache is ignored */
  }
}

function saveTail(id: string) {
  const d = state.data[id];
  const s = state.sessions[id];
  if (!d || !s || d.cached) return;
  try {
    const roots = d.roots.slice(-TAIL_ROOTS);
    const items = roots.map((r) => d.items[r]).filter(Boolean);
    const cursor = roots.length < d.roots.length ? roots[0] : d.cursor;
    localStorage.setItem(TAIL(id), JSON.stringify({ session: s, items, cursor, permissions: [], questions: [], todos: d.todos, queue: [], caps: d.caps }));
    const ids = [id, ...(JSON.parse(localStorage.getItem(TAILS) ?? '[]') as string[]).filter((x) => x !== id)];
    for (const old of ids.slice(TAIL_KEEP)) localStorage.removeItem(TAIL(old));
    localStorage.setItem(TAILS, JSON.stringify(ids.slice(0, TAIL_KEEP)));
  } catch {
    /* full: nothing cached */
  }
}

const tailTimers = new Map<string, number>();
function saveTailSoon(id: string) {
  clearTimeout(tailTimers.get(id));
  tailTimers.set(
    id,
    window.setTimeout(() => {
      tailTimers.delete(id);
      saveTail(id);
    }, 4000),
  );
}

/** The newest page of a chat as the phone last had it, until the desktop answers. */
export function showCached(id: string) {
  if (state.data[id]) return;
  try {
    const raw = localStorage.getItem(TAIL(id));
    if (raw) applySnapshot(JSON.parse(raw) as Tail, true);
  } catch {
    /* ignored */
  }
}

/** Forgets what the phone kept of the desktop (after "Forget this computer"). */
export function clearCache() {
  try {
    for (const id of JSON.parse(localStorage.getItem(TAILS) ?? '[]') as string[]) localStorage.removeItem(TAIL(id));
    localStorage.removeItem(TAILS);
    localStorage.removeItem(HOME);
  } catch {
    /* ignored */
  }
}

let homeTimer = 0;
let savedSessions: State['sessions'] | undefined;
subscribe(() => {
  if (!state.fresh || state.sessions === savedSessions) return;
  savedSessions = state.sessions;
  clearTimeout(homeTimer);
  homeTimer = window.setTimeout(saveHome, 3000);
});
