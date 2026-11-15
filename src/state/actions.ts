import { DEFAULT_ACCOUNT, type AccountInfo, type Attachment, type BackdropConfig, type BackdropImage, type Effort, type ProviderId, type QueuedMessage, type SessionMeta, type SessionOptions } from '@shared/protocol';
import { normalizeBackdrop } from '@shared/backdrop';
import { bridge } from '@/lib/bridge';
import { applySnapshot, capsKey, loadSession, useStore, type SettingsSection, type Store } from './store';

/** Everything the UI can ask the bridge to do. Components call these, never bridge.call directly. */

const fail = (err: unknown) => useStore.getState().toast((err as Error)?.message ?? String(err), 'error');

export function openSession(id: string) {
  const s = useStore.getState();
  s.setUi({ activeSessionId: id });
  if (!s.data[id]?.loaded) void loadSession(id).catch(fail);
  else if (s.sessions[id]?.unread) void bridge.call('session.update', { sessionId: id, patch: { unread: false } }).catch(() => {});
}

// The section Settings last showed, so reopening it lands where you left off (for as long as the app is open).
let lastSettings: SettingsSection = 'general';
useStore.subscribe((s) => {
  if (s.ui.settings) lastSettings = s.ui.settings;
});

/** Opens Settings at a section, or where it was last left. */
export function openSettings(section?: SettingsSection) {
  useStore.getState().setUi({ settings: section ?? lastSettings });
}

export function goHome(cwd?: string | null) {
  const s = useStore.getState();
  s.setUi({ activeSessionId: null, ...(cwd !== undefined ? { homeCwd: cwd } : {}) });
}

export interface NewSessionChoice {
  provider: ProviderId;
  cwd: string;
  model?: string;
  mode?: string;
  effort?: Effort;
  resume?: string;
  title?: string;
  /** The account to run under; absent means the agent's default account. */
  accountId?: string;
  /** Claude Code: start with ultracode on. */
  ultracode?: boolean;
}

export async function createSession(choice: NewSessionChoice): Promise<SessionMeta | null> {
  try {
    const snap = await bridge.call('session.create', choice);
    applySnapshot(snap);
    useStore.getState().setUi({ activeSessionId: snap.session.id });
    return snap.session;
  } catch (err) {
    fail(err);
    return null;
  }
}

/**
 * The account a new session with `provider` runs under from the home screen: the home choice
 * while that account exists, otherwise the agent's default account.
 */
export function homeAccountId(provider: ProviderId, s: Pick<Store, 'ui' | 'providers'> = useStore.getState()): string {
  const accounts = s.providers[provider]?.accounts;
  const chosen = s.ui.homeAccount?.[provider];
  if (chosen && accounts?.some((a) => a.id === chosen)) return chosen;
  return accounts?.find((a) => a.isDefault)?.id ?? DEFAULT_ACCOUNT;
}

/** Chooses the account for new sessions with `provider` from the home screen. */
export function setHomeAccount(provider: ProviderId, accountId: string) {
  const s = useStore.getState();
  s.setUi({ homeAccount: { ...s.ui.homeAccount, [provider]: accountId } });
}

/** What the home composer would start: provider, account, folder, model, mode, effort. */
export function homeChoice(): NewSessionChoice | null {
  const { ui, providerCaps, settings } = useStore.getState();
  if (!ui.homeCwd) return null;
  const provider = ui.homeProvider;
  const accountId = homeAccountId(provider);
  const caps = providerCaps[capsKey(provider, ui.homeCwd, accountId)] ?? providerCaps[capsKey(provider, ui.homeCwd)];
  const model = ui.homeModel[provider] ?? settings.defaultModels[provider] ?? caps?.models.find((m) => m.isDefault)?.id ?? caps?.models[0]?.id;
  const mode = ui.homeMode[provider] ?? settings.defaultModes[provider] ?? caps?.modes[0]?.id;
  const effort = ui.homeEffort[provider] ?? settings.defaultEfforts[provider];
  const ultracode = ui.homeUltracode && caps?.features.ultracode ? true : undefined;
  return { provider, cwd: ui.homeCwd, model, mode, effort, accountId, ...(ultracode ? { ultracode } : {}) };
}

/** The home composer's ultracode choice (sent with the next new session where the agent offers it). */
export const setHomeUltracode = (on: boolean) => useStore.getState().setUi({ homeUltracode: on });

/** Sends the first message of a new session from the home screen. */
export async function startFromHome(text: string, attachments: Attachment[] = []): Promise<boolean> {
  const choice = homeChoice();
  if (!choice) {
    useStore.getState().setUi({ projectPicker: true });
    return false;
  }
  const session = await createSession(choice);
  if (!session) return false;
  await sendMessage(session.id, text, attachments);
  return true;
}

/**
 * Sends a message. While the agent works it is queued (sent when the turn ends) unless `steer` is
 * set: then the running agent takes it at its next step and it shows where it was sent
 * (`UserItem.steered`). Resolves `queued: true` when it went to the queue.
 */
export async function sendMessage(sessionId: string, text: string, attachments: Attachment[] = [], opts: { steer?: boolean } = {}): Promise<{ ok: boolean; queued?: boolean }> {
  try {
    return await bridge.call('session.send', { sessionId, text, attachments, ...(opts.steer ? { steer: true } : {}) });
  } catch (err) {
    fail(err);
    return { ok: false };
  }
}

export const interrupt = (sessionId: string) => bridge.call('session.interrupt', { sessionId }).catch(fail);

// ── queued messages (held by the bridge while a turn runs) ──

/** Replaces a queued message's text, and its attachments when given; left empty, it is removed. */
export const updateQueued = (sessionId: string, id: string, text: string, attachments?: Attachment[]) =>
  bridge.call('queue.update', { sessionId, id, text, ...(attachments ? { attachments } : {}) }).catch(fail);
export const removeQueued = (sessionId: string, id: string) => bridge.call('queue.remove', { sessionId, id }).catch(fail);
/** Takes a queued message out to edit it (e.g. back into the composer). Null when it already went out. */
export async function takeQueued(sessionId: string, id: string): Promise<QueuedMessage | null> {
  try {
    return (await bridge.call('queue.take', { sessionId, id })).message ?? null;
  } catch (err) {
    fail(err);
    return null;
  }
}
/** New queue order (drag to reorder): `ids` first, in that order. Applied to the store at once; `queue.updated` confirms it. */
export function reorderQueue(sessionId: string, ids: string[]) {
  useStore.setState((s) => {
    const d = s.data[sessionId];
    if (!d) return s;
    const byId = new Map(d.queue.map((q) => [q.id, q]));
    const front = ids.flatMap((id) => byId.get(id) ?? []);
    const named = new Set(front.map((q) => q.id));
    return { data: { ...s.data, [sessionId]: { ...d, queue: [...front, ...d.queue.filter((q) => !named.has(q.id))] } } };
  });
  return bridge.call('queue.reorder', { sessionId, ids }).catch(fail);
}
/** Gives a queued message to the agent now (mid-turn when one is running). */
export const sendQueuedNow = (sessionId: string, id: string) => bridge.call('queue.sendNow', { sessionId, id }).catch(fail);

export const setModel = (sessionId: string, model: string) => bridge.call('session.setModel', { sessionId, model }).catch(fail);

/** Claude Code ultracode on or off for a session (where `caps.features.ultracode`). */
export const setUltracode = (sessionId: string, on: boolean) => bridge.call('session.setUltracode', { sessionId, on }).catch(fail);

export const setEffort = (sessionId: string, effort: Effort) => bridge.call('session.setEffort', { sessionId, effort }).catch(fail);

export const setMode = (sessionId: string, mode: string) => bridge.call('session.setMode', { sessionId, mode }).catch(fail);

export const renameSession = (sessionId: string, title: string) => bridge.call('session.rename', { sessionId, title }).catch(fail);

/** Switches browser control, computer use or remote control for a session. */
export const setSessionOptions = (sessionId: string, options: SessionOptions) => bridge.call('session.setOptions', { sessionId, options }).catch(fail);

/** Changes what new sessions with `provider` start with (Settings › General). */
export function setDefaultSessionOptions(provider: ProviderId, patch: SessionOptions) {
  const cur = useStore.getState().settings.sessionOptions ?? {};
  return setSettings({ sessionOptions: { ...cur, [provider]: { ...cur[provider], ...patch } } });
}

/**
 * Starts the agent process for what the home composer would create, so the first reply comes
 * sooner. Silent: a failure just means the first send starts cold.
 */
export function prewarmHome() {
  const s = useStore.getState();
  if (s.settings.prewarm === false || s.ui.homeProvider === 'demo') return;
  const c = homeChoice();
  if (!c) return;
  void bridge.call('provider.prewarm', { provider: c.provider, accountId: c.accountId, cwd: c.cwd, model: c.model, mode: c.mode, effort: c.effort, ultracode: c.ultracode }).catch(() => {});
}

export const updateSession = (sessionId: string, patch: { pinned?: boolean; archived?: boolean; unread?: boolean }) =>
  bridge.call('session.update', { sessionId, patch }).catch(fail);

export async function closeSession(sessionId: string, remove = false) {
  await bridge.call('session.close', { sessionId, remove }).catch(fail);
}

export const respondPermission = (sessionId: string, requestId: string, optionId: string, message?: string) =>
  bridge.call('permission.respond', { sessionId, requestId, optionId, message }).catch(fail);

export const respondQuestion = (sessionId: string, requestId: string, answers: Record<string, string[]> | null) =>
  bridge.call('question.respond', { sessionId, requestId, answers }).catch(fail);

export async function rewindTo(sessionId: string, itemId: string, restoreFiles: boolean) {
  try {
    const r = await bridge.call('session.rewind', { sessionId, itemId, restoreFiles });
    if (!r.ok && r.message) useStore.getState().toast(r.message, 'error');
    return r.ok;
  } catch (err) {
    fail(err);
    return false;
  }
}

export async function addProject(path: string) {
  try {
    const project = await bridge.call('project.add', { path });
    useStore.getState().setUi({ homeCwd: project.path, projectPicker: false });
    return project;
  } catch (err) {
    fail(err);
    return null;
  }
}

export const removeProject = (path: string) => bridge.call('project.remove', { path }).catch(fail);

export const pinProject = (path: string, pinned: boolean) => bridge.call('project.pin', { path, pinned }).catch(fail);

export async function setSettings(patch: Partial<import('@shared/protocol').AppSettings>) {
  try {
    await bridge.call('app.setSettings', { patch });
  } catch (err) {
    fail(err);
  }
}

// ── backdrop ──

/** The backdrop config as drawn now: a change on its way to the bridge, else the stored one. */
export const selectBackdrop = (s: Store): BackdropConfig => s.backdropLive ?? s.settings.backdropConfig;

const BACKDROP_SAVE_MS = 300;
let backdropTimer = 0;

/**
 * Changes the backdrop. It shows at once (`backdropLive`); the bridge gets the result after a
 * short pause, so dragging a slider sends one request, not one per pointer move.
 */
export function setBackdrop(patch: Partial<BackdropConfig>) {
  const s = useStore.getState();
  const next = normalizeBackdrop({ ...selectBackdrop(s), ...patch }, s.settings.backdropImages.map((i) => i.id));
  useStore.setState({ backdropLive: next });
  clearTimeout(backdropTimer);
  backdropTimer = window.setTimeout(() => {
    void bridge
      .call('app.setSettings', { patch: { backdropConfig: next } })
      .catch(fail)
      .finally(() => {
        // The stored settings carry it now (the bridge's settings event comes before its reply).
        if (useStore.getState().backdropLive === next) useStore.setState({ backdropLive: null });
      });
  }, BACKDROP_SAVE_MS);
}

/** Longest side an uploaded backdrop image is scaled down to. */
const BACKDROP_MAX_SIDE = 2048;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('Could not read the image'));
    r.readAsDataURL(blob);
  });
}

async function encodeImage(bitmap: ImageBitmap, w: number, h: number): Promise<Blob> {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Could not read the image');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const encode = (type: string, quality: number): Promise<Blob | null> =>
    canvas instanceof HTMLCanvasElement ? new Promise((res) => canvas.toBlob(res, type, quality)) : (canvas as OffscreenCanvas).convertToBlob({ type, quality });
  const webp = await encode('image/webp', 0.9);
  if (webp && webp.type === 'image/webp') return webp;
  const jpeg = await encode('image/jpeg', 0.9);
  if (!jpeg) throw new Error('Could not read the image');
  return jpeg;
}

/**
 * Uploads an image for the backdrop: decoded here, scaled to at most 2048 px on its long side
 * and re-encoded (WebP, else JPEG), then stored by the bridge. Shows it as the backdrop.
 */
export async function addBackdropImage(file: Blob): Promise<BackdropImage | null> {
  try {
    if (file.type && !file.type.startsWith('image/')) throw new Error('Choose an image file');
    const bitmap = await createImageBitmap(file).catch(() => {
      throw new Error('Could not read the image');
    });
    const k = Math.min(1, BACKDROP_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * k));
    const h = Math.max(1, Math.round(bitmap.height * k));
    const blob = await encodeImage(bitmap, w, h);
    bitmap.close();
    const img = await bridge.call('backdrop.add', { data: await blobToBase64(blob), width: w, height: h });
    imageBlobs.set(img.id, Promise.resolve(blob));
    setBackdrop({ source: 'image', image: img.id });
    return img;
  } catch (err) {
    fail(err);
    return null;
  }
}

export async function removeBackdropImage(id: string) {
  try {
    // Anything still on its way would bring the removed image back.
    clearTimeout(backdropTimer);
    useStore.setState({ backdropLive: null });
    await bridge.call('backdrop.remove', { id });
    imageBlobs.delete(id);
  } catch (err) {
    fail(err);
  }
}

const imageBlobs = new Map<string, Promise<Blob>>();

/** A stored backdrop image's bytes, fetched once per id. */
export function backdropImageBlob(id: string): Promise<Blob> {
  let p = imageBlobs.get(id);
  if (!p) {
    p = bridge.call('backdrop.get', { id }).then((r) => {
      const bin = atob(r.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: r.type });
    });
    p.catch(() => imageBlobs.delete(id));
    imageBlobs.set(id, p);
  }
  return p;
}

// Account id optional everywhere: absent means the agent's built-in default account.
export const login = (provider: ProviderId, accountId?: string) => bridge.call('auth.login', { provider, accountId }).catch(fail);
export const cancelLogin = (provider: ProviderId, accountId?: string) => bridge.call('auth.cancel', { provider, accountId }).catch(fail);
export const logout = (provider: ProviderId, accountId?: string) => bridge.call('auth.logout', { provider, accountId }).catch(fail);
export const refreshProvider = (provider: ProviderId, accountId?: string) => bridge.call('auth.refresh', { provider, accountId }).catch(fail);
export const refreshLimits = (provider: ProviderId, accountId?: string) => bridge.call('provider.limits', { provider, accountId }).catch(() => []);

/** Adds an account with its own empty profile. With `signIn` its sign-in starts right away. */
export async function addAccount(provider: ProviderId, opts: { label?: string; signIn?: boolean } = {}): Promise<AccountInfo | null> {
  try {
    const { account, ...info } = await bridge.call('account.add', { provider, label: opts.label });
    useStore.setState((s) => ({ providers: { ...s.providers, [provider]: info } }));
    if (opts.signIn) void login(provider, account.id);
    return account;
  } catch (err) {
    fail(err);
    return null;
  }
}

export const renameAccount = (provider: ProviderId, accountId: string, label: string) =>
  bridge.call('account.rename', { provider, accountId, label }).catch(fail);

/** Removes an extra account and its folder. Resolves false when the bridge refused (a session is still working). */
export async function removeAccount(provider: ProviderId, accountId: string): Promise<boolean> {
  try {
    await bridge.call('account.remove', { provider, accountId });
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

/** Makes an account the one new sessions with this agent use. The home choice follows it. */
export function setDefaultAccount(provider: ProviderId, accountId: string) {
  const s = useStore.getState();
  const next = { ...s.settings.defaultAccounts };
  if (accountId === DEFAULT_ACCOUNT) delete next[provider];
  else next[provider] = accountId;
  if (s.ui.homeAccount?.[provider]) {
    const homeAccount = { ...s.ui.homeAccount };
    delete homeAccount[provider];
    s.setUi({ homeAccount });
  }
  return setSettings({ defaultAccounts: next });
}

/** Resumes a conversation stored by the provider (from history) as a Sable session. */
export async function resumeFromHistory(provider: ProviderId, providerSessionId: string, cwd: string, title?: string, accountId?: string) {
  const existing = Object.values(useStore.getState().sessions).find((s) => s.provider === provider && s.providerSessionId === providerSessionId);
  if (existing) {
    openSession(existing.id);
    return existing;
  }
  return createSession({ provider, cwd, resume: providerSessionId, title, accountId });
}
