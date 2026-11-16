import { create } from 'zustand';
import type {
  AppSettings,
  Attachment,
  BackdropConfig,
  BridgeEvent,
  Capabilities,
  Effort,
  PermissionRequest,
  Project,
  ProviderId,
  QueuedMessage,
  ProviderInfo,
  QuestionRequest,
  LimitsReport,
  RateLimit,
  SessionMeta,
  SessionSnapshot,
  TimelineItem,
  Todo,
} from '@shared/protocol';
import { DEFAULT_ACCOUNT, DEFAULT_SETTINGS } from '@shared/protocol';
import { bridge, type ConnStatus } from '@/lib/bridge';

/**
 * Key for per-account state (`limits`, `auth`): the bare provider id for the built-in default
 * account, so `limits[provider]` and `auth[provider]` keep meaning what they always did.
 */
export const accountKey = (provider: ProviderId, accountId?: string | null) =>
  !accountId || accountId === DEFAULT_ACCOUNT ? provider : `${provider}:${accountId}`;

/** Per-session view state, rebuilt from a snapshot and kept current by events. */
export interface SessionData {
  loaded: boolean;
  items: Record<string, TimelineItem>;
  /** Top-level item ids in order. */
  roots: string[];
  /** Sub-agent item ids by parent tool id. */
  children: Record<string, string[]>;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  todos: Todo[];
  suggestion?: string;
  caps?: Capabilities;
  /** Messages the bridge holds until the running turn ends. */
  queue: QueuedMessage[];
}

export type RailTab = 'changes' | 'files' | 'browser' | 'terminal' | 'tasks' | 'context' | 'agents';
export type SettingsSection = 'general' | 'appearance' | 'accounts' | 'usage' | 'models' | 'permissions' | 'mcp' | 'hooks' | 'skills' | 'agents' | 'memory' | 'shortcuts' | 'about';

export interface AuthFlow {
  state: 'started' | 'url' | 'done' | 'error' | 'cancelled' | 'timeout';
  url?: string;
  message?: string;
}

export interface Toast {
  id: number;
  level: 'info' | 'success' | 'error';
  text: string;
}

export interface Draft {
  text: string;
  attachments: Attachment[];
}

interface Ui {
  activeSessionId: string | null;
  sidebarOpen: boolean;
  railOpen: boolean;
  railTab: RailTab;
  railFile?: string;
  /** A page the panel's Browser tab should open (it clears this once taken). */
  browserUrl?: string;
  paletteOpen: boolean;
  settings: SettingsSection | null;
  projectPicker: boolean;
  historyOpen: boolean;
  shortcutsOpen: boolean;
  /** A shell command waiting to be run by the panel's terminal (set by "!cmd" in the composer). */
  pendingCommand?: { id: number; sessionId: string; command: string } | null;
  /** New-session composer choices on the home screen. */
  homeProvider: ProviderId;
  homeCwd: string | null;
  homeModel: Partial<Record<ProviderId, string>>;
  homeMode: Partial<Record<ProviderId, string>>;
  homeEffort: Partial<Record<ProviderId, Effort>>;
  /** The account the next session with each agent runs under; absent means the agent's default account. */
  homeAccount: Partial<Record<ProviderId, string>>;
  /** Start the next Claude Code session with ultracode on (only where `caps.features.ultracode`). */
  homeUltracode?: boolean;
}

export interface Store {
  conn: ConnStatus;
  ready: boolean;
  version: string;
  platform: string;
  home: string;
  providers: Partial<Record<ProviderId, ProviderInfo>>;
  projects: Project[];
  settings: AppSettings;
  /** The backdrop config while a change is on its way to the bridge (Settings sliders); null otherwise. */
  backdropLive: BackdropConfig | null;
  sessions: Record<string, SessionMeta>;
  data: Record<string, SessionData>;
  providerCaps: Record<string, Capabilities>;
  /** capsKeys whose capabilities could not be loaded (the composer drops those controls instead of waiting). */
  capsFailed: Record<string, true>;
  /** Plan limits per account, keyed by `accountKey(provider, accountId)`. */
  limits: Partial<Record<string, RateLimit[]>>;
  /** Limits as remembered by the bridge, with when they were read, history and pace; keyed like `limits`. */
  limitReports: Partial<Record<string, LimitsReport>>;
  /** Sign-in flows per account, keyed by `accountKey(provider, accountId)`. */
  auth: Partial<Record<string, AuthFlow>>;
  toasts: Toast[];
  drafts: Record<string, Draft>;
  ui: Ui;

  setUi: (patch: Partial<Ui>) => void;
  setDraft: (key: string, patch: Partial<Draft>) => void;
  toast: (text: string, level?: Toast['level']) => void;
  dismissToast: (id: number) => void;
}

const UI_KEY = 'sable.ui.v1';

function loadUi(): Partial<Ui> {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) ?? '{}');
  } catch {
    return {};
  }
}

const persistedUi = loadUi();
/** Whether the user has picked a home agent yet (a fresh profile follows `settings.defaultProvider`). */
let homeChosen = !!persistedUi.homeProvider;

const emptyData = (): SessionData => ({ loaded: false, items: {}, roots: [], children: {}, permissions: [], questions: [], todos: [], queue: [] });

function indexItems(items: TimelineItem[]) {
  const map: Record<string, TimelineItem> = {};
  const roots: string[] = [];
  const children: Record<string, string[]> = {};
  for (const item of items) {
    map[item.id] = item;
    if (item.parentId) (children[item.parentId] ??= []).push(item.id);
    else roots.push(item.id);
  }
  return { items: map, roots, children };
}

let toastId = 1;

export const useStore = create<Store>((set, get) => ({
  conn: 'connecting',
  ready: false,
  version: '',
  platform: '',
  home: '',
  providers: {},
  projects: [],
  settings: DEFAULT_SETTINGS,
  backdropLive: null,
  sessions: {},
  data: {},
  providerCaps: {},
  capsFailed: {},
  limits: {},
  limitReports: {},
  auth: {},
  toasts: [],
  drafts: {},
  ui: {
    activeSessionId: null,
    sidebarOpen: true,
    railOpen: false,
    railTab: 'changes',
    paletteOpen: false,
    settings: null,
    projectPicker: false,
    historyOpen: false,
    shortcutsOpen: false,
    homeProvider: 'claude',
    homeCwd: null,
    homeModel: {},
    homeMode: {},
    homeEffort: {},
    homeAccount: {},
    ...persistedUi,
  },

  setUi: (patch) => {
    set((s) => ({ ui: { ...s.ui, ...patch } }));
    if (patch.homeProvider) homeChosen = true;
    const { activeSessionId, sidebarOpen, railOpen, railTab, homeProvider, homeCwd, homeModel, homeMode, homeEffort, homeAccount, homeUltracode } = get().ui;
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ activeSessionId, sidebarOpen, railOpen, railTab, homeProvider: homeChosen ? homeProvider : undefined, homeCwd, homeModel, homeMode, homeEffort, homeAccount, homeUltracode }));
    } catch {
      /* private mode */
    }
  },

  setDraft: (key, patch) =>
    set((s) => {
      const cur: Draft = s.drafts[key] ?? { text: '', attachments: [] };
      return { drafts: { ...s.drafts, [key]: { ...cur, ...patch } } };
    }),

  toast: (text, level = 'info') => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts, { id, level, text }] }));
    window.setTimeout(() => get().dismissToast(id), level === 'error' ? 7000 : 3800);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// ───────────────────────── event application ─────────────────────────

type DeltaKey = string; // `${sessionId}\u0000${itemId}\u0000${field}`
const deltaBuffer = new Map<DeltaKey, string>();
let deltaFrame = 0;

/** Streaming deltas arrive far faster than frames: coalesce them into one store write per frame. */
export function flushDeltas() {
  deltaFrame = 0;
  if (!deltaBuffer.size) return;
  const batch = [...deltaBuffer];
  deltaBuffer.clear();
  useStore.setState((s) => {
    const data = { ...s.data };
    const touched = new Map<string, Record<string, TimelineItem>>();
    for (const [key, delta] of batch) {
      const [sessionId, itemId, field] = key.split('\u0000');
      const d = data[sessionId];
      if (!d) continue;
      let items = touched.get(sessionId);
      if (!items) {
        items = { ...d.items };
        touched.set(sessionId, items);
      }
      const item = items[itemId] as (TimelineItem & Record<string, unknown>) | undefined;
      if (!item) continue;
      items[itemId] = { ...item, [field]: ((item[field] as string | undefined) ?? '') + delta } as TimelineItem;
    }
    for (const [sessionId, items] of touched) data[sessionId] = { ...data[sessionId], items };
    return { data };
  });
}

function patchData(sessionId: string, fn: (d: SessionData) => Partial<SessionData>) {
  useStore.setState((s) => {
    const d = s.data[sessionId];
    if (!d) return s;
    return { data: { ...s.data, [sessionId]: { ...d, ...fn(d) } } };
  });
}

export function applySnapshot(snap: SessionSnapshot) {
  useStore.setState((s) => ({
    sessions: { ...s.sessions, [snap.session.id]: snap.session },
    data: {
      ...s.data,
      [snap.session.id]: {
        loaded: true,
        ...indexItems(snap.items),
        permissions: snap.permissions,
        questions: snap.questions,
        todos: snap.todos,
        suggestion: snap.suggestion,
        queue: snap.queue ?? [],
        caps: snap.caps ?? s.data[snap.session.id]?.caps,
      },
    },
  }));
}

/**
 * A session finished or started waiting on the user while they were looking elsewhere:
 * mark it unread and, if they asked for it, raise a system notification.
 */
function onStatusChange(session: SessionMeta, prev: SessionMeta['status']) {
  const s = useStore.getState();
  const finished = (prev === 'running' || prev === 'awaiting') && (session.status === 'idle' || session.status === 'error');
  const needsYou = session.status === 'awaiting' && prev !== 'awaiting';
  if (!finished && !needsYou) return;
  const viewing = s.ui.activeSessionId === session.id;
  if (viewing && !document.hidden) return;
  if (finished && !viewing) void bridge.call('session.update', { sessionId: session.id, patch: { unread: true } }).catch(() => {});
  if (!s.settings.notifyOnDone || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const title = needsYou ? 'Waiting for your approval' : session.status === 'error' ? 'Turn ended with an error' : 'Turn finished';
    const n = new Notification(title, { body: session.title, tag: session.id });
    n.onclick = () => {
      window.focus();
      useStore.getState().setUi({ activeSessionId: session.id });
      n.close();
    };
  } catch {
    /* notifications are best effort */
  }
}

/** Applies one bridge event to the store. Exported for tests; the app feeds it from `startBridge`. */
export function applyEvent(e: BridgeEvent) {
  switch (e.type) {
    case 'item.delta': {
      const key = `${e.sessionId}\u0000${e.id}\u0000${e.field}`;
      deltaBuffer.set(key, (deltaBuffer.get(key) ?? '') + e.delta);
      if (!deltaFrame) deltaFrame = requestAnimationFrame(flushDeltas);
      return;
    }
    case 'item.added':
      flushDeltas();
      patchData(e.sessionId, (d) => {
        if (d.items[e.item.id]) return { items: { ...d.items, [e.item.id]: e.item } };
        const next: Partial<SessionData> = { items: { ...d.items, [e.item.id]: e.item } };
        if (e.item.parentId) next.children = { ...d.children, [e.item.parentId]: [...(d.children[e.item.parentId] ?? []), e.item.id] };
        else next.roots = [...d.roots, e.item.id];
        return next;
      });
      return;
    case 'item.patch':
      flushDeltas();
      patchData(e.sessionId, (d) => {
        const item = d.items[e.id];
        if (!item) return {};
        return { items: { ...d.items, [e.id]: { ...item, ...e.patch } as TimelineItem } };
      });
      return;
    case 'item.removed':
      patchData(e.sessionId, (d) => {
        const item = d.items[e.id];
        if (!item) return {};
        const items = { ...d.items };
        const children = { ...d.children };
        // The item goes with everything nested under it, as on the bridge.
        const drop = (id: string) => {
          delete items[id];
          const kids = children[id];
          if (kids) {
            delete children[id];
            kids.forEach(drop);
          }
        };
        drop(e.id);
        const next: Partial<SessionData> = { items, children };
        if (item.parentId) children[item.parentId] = (children[item.parentId] ?? []).filter((x) => x !== e.id);
        else next.roots = d.roots.filter((x) => x !== e.id);
        return next;
      });
      return;
    case 'timeline.reset':
      deltaBuffer.clear();
      patchData(e.sessionId, () => indexItems(e.items));
      return;
    case 'session.added':
      useStore.setState((s) => ({
        sessions: { ...s.sessions, [e.session.id]: e.session },
        data: s.data[e.session.id] ? s.data : { ...s.data, [e.session.id]: { ...emptyData(), loaded: true } },
      }));
      return;
    case 'session.updated': {
      const before = useStore.getState().sessions[e.id];
      useStore.setState((s) => {
        const cur = s.sessions[e.id];
        if (!cur) return s;
        return { sessions: { ...s.sessions, [e.id]: { ...cur, ...e.patch } } };
      });
      if (before && e.patch.status && e.patch.status !== before.status) onStatusChange({ ...before, ...e.patch }, before.status);
      return;
    }
    case 'session.removed':
      useStore.setState((s) => {
        const sessions = { ...s.sessions };
        const data = { ...s.data };
        delete sessions[e.id];
        delete data[e.id];
        const ui = s.ui.activeSessionId === e.id ? { ...s.ui, activeSessionId: null } : s.ui;
        return { sessions, data, ui };
      });
      return;
    case 'session.caps':
      patchData(e.id, () => ({ caps: e.caps }));
      return;
    case 'permission.added':
      patchData(e.request.sessionId, (d) => ({ permissions: [...d.permissions.filter((p) => p.id !== e.request.id), e.request] }));
      return;
    case 'permission.removed':
      patchData(e.sessionId, (d) => ({ permissions: d.permissions.filter((p) => p.id !== e.id) }));
      return;
    case 'question.added':
      patchData(e.request.sessionId, (d) => ({ questions: [...d.questions.filter((q) => q.id !== e.request.id), e.request] }));
      return;
    case 'question.removed':
      patchData(e.sessionId, (d) => ({ questions: d.questions.filter((q) => q.id !== e.id) }));
      return;
    case 'todos.updated':
      patchData(e.sessionId, () => ({ todos: e.todos }));
      return;
    case 'queue.updated':
      patchData(e.sessionId, () => ({ queue: e.queue }));
      return;
    case 'suggestion':
      patchData(e.sessionId, () => ({ suggestion: e.text || undefined }));
      return;
    case 'provider.updated':
      useStore.setState((s) => ({ providers: { ...s.providers, [e.provider.id]: e.provider }, limits: withAccountLimits(s.limits, [e.provider]) }));
      return;
    case 'auth.progress': {
      const key = accountKey(e.provider, e.accountId);
      // A new flow starts clean; later steps keep the link the CLI printed.
      const url = e.url ?? (e.state === 'started' ? undefined : useStore.getState().auth[key]?.url);
      const flow: AuthFlow = { state: e.state, url, message: e.message };
      useStore.setState((s) => ({ auth: { ...s.auth, [key]: flow } }));
      // A finished sign-in is history after a moment, so its success state does not linger.
      if (e.state === 'done') {
        window.setTimeout(() => {
          useStore.setState((s) => {
            if (s.auth[key] !== flow) return s;
            const auth = { ...s.auth };
            delete auth[key];
            return { auth };
          });
        }, 4000);
      }
      return;
    }
    case 'projects.updated':
      useStore.setState({ projects: e.projects });
      return;
    case 'settings.updated':
      useStore.setState({ settings: e.settings });
      return;
    case 'limits.report':
      useStore.setState((s) => applyLimitReports(s, [e.report]));
      return;
    case 'limits.updated':
      useStore.setState((s) => ({ limits: { ...s.limits, [accountKey(e.provider, e.accountId)]: e.limits } }));
      return;
    case 'caps.updated':
      useStore.setState((s) => {
        // The bridge may spell the folder differently (resolved path): match it loosely.
        const want = capsKey(e.provider, normPath(e.cwd), e.accountId);
        const providerCaps = { ...s.providerCaps, [capsKey(e.provider, e.cwd ?? null, e.accountId)]: e.caps };
        for (const key of Object.keys(s.providerCaps)) if (normKey(key) === want) providerCaps[key] = e.caps;
        return { providerCaps };
      });
      return;
    case 'toast':
      useStore.getState().toast(e.text, e.level);
      return;
    default:
      return;
  }
}

/** Terminal output is high-volume and view-local, so it bypasses the store. */
const termListeners = new Set<(e: Extract<BridgeEvent, { type: 'term.data' | 'term.exit' }>) => void>();
export function onTerm(l: (e: Extract<BridgeEvent, { type: 'term.data' | 'term.exit' }>) => void) {
  termListeners.add(l);
  return () => {
    termListeners.delete(l);
  };
}

async function hello() {
  const app = await bridge.call('app.hello', {});
  useStore.setState((s) => {
    const sessions = Object.fromEntries(app.sessions.map((m) => [m.id, m]));
    const active = s.ui.activeSessionId && sessions[s.ui.activeSessionId] ? s.ui.activeSessionId : null;
    const installed = app.providers.filter((p) => p.installed);
    // A fresh profile starts on the agent chosen in settings; after that the home choice sticks.
    const wanted = homeChosen || !installed.some((p) => p.id === app.settings.defaultProvider) ? s.ui.homeProvider : app.settings.defaultProvider;
    const homeProvider = installed.some((p) => p.id === wanted) ? wanted : (installed.find((p) => p.id !== 'demo')?.id ?? installed[0]?.id ?? 'claude');
    // Forget home account choices whose account is gone.
    const homeAccount: Partial<Record<ProviderId, string>> = {};
    for (const p of app.providers) {
      const chosen = s.ui.homeAccount?.[p.id];
      if (chosen && (!p.accounts || p.accounts.some((a) => a.id === chosen))) homeAccount[p.id] = chosen;
    }
    return {
      ready: true,
      version: app.version,
      platform: app.platform,
      home: app.home,
      providers: Object.fromEntries(app.providers.map((p) => [p.id, p])),
      limits: withAccountLimits(s.limits, app.providers),
      projects: app.projects,
      settings: app.settings,
      sessions,
      ui: { ...s.ui, activeSessionId: active, homeProvider, homeAccount, homeCwd: s.ui.homeCwd ?? app.projects[0]?.path ?? null },
    };
  });
  const active = useStore.getState().ui.activeSessionId;
  if (active) void loadSession(active);
  // Limits remembered from earlier runs, so nothing waits for an agent to answer.
  void bridge
    .call('usage.limits', {})
    .then((reports) => useStore.setState((s) => applyLimitReports(s, reports)))
    .catch(() => {});
}

export function startBridge() {
  bridge.on((e) => {
    if (e.type === 'term.data' || e.type === 'term.exit') {
      for (const l of termListeners) l(e);
      return;
    }
    // The agent's browser tool asks for this window's Browser tab (the handler loads on first use).
    if (e.type === 'browser.request') {
      const request = e.request;
      void import('@/features/rail/browser-agent').then((m) => m.handleBrowserRequest(request)).catch(() => {});
      return;
    }
    applyEvent(e);
  });
  bridge.onStatus((conn) => {
    useStore.setState({ conn });
    if (conn === 'open') void hello().catch((err) => useStore.getState().toast(String(err.message ?? err), 'error'));
  });
  bridge.start();
}

export async function loadSession(sessionId: string) {
  const snap = await bridge.call('session.snapshot', { sessionId });
  applySnapshot(snap);
}

/** Stores limit reports, and their limits where the store has none yet or older ones. */
function applyLimitReports(s: Store, reports: LimitsReport[]): Partial<Store> {
  const limitReports = { ...s.limitReports };
  const limits = { ...s.limits };
  for (const r of reports) {
    const key = accountKey(r.provider, r.accountId);
    limitReports[key] = r;
    if (r.limits.length || r.planLimits === false) limits[key] = r.limits;
  }
  return { limitReports, limits };
}

/** Limits the bridge already knows per account (sent with provider info) fill in what the store lacks. */
function withAccountLimits(limits: Store['limits'], providers: ProviderInfo[]): Store['limits'] {
  let next = limits;
  for (const p of providers)
    for (const a of p.accounts ?? []) {
      const key = accountKey(p.id, a.id);
      if (a.limits && !next[key]) next = { ...next, [key]: a.limits };
    }
  return next;
}

/** Capabilities differ per account (plan models, skills, MCP servers): extra accounts get their own cache entry. */
export const capsKey = (provider: ProviderId, cwd: string | null, accountId?: string | null) =>
  `${provider}:${cwd ?? ''}${accountId && accountId !== DEFAULT_ACCOUNT ? `@${accountId}` : ''}`;

const normPath = (p?: string | null) => (p ? p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : null);
/** A capsKey with its folder normalized (see `caps.updated`). */
function normKey(key: string) {
  const m = /^(\w+):(.*?)(@[\w-]+)?$/.exec(key);
  return m ? `${m[1]}:${normPath(m[2]) ?? ''}${m[3] ?? ''}` : key;
}

const capsInflight = new Map<string, Promise<void>>();
const CAPS_RETRIES = 2;
const CAPS_RETRY_MS = 3000;

/**
 * Loads what a provider offers in a folder (models, modes, commands, skills) for the home composer.
 * A failed load is tried again a couple of times, then marked in `capsFailed` so the composer
 * drops its mode and model controls rather than showing skeletons that never resolve.
 */
export function ensureProviderCaps(provider: ProviderId, cwd: string | null, accountId?: string | null, attempt = 0) {
  const key = capsKey(provider, cwd, accountId);
  if (useStore.getState().providerCaps[key] || capsInflight.has(key)) return;
  const p = bridge
    .call('provider.caps', { provider, cwd: cwd ?? undefined, accountId: accountId && accountId !== DEFAULT_ACCOUNT ? accountId : undefined })
    .then((caps) =>
      useStore.setState((s) => {
        const { [key]: _, ...capsFailed } = s.capsFailed;
        return { providerCaps: { ...s.providerCaps, [key]: caps }, capsFailed };
      }),
    )
    .catch((err: Error) => {
      // A lost connection or a quick refusal may pass; a probe that timed out will not.
      if (attempt < CAPS_RETRIES && !/timed out/.test(String(err?.message))) window.setTimeout(() => ensureProviderCaps(provider, cwd, accountId, attempt + 1), CAPS_RETRY_MS);
      else useStore.setState((s) => ({ capsFailed: { ...s.capsFailed, [key]: true } }));
    })
    .finally(() => capsInflight.delete(key));
  capsInflight.set(key, p);
}
