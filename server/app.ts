import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ACCOUNT,
  type AccountInfo,
  type AppState,
  type BridgeEvent,
  type Capabilities,
  type Project,
  type ProviderId,
  type ProviderInfo,
  type RateLimit,
  type RpcMethods,
  type RpcName,
  type SessionMeta,
  type UserItem,
} from '../shared/protocol';
import { normalizeBackdrop } from '../shared/backdrop';
import { SessionRuntime, autoTitle } from './core/runtime';
import { Store, type StoredAccount } from './core/store';
import { DiskCache } from './core/cache';
import type { Provider, ProviderContext } from './providers/types';
import { VERSION } from './version';

type Handler<M extends RpcName> = (params: RpcMethods[M]['params']) => Promise<RpcMethods[M]['result']> | RpcMethods[M]['result'];

export interface AppOptions {
  home?: string;
  /** Provider factories; injected so tests can run with the demo provider only. */
  providers: ((ctx: ProviderContext) => Provider)[];
  quiet?: boolean;
  /** How long after serving a cached answer the fresh one is fetched (tests shorten these). */
  refreshDelays?: { info?: number; caps?: number };
}

export { VERSION };

/** The label of each provider's built-in account until the user renames it. */
export const DEFAULT_ACCOUNT_LABEL = 'Main';

const accountKey = (provider: ProviderId, accountId: string) => `${provider}:${accountId}`;

/** The bridge application: owns providers, sessions and persistence. Transport-agnostic. */
export class App {
  readonly store: Store;
  /** Last known provider info and capabilities, so start-up never waits for the CLIs. */
  readonly cache: DiskCache;
  /** The built-in default account's instance of each provider. */
  readonly providers = new Map<ProviderId, Provider>();
  /** Instances for extra accounts, created on first use: `provider:accountId` → instance. */
  private instances = new Map<string, Provider>();
  private factories = new Map<ProviderId, (ctx: ProviderContext) => Provider>();
  /** Last known sign-in per extra account (the default account asks its provider every time, as before). */
  private infoCache = new Map<string, Promise<ProviderInfo>>();
  private limitsCache = new Map<string, RateLimit[]>();
  /** Counts `limits.updated` events from each account's provider (so `provider.limits` does not repeat one). */
  private limitsSeq = new Map<string, number>();
  readonly sessions = new Map<string, SessionRuntime>();
  private listeners = new Set<(e: BridgeEvent) => void>();
  private handlers = new Map<string, Handler<RpcName>>();
  private quiet: boolean;
  private delays: NonNullable<AppOptions['refreshDelays']>;
  /** Accounts whose sign-in the user cancelled; the rejection that follows is not an error. */
  private loginCancelled = new Set<string>();
  private disposers: (() => void | Promise<void>)[] = [];
  /** Sessions of an agent that is not available in this build (the Demo outside development): kept on disk, not shown. */
  private hidden: SessionMeta[] = [];

  constructor(opts: AppOptions) {
    this.quiet = !!opts.quiet;
    this.delays = opts.refreshDelays ?? {};
    this.store = new Store(opts.home);
    this.cache = new DiskCache(this.store.dir);
    for (const make of opts.providers) {
      const p = make(this.contextFor(DEFAULT_ACCOUNT));
      this.providers.set(p.id, p);
      this.factories.set(p.id, make);
    }
    for (const meta of this.store.state.sessions) {
      if (!this.providers.has(meta.provider)) {
        this.hidden.push(meta);
        continue;
      }
      // Nothing survives a restart mid-turn.
      meta.status = 'idle';
      meta.activity = undefined;
      // Remote links and live capability state belong to the agent process that is gone.
      meta.remote = meta.options?.remoteControl ? { status: 'Reconnects when the agent starts again', tone: 'waiting' } : undefined;
      meta.capState = undefined;
      this.sessions.set(meta.id, this.makeRuntime(meta, true));
    }
    this.registerCore();
  }

  log = (...args: unknown[]) => {
    if (!this.quiet) console.log('[sable]', ...args);
  };

  emit = (event: BridgeEvent) => {
    for (const l of this.listeners) l(event);
  };

  subscribe(listener: (e: BridgeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs `fn` first when the app is disposed (services stop their own work here). */
  onDispose(fn: () => void | Promise<void>) {
    this.disposers.push(fn);
  }

  register<M extends RpcName>(method: M, handler: Handler<M>) {
    this.handlers.set(method, handler as unknown as Handler<RpcName>);
  }

  async call<M extends RpcName>(method: M, params: RpcMethods[M]['params']): Promise<RpcMethods[M]['result']> {
    const h = this.handlers.get(method);
    if (!h) throw new Error(`Unknown method: ${method}`);
    return (await h(params as never)) as RpcMethods[M]['result'];
  }

  /** The provider instance for an account (the default account when `accountId` is absent). */
  provider(id: ProviderId, accountId: string = DEFAULT_ACCOUNT): Provider {
    const p = this.providers.get(id);
    const make = this.factories.get(id);
    if (!p || !make) throw new Error(`Provider not available: ${id}`);
    if (accountId === DEFAULT_ACCOUNT) return p;
    const key = accountKey(id, accountId);
    let inst = this.instances.get(key);
    if (inst) return inst;
    if (!this.findAccount(id, accountId)) throw new Error('This account was removed. Pick another account for this agent.');
    inst = make(this.contextFor(accountId, this.accountDir(id, accountId)));
    this.instances.set(key, inst);
    return inst;
  }

  // ── accounts ──

  private contextFor(accountId: string, dir?: string): ProviderContext {
    return {
      log: this.log,
      emit: (e) => this.fromProvider(accountId, e),
      account: accountId === DEFAULT_ACCOUNT ? undefined : { id: accountId, dir },
      settings: () => this.store.state.settings,
    };
  }

  /** Tags a provider instance's events with its account and keeps the per-account caches current. */
  private fromProvider(accountId: string, e: BridgeEvent) {
    switch (e.type) {
      case 'auth.progress':
        return this.emit({ ...e, accountId });
      case 'limits.updated': {
        const key = accountKey(e.provider, accountId);
        this.limitsCache.set(key, e.limits);
        this.limitsSeq.set(key, (this.limitsSeq.get(key) ?? 0) + 1);
        return this.emit({ ...e, accountId });
      }
      case 'provider.updated':
        if (accountId !== DEFAULT_ACCOUNT) this.infoCache.set(accountKey(e.provider.id, accountId), Promise.resolve(e.provider));
        void this.emitProvider(e.provider.id).catch(() => {});
        return;
      case 'caps.updated': {
        const tagged = { ...e, accountId: accountId === DEFAULT_ACCOUNT ? undefined : accountId };
        // Only news when it differs from what the UI was given.
        if (this.cache.set(capsCacheKey(e.provider, accountId, e.cwd), e.caps)) this.emit(tagged);
        return;
      }
      default:
        return this.emit(e);
    }
  }

  /** Where an extra account's config lives. */
  accountDir(provider: ProviderId, accountId: string) {
    return path.join(this.store.dir, 'accounts', provider, accountId);
  }

  private findAccount(provider: ProviderId, accountId: string): StoredAccount | undefined {
    return this.accountList(provider).find((a) => a.id === accountId);
  }

  /** The provider's accounts, the built-in default first. */
  accountList(provider: ProviderId): StoredAccount[] {
    const mine = this.store.state.accounts.filter((a) => a.provider === provider);
    const def = mine.find((a) => a.id === DEFAULT_ACCOUNT) ?? { id: DEFAULT_ACCOUNT, provider, label: DEFAULT_ACCOUNT_LABEL, createdAt: 0 };
    return [def, ...mine.filter((a) => a.id !== DEFAULT_ACCOUNT)];
  }

  /** The account new sessions with this provider use. */
  defaultAccountId(provider: ProviderId): string {
    const chosen = this.store.state.settings.defaultAccounts?.[provider];
    return chosen && this.findAccount(provider, chosen) ? chosen : DEFAULT_ACCOUNT;
  }

  private accountAuth(provider: ProviderId, accountId: string, force: boolean): Promise<ProviderInfo> {
    const key = accountKey(provider, accountId);
    const hit = this.infoCache.get(key);
    if (hit && !force) return hit;
    const p = this.provider(provider, accountId);
    const info = p.info(force).catch(() => fallbackInfo(p));
    this.infoCache.set(key, info);
    return info;
  }

  /** The provider as the UI sees it: the default account's CLI state plus every account. `force` re-reads one account. */
  async providerInfo(provider: ProviderId, force?: string): Promise<ProviderInfo> {
    const p = this.provider(provider);
    const base = await p.info(force === DEFAULT_ACCOUNT).catch(() => fallbackInfo(p));
    const defaultId = this.defaultAccountId(provider);
    const accounts = await Promise.all(
      this.accountList(provider).map(async (a): Promise<AccountInfo> => {
        const own = a.id === DEFAULT_ACCOUNT;
        // A missing CLI has no accounts to ask about.
        const info = own ? base : base.installed ? await this.accountAuth(provider, a.id, force === a.id) : undefined;
        return {
          id: a.id,
          provider,
          label: a.label,
          isDefault: a.id === defaultId,
          auth: info?.auth ?? { loggedIn: false },
          limits: this.limitsCache.get(accountKey(provider, a.id)),
          dir: own ? undefined : this.accountDir(provider, a.id),
          problem: own ? undefined : info?.problem,
        };
      }),
    );
    return { ...base, accounts };
  }

  private async emitProvider(provider: ProviderId, force?: string) {
    const info = await this.providerInfo(provider, force);
    this.cache.set(`info:${provider}`, info);
    this.emit({ type: 'provider.updated', provider: info });
    return info;
  }

  private refreshing = new Map<ProviderId, Promise<unknown>>();

  /**
   * The provider for app.hello: the last known answer from disk when there is one (refreshed in
   * the background and pushed as `provider.updated`), otherwise asked for now.
   */
  private providerInfoFast(provider: ProviderId): Promise<ProviderInfo> {
    const cached = this.cache.get<ProviderInfo>(`info:${provider}`);
    if (!cached?.installed) return this.providerInfo(provider).then((info) => (this.cache.set(`info:${provider}`, info), info));
    if (!this.refreshing.has(provider)) {
      // Not right away: start-up stays quiet (starting a CLI can make it sync plugins over the
      // network), and anything that needs the agent sooner asks it then.
      const run = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.delays.info ?? INFO_REFRESH_DELAY_MS);
        t.unref?.();
        this.onDispose(() => (clearTimeout(t), resolve()));
      })
        .then(() => (this.disposed ? undefined : this.emitProvider(provider)))
        .catch(() => {})
        .finally(() => this.refreshing.delete(provider));
      this.refreshing.set(provider, run);
    }
    // Account names and the default come from the store, sign-in from the cache.
    const defaultId = this.defaultAccountId(provider);
    const accounts = this.accountList(provider).map((a): AccountInfo => {
      const prev = cached.accounts?.find((x) => x.id === a.id);
      return {
        id: a.id,
        provider,
        label: a.label,
        isDefault: a.id === defaultId,
        auth: prev?.auth ?? { loggedIn: false },
        limits: this.limitsCache.get(accountKey(provider, a.id)) ?? prev?.limits,
        dir: a.id === DEFAULT_ACCOUNT ? undefined : this.accountDir(provider, a.id),
        problem: prev?.problem,
      };
    });
    return Promise.resolve({ ...cached, accounts });
  }

  /**
   * Capabilities for the home composer: the cached answer at once when there is one, the fresh
   * one pushed as `caps.updated` when it differs. A stale cache never blocks anything.
   */
  private async capsFast(provider: ProviderId, cwd: string | undefined, accountId = DEFAULT_ACCOUNT): Promise<Capabilities> {
    const p = this.provider(provider, accountId);
    const key = capsCacheKey(provider, accountId, cwd);
    const fresh = () =>
      p.caps(cwd).then((answer) => {
        // Codex reads its MCP inventory (and the plugin behind browser / computer use) in the
        // background, which takes long: until it arrives, keep the last known inventory.
        const before = this.cache.get<Capabilities>(key);
        const caps =
          provider === 'codex' && !answer.mcpServers.length && before?.mcpServers.length
            ? { ...answer, mcpServers: before.mcpServers, features: { ...answer.features, browser: before.features.browser, computerUse: before.features.computerUse, linkedBrowserComputer: before.features.linkedBrowserComputer } }
            : answer;
        if (this.cache.set(key, caps)) this.emit({ type: 'caps.updated', provider, accountId: accountId === DEFAULT_ACCOUNT ? undefined : accountId, cwd, caps });
        return caps;
      });
    const cached = provider === 'demo' ? undefined : this.cache.get<Capabilities>(key);
    if (!cached) return fresh();
    // Check it a moment later, off the start-up path (the probe starts a CLI process).
    const t = setTimeout(() => !this.disposed && void fresh().catch(() => {}), this.delays.caps ?? CAPS_REFRESH_DELAY_MS);
    t.unref?.();
    return cached;
  }

  // ── prewarm ──

  /** The provider instance holding the one warm agent process, if any. */
  private warmHolder?: Provider;

  private async prewarm(p: RpcMethods['provider.prewarm']['params']) {
    const settings = this.store.state.settings;
    if (settings.prewarm === false || p.provider === 'demo') return { ok: false };
    const accountId = p.accountId ?? this.defaultAccountId(p.provider);
    const inst = this.provider(p.provider, accountId);
    if (!inst.prewarm || !isDir(path.resolve(p.cwd))) return { ok: false };
    if (this.warmHolder && this.warmHolder !== inst) await this.warmHolder.discardWarm?.().catch(() => {});
    this.warmHolder = inst;
    await inst.prewarm({
      cwd: path.resolve(p.cwd),
      model: p.model ?? settings.defaultModels[p.provider],
      mode: p.mode ?? settings.defaultModes[p.provider] ?? 'default',
      effort: p.effort ?? settings.defaultEfforts[p.provider],
      options: settings.sessionOptions?.[p.provider],
      ultracode: p.ultracode || undefined,
    });
    return { ok: true };
  }

  private nextLabel(provider: ProviderId) {
    const taken = new Set(this.accountList(provider).map((a) => a.label.toLowerCase()));
    for (let n = 2; ; n++) if (!taken.has(`account ${n}`)) return `Account ${n}`;
  }

  /** Deletes an extra account's folder, and only ever a folder under `<home>/accounts/`. */
  private removeAccountDir(provider: ProviderId, accountId: string) {
    const root = path.join(this.store.dir, 'accounts');
    const dir = this.accountDir(provider, accountId);
    const rel = path.relative(root, dir);
    if (!/^[\w-]+$/.test(accountId) || !rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
    } catch (err) {
      this.log('could not delete account folder', dir, (err as Error).message);
    }
  }

  runtime(id: string): SessionRuntime {
    const rt = this.sessions.get(id);
    if (!rt) throw new Error('Session not found');
    return rt;
  }

  private lazy = new Set<string>();

  private makeRuntime(meta: SessionMeta, lazy = false): SessionRuntime {
    if (lazy) this.lazy.add(meta.id);
    const rt = new SessionRuntime(meta, this.emit, (rt, what) => {
      if (what === 'meta') this.store.saveState();
      else this.store.saveSession(rt.id, () => ({ items: rt.items, todos: rt.todos, queue: rt.queue }));
    });
    rt.onTurnEnd = (r, error) => this.afterTurn(r, error);
    return rt;
  }

  /** Loads a restored session's timeline from disk the first time it is needed. */
  private hydrate(rt: SessionRuntime) {
    if (!this.lazy.delete(rt.id)) return;
    const file = this.store.loadSession(rt.id);
    rt.load(file.items, file.todos, file.queue ?? []);
    rt.settle('cancelled');
  }

  /**
   * Puts a message in the timeline and hands it to the agent. Mid-turn it is steered: the agent
   * takes it at its next step and it stays where it was sent.
   */
  private async deliver(rt: SessionRuntime, text: string, attachments?: UserItem['attachments']) {
    const handle = await this.ensureHandle(rt);
    if (rt.meta.titleSource === 'auto' && !rt.items.some((i) => i.type === 'user')) {
      rt.update({ title: autoTitle(text) });
    }
    const item = rt.add<UserItem>({
      type: 'user',
      text,
      attachments: attachments?.length ? attachments : undefined,
      state: rt.turnActive ? 'queued' : 'sent',
      ...(rt.turnActive ? { steered: true } : {}),
    });
    try {
      await handle.send(item);
    } catch (err) {
      rt.notice('error', 'Could not send the message', (err as Error).message);
      rt.endTurn((err as Error).message);
    }
  }

  /**
   * A turn ended. When it ended normally, the next queued message goes out (one per turn
   * end). After an interrupt, a close or a failure the queue waits for the user.
   */
  private afterTurn(rt: SessionRuntime, error?: string) {
    if (error || rt.stopRequested) {
      // Steered messages the agent never took go back to the queue, to send or edit again.
      const untaken = rt.items.filter((i): i is UserItem => i.type === 'user' && !!i.steered && i.state === 'queued' && !i.parentId);
      if (untaken.length) {
        for (const u of untaken) rt.remove(u.id);
        rt.requeue(untaken.map((u) => ({ id: u.id, text: u.text, attachments: u.attachments, createdAt: u.ts })));
      }
      return;
    }
    if (!rt.queue.length) return;
    // Let the adapter finish its own bookkeeping (it may start a turn of its own first).
    setTimeout(() => {
      if (rt.turnActive || rt.stopRequested || this.sessions.get(rt.id) !== rt) return;
      const next = rt.takeQueued();
      if (next) void this.deliver(rt, next.text, next.attachments).catch((err) => this.log('queued send failed', (err as Error).message));
    }, 0);
  }

  private async ensureHandle(rt: SessionRuntime) {
    if (rt.handle) return rt.handle;
    this.hydrate(rt);
    rt.handle = await this.provider(rt.meta.provider, rt.meta.accountId).open(rt, { loadTranscript: false });
    this.seedCaps(rt);
    return rt.handle;
  }

  /** Shows what the agent offers right away from the cache; the adapter's own answer replaces it. */
  private seedCaps(rt: SessionRuntime) {
    const cached = this.cache.get<Capabilities>(capsCacheKey(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT, rt.meta.cwd));
    if (!cached) return;
    if (!rt.caps) return rt.setCaps(cached);
    // Codex's MCP inventory (and so its browser / computer-use plugin) arrives much later.
    if (rt.meta.provider === 'codex' && !rt.caps.mcpServers.length && cached.mcpServers.length) {
      const f = cached.features;
      rt.setCaps({ ...rt.caps, mcpServers: cached.mcpServers, features: { ...rt.caps.features, browser: f.browser, computerUse: f.computerUse, linkedBrowserComputer: f.linkedBrowserComputer } });
    }
  }

  private persistSessions() {
    this.store.state.sessions = [...[...this.sessions.values()].map((r) => r.meta), ...this.hidden];
    this.store.saveState();
  }

  private touchProject(dir: string): Project {
    const projects = this.store.state.projects;
    const key = path.resolve(dir);
    let p = projects.find((x) => path.resolve(x.path).toLowerCase() === key.toLowerCase());
    if (!p) {
      p = { path: key, name: path.basename(key) || key, lastOpened: Date.now() };
      projects.push(p);
    } else p.lastOpened = Date.now();
    this.store.saveState();
    this.emit({ type: 'projects.updated', projects });
    return p;
  }

  async state(): Promise<AppState> {
    const providers = await Promise.all([...this.providers.values()].map((p) => this.providerInfoFast(p.id).catch(() => fallbackInfo(p))));
    return {
      version: VERSION,
      platform: process.platform,
      home: homedir(),
      providers,
      projects: this.store.state.projects,
      sessions: [...this.sessions.values()].map((r) => r.meta),
      settings: this.store.state.settings,
    };
  }

  private registerCore() {
    this.register('app.hello', () => this.state());

    this.register('app.setSettings', ({ patch: raw }) => {
      // Backdrop images change only through backdrop.*; the config is always checked.
      const { backdropImages: _images, ...patch } = raw;
      if (patch.backdropConfig) patch.backdropConfig = normalizeBackdrop(patch.backdropConfig, this.store.state.settings.backdropImages.map((i) => i.id));
      this.store.state.settings = { ...this.store.state.settings, ...patch };
      this.store.saveState();
      this.emit({ type: 'settings.updated', settings: this.store.state.settings });
      // Which account is the default shows on every account.
      if (patch.defaultAccounts) for (const id of this.providers.keys()) void this.emitProvider(id).catch(() => {});
      return this.store.state.settings;
    });

    // ── auth ──
    this.register('auth.refresh', ({ provider, accountId }) => this.emitProvider(provider, accountId ?? DEFAULT_ACCOUNT));
    this.register('auth.login', async ({ provider, accountId = DEFAULT_ACCOUNT }) => {
      const p = this.provider(provider, accountId);
      const key = accountKey(provider, accountId);
      this.loginCancelled.delete(key);
      this.emit({ type: 'auth.progress', provider, accountId, state: 'started' });
      void p
        .login()
        .then(async () => {
          const info = await this.emitProvider(provider, accountId);
          const signedIn = info.accounts?.find((a) => a.id === accountId)?.auth.loggedIn;
          if (signedIn) this.emit({ type: 'auth.progress', provider, accountId, state: 'done' });
          else if (!this.loginCancelled.has(key)) this.emit({ type: 'auth.progress', provider, accountId, state: 'cancelled' });
        })
        .catch((err: Error) => {
          // Cancelling kills the CLI, which rejects the login: already reported as 'cancelled'.
          if (!this.loginCancelled.has(key)) this.emit({ type: 'auth.progress', provider, accountId, state: 'error', message: err.message });
        })
        .finally(() => this.loginCancelled.delete(key));
      return { started: true };
    });
    this.register('auth.cancel', async ({ provider, accountId = DEFAULT_ACCOUNT }) => {
      this.loginCancelled.add(accountKey(provider, accountId));
      await this.provider(provider, accountId).cancelLogin();
      this.emit({ type: 'auth.progress', provider, accountId, state: 'cancelled' });
      return { ok: true };
    });
    this.register('auth.logout', async ({ provider, accountId = DEFAULT_ACCOUNT }) => {
      await this.provider(provider, accountId).logout();
      this.limitsCache.delete(accountKey(provider, accountId));
      return this.emitProvider(provider, accountId);
    });

    // ── accounts ──
    this.register('account.add', async ({ provider, label }) => {
      this.provider(provider); // throws when the provider is not available
      const id = randomUUID().replace(/-/g, '').slice(0, 10);
      mkdirSync(this.accountDir(provider, id), { recursive: true });
      this.store.state.accounts.push({ id, provider, label: label?.trim() || this.nextLabel(provider), createdAt: Date.now() });
      this.store.saveState();
      const info = await this.emitProvider(provider);
      return { ...info, account: info.accounts!.find((a) => a.id === id)! };
    });
    this.register('account.rename', ({ provider, accountId, label }) => {
      const acc = this.findAccount(provider, accountId);
      if (!acc) throw new Error('Account not found');
      const name = label.trim().slice(0, 60);
      if (name) {
        acc.label = name;
        // The built-in account is stored once it has a name of its own.
        if (!this.store.state.accounts.includes(acc)) this.store.state.accounts.push(acc);
        this.store.saveState();
      }
      return this.emitProvider(provider);
    });
    this.register('account.remove', async ({ provider, accountId }) => {
      if (accountId === DEFAULT_ACCOUNT) throw new Error('The default account cannot be removed');
      if (!this.findAccount(provider, accountId)) throw new Error('Account not found');
      const mine = [...this.sessions.values()].filter((rt) => rt.meta.provider === provider && rt.meta.accountId === accountId);
      const busy = mine.filter((rt) => rt.meta.status === 'running' || rt.meta.status === 'awaiting' || rt.meta.status === 'starting');
      if (busy.length) throw new Error(busy.length === 1 ? 'A session with this account is still working. Stop it first.' : `${busy.length} sessions with this account are still working. Stop them first.`);
      for (const rt of mine) {
        rt.cancelPrompts();
        await rt.handle?.close().catch(() => {});
        rt.handle = undefined;
      }
      const key = accountKey(provider, accountId);
      const inst = this.instances.get(key);
      this.instances.delete(key);
      if (inst) {
        await inst.cancelLogin().catch(() => {});
        await inst.dispose().catch(() => {});
      }
      this.infoCache.delete(key);
      this.limitsCache.delete(key);
      this.store.state.accounts = this.store.state.accounts.filter((a) => !(a.provider === provider && a.id === accountId));
      const defaults = this.store.state.settings.defaultAccounts;
      if (defaults?.[provider] === accountId) {
        const next = { ...defaults };
        delete next[provider];
        this.store.state.settings = { ...this.store.state.settings, defaultAccounts: next };
        this.emit({ type: 'settings.updated', settings: this.store.state.settings });
      }
      this.store.saveState();
      this.removeAccountDir(provider, accountId);
      return this.emitProvider(provider);
    });

    this.register('provider.caps', ({ provider, cwd, accountId }) => this.capsFast(provider, cwd, accountId));
    this.register('provider.prewarm', (p) => this.prewarm(p));
    this.register('provider.limits', async ({ provider, accountId = DEFAULT_ACCOUNT, force }) => {
      const key = accountKey(provider, accountId);
      const seq = this.limitsSeq.get(key) ?? 0;
      const limits = await this.provider(provider, accountId).limits(!!force);
      this.limitsCache.set(key, limits);
      // A provider that read them announced it already (with what it knows about the read).
      if ((this.limitsSeq.get(key) ?? 0) === seq) this.emit({ type: 'limits.updated', provider, accountId, limits });
      return limits;
    });

    // ── projects ──
    this.register('project.add', ({ path: dir }) => this.touchProject(dir));
    this.register('project.remove', ({ path: dir }) => {
      this.store.state.projects = this.store.state.projects.filter((p) => p.path !== dir);
      this.store.saveState();
      this.emit({ type: 'projects.updated', projects: this.store.state.projects });
      return { ok: true };
    });
    this.register('project.pin', ({ path: dir, pinned }) => {
      // A folder known only through its sessions becomes a project when pinned.
      const p = this.store.state.projects.find((x) => x.path === dir) ?? (pinned ? this.touchProject(dir) : undefined);
      if (p) p.pinned = pinned;
      this.store.saveState();
      this.emit({ type: 'projects.updated', projects: this.store.state.projects });
      return { ok: true };
    });

    // ── sessions ──
    this.register('session.create', async (p) => {
      const accountId = p.accountId ?? this.defaultAccountId(p.provider);
      const provider = this.provider(p.provider, accountId);
      // The demo provider plays scripted sessions in made-up folders; real agents need a real one.
      if (p.provider !== 'demo' && !isDir(path.resolve(p.cwd))) throw new Error(`Folder not found: ${path.resolve(p.cwd)}`);
      const settings = this.store.state.settings;
      const now = Date.now();
      const meta: SessionMeta = {
        id: randomUUID(),
        provider: p.provider,
        providerSessionId: p.resume,
        cwd: path.resolve(p.cwd),
        title: p.title ?? 'New session',
        titleSource: p.title ? 'user' : 'auto',
        model: p.model ?? settings.defaultModels[p.provider] ?? '',
        effort: p.effort ?? settings.defaultEfforts[p.provider],
        mode: p.mode ?? settings.defaultModes[p.provider] ?? 'default',
        ...(p.ultracode ? { ultracode: true } : {}),
        status: 'starting',
        createdAt: now,
        updatedAt: now,
        usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
      };
      if (accountId !== DEFAULT_ACCOUNT) meta.accountId = accountId;
      const options = p.options ?? settings.sessionOptions?.[p.provider];
      if (options && Object.keys(options).length) meta.options = { ...options };
      const rt = this.makeRuntime(meta);
      this.sessions.set(meta.id, rt);
      this.touchProject(meta.cwd);
      this.emit({ type: 'session.added', session: meta });
      try {
        rt.handle = await provider.open(rt, { loadTranscript: !!p.resume });
        rt.update({ status: 'idle' });
        this.seedCaps(rt);
        if (p.provider === 'claude' && meta.options?.remoteControl) void rt.handle.setOptions?.(meta.options).catch((err) => rt.notice('error', 'Remote Control could not start', (err as Error).message));
      } catch (err) {
        rt.update({ status: 'error', lastError: (err as Error).message });
      }
      this.persistSessions();
      return rt.snapshot();
    });

    this.register('session.snapshot', ({ sessionId }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      if (rt.meta.unread) rt.update({ unread: false });
      return rt.snapshot();
    });

    this.register('session.send', async ({ sessionId, text, attachments, steer }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      // While the agent works the bridge holds the message until the turn ends, unless it is
      // steered into the running turn (and the agent can take one).
      if (rt.turnActive && !(steer && rt.caps?.features.steer !== false)) {
        rt.enqueue(text, attachments);
        return { ok: true, queued: true };
      }
      await this.deliver(rt, text, attachments);
      return { ok: true };
    });

    this.register('queue.update', ({ sessionId, id, text, attachments }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      return { ok: rt.updateQueued(id, text, attachments) };
    });
    this.register('queue.take', ({ sessionId, id }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      const message = rt.takeQueued(id);
      return message ? { message } : {};
    });
    this.register('queue.reorder', ({ sessionId, ids }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      rt.reorderQueued(Array.isArray(ids) ? ids : []);
      return { ok: true };
    });
    this.register('queue.remove', ({ sessionId, id }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      return { ok: !!rt.takeQueued(id) };
    });
    this.register('queue.sendNow', async ({ sessionId, id }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      const q = rt.takeQueued(id);
      if (!q) return { ok: false };
      // Mid-turn this is steered into the running turn.
      await this.deliver(rt, q.text, q.attachments);
      return { ok: true };
    });

    this.register('session.interrupt', async ({ sessionId }) => {
      const rt = this.runtime(sessionId);
      if (rt.turnActive) rt.stopRequested = true;
      rt.cancelPrompts();
      await rt.handle?.interrupt();
      return { ok: true };
    });

    this.register('session.setModel', async ({ sessionId, model }) => {
      const rt = this.runtime(sessionId);
      await rt.handle?.setModel(model);
      rt.update({ model });
      return { ok: true };
    });
    this.register('session.setEffort', async ({ sessionId, effort }) => {
      const rt = this.runtime(sessionId);
      await rt.handle?.setEffort(effort);
      rt.update({ effort });
      return { ok: true };
    });
    this.register('session.setMode', async ({ sessionId, mode }) => {
      const rt = this.runtime(sessionId);
      await rt.handle?.setMode(mode);
      rt.update({ mode });
      return { ok: true };
    });
    this.register('session.setFast', async ({ sessionId, fast }) => {
      const rt = this.runtime(sessionId);
      await rt.handle?.setFast?.(fast);
      rt.update({ fast });
      return { ok: true };
    });
    this.register('session.setUltracode', async ({ sessionId, on }) => {
      const rt = this.runtime(sessionId);
      const before = !!rt.meta.ultracode;
      // The adapter reads the meta at the next start, so it changes first (false, not undefined: patches travel as JSON).
      rt.update({ ultracode: on });
      try {
        await rt.handle?.setUltracode?.(on);
      } catch (err) {
        rt.update({ ultracode: before });
        rt.notice('error', on ? 'Ultracode could not be turned on' : 'Ultracode could not be turned off', (err as Error).message);
        return { ok: false };
      }
      return { ok: true };
    });

    this.register('session.rename', ({ sessionId, title }) => {
      this.runtime(sessionId).update({ title: title.trim() || 'Untitled', titleSource: 'user' });
      return { ok: true };
    });
    this.register('session.update', ({ sessionId, patch }) => {
      this.runtime(sessionId).update(patch);
      return { ok: true };
    });

    this.register('session.close', async ({ sessionId, remove }) => {
      const rt = this.runtime(sessionId);
      rt.stopRequested = true;
      rt.cancelPrompts();
      await rt.handle?.close().catch(() => {});
      rt.handle = undefined;
      if (rt.turnActive) {
        rt.settle('cancelled');
        rt.endTurn();
      }
      if (remove) {
        this.sessions.delete(sessionId);
        this.store.deleteSession(sessionId);
        this.emit({ type: 'session.removed', id: sessionId });
      }
      this.persistSessions();
      return { ok: true };
    });

    this.register('session.rewind', async ({ sessionId, itemId, restoreFiles }) => {
      const rt = this.runtime(sessionId);
      const handle = await this.ensureHandle(rt);
      if (!handle.rewind) return { ok: false, message: 'This provider cannot rewind.' };
      return handle.rewind(itemId, restoreFiles);
    });
    this.register('session.context', async ({ sessionId }) => (await this.runtime(sessionId).handle?.context?.()) ?? null);
    this.register('session.setOptions', async ({ sessionId, options }) => {
      const rt = this.runtime(sessionId);
      const next = { ...rt.meta.options, ...options };
      rt.update({ options: next });
      this.persistSessions();
      try {
        const handle = await this.ensureHandle(rt);
        await handle.setOptions?.(next);
      } catch (err) {
        rt.notice('error', 'Could not apply the change', (err as Error).message);
      }
      return { ok: true };
    });

    this.register('session.mcp', async ({ sessionId }) => {
      const rt = this.runtime(sessionId);
      const fresh = await rt.handle?.mcp?.();
      if (!fresh) return rt.caps?.mcpServers ?? [];
      // Keep the session's capabilities in step with what was just read.
      if (rt.caps) rt.setCaps({ ...rt.caps, mcpServers: fresh });
      return fresh;
    });

    this.register('permission.respond', ({ sessionId, requestId, optionId, message }) => ({
      ok: this.runtime(sessionId).answerPermission(requestId, { optionId, message }),
    }));
    this.register('question.respond', ({ sessionId, requestId, answers }) => ({
      ok: this.runtime(sessionId).answerQuestion(requestId, answers),
    }));

    this.register('history.list', ({ provider, cwd, limit, accountId }) => this.provider(provider, accountId).history(cwd, limit));
  }

  private disposed = false;

  async dispose() {
    this.disposed = true;
    for (const fn of this.disposers.splice(0)) await Promise.resolve(fn()).catch(() => {});
    for (const rt of this.sessions.values()) {
      rt.cancelPrompts();
      await rt.handle?.close().catch(() => {});
    }
    await Promise.all([...this.providers.values(), ...this.instances.values()].map((p) => p.dispose().catch(() => {})));
    this.instances.clear();
    await this.store.flush();
    await this.cache.flush();
  }
}

function isDir(dir: string) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** How long after start-up cached provider info is checked against the CLI. */
const INFO_REFRESH_DELAY_MS = 15_000;
/** How long after a cached capabilities answer the fresh one is fetched. */
const CAPS_REFRESH_DELAY_MS = 2_500;

/** Cached capabilities are per agent, account and folder (plan models, project skills and MCP servers differ). */
function capsCacheKey(provider: ProviderId, accountId: string, cwd?: string) {
  return `caps:${provider}:${accountId}:${cwd ? path.resolve(cwd).toLowerCase() : ''}`;
}

function fallbackInfo(p: Provider) {
  return { id: p.id, name: p.name, installed: false, auth: { loggedIn: false }, problem: 'Could not query the CLI' };
}
