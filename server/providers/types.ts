import type {
  UserItem,
  Capabilities,
  ContextBreakdown,
  Effort,
  HistoryEntry,
  McpServerInfo,
  ProviderId,
  ProviderInfo,
  RateLimit,
  BridgeEvent,
  SessionOptions,
  AppSettings,
  ResetOutcome,
} from '../../shared/protocol';
import type { SessionRuntime } from '../core/runtime';

/** The account a provider instance serves. One instance exists per (provider, account) in use. */
export interface AccountContext {
  id: string;
  /**
   * The account's own config folder, managed by Sable. Absent for the built-in default
   * account, which uses the CLI's own config exactly as before.
   */
  dir?: string;
}

export interface ProviderContext {
  /** Events from this instance; the app tags auth and limit events with the account id. */
  emit: (event: BridgeEvent) => void;
  log: (...args: unknown[]) => void;
  /** Absent means the built-in default account. */
  account?: AccountContext;
  /** The app's current settings (read when an agent process starts). Absent in bare tests. */
  settings?: () => AppSettings;
}

/** A live connection between one SessionRuntime and the provider's agent process. */
export interface ProviderSession {
  /**
   * Delivers a user message. The UserItem is already on the timeline; when a turn is
   * running its `state` is "queued" and the adapter flips it to "sent" once consumed
   * (`rt.taken`). A `steered` item goes to the running agent now, to be taken at its next step.
   */
  send(item: UserItem): Promise<void>;
  interrupt(): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort(effort: Effort): Promise<void>;
  setMode(mode: string): Promise<void>;
  setFast?(fast: boolean): Promise<void>;
  /** The session's speed (`rt.meta.speed` already holds it): `standard` or a `SpeedInfo` id of its model. */
  setSpeed?(speed: string): Promise<void>;
  /** Claude Code ultracode on or off (`rt.meta.ultracode` already holds it). */
  setUltracode?(on: boolean): Promise<void>;
  rewind?(itemId: string, restoreFiles: boolean): Promise<{ ok: boolean; message?: string }>;
  /**
   * The agent's own fork at the end of the turn holding `itemId`: the new provider session id
   * (resumable), or null when it cannot (Sable then starts from a summary). The source stays as it is.
   */
  fork?(itemId: string): Promise<string | null>;
  context?(): Promise<ContextBreakdown | null>;
  mcp?(): Promise<McpServerInfo[]>;
  /**
   * Applies changed capabilities (`rt.meta.options` already holds them). Options that need a
   * new agent process restart it when idle and wait for the turn to end otherwise.
   */
  setOptions?(options: SessionOptions): Promise<void>;
  /** Releases the agent process. The session can be re-opened (resumed) later. */
  close(): Promise<void>;
}

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  info(force?: boolean): Promise<ProviderInfo>;
  login(): Promise<void>;
  cancelLogin(): Promise<void>;
  logout(): Promise<void>;
  /** Capabilities before a session exists (used by the home composer). */
  caps(cwd?: string): Promise<Capabilities>;
  /**
   * Plan limits. Emits `limits.updated` with `meta` when it actually read them; returns the last
   * known ones otherwise. `force`: the user asked (the agent may start a short process to read them).
   */
  limits(force?: boolean): Promise<RateLimit[]>;
  /**
   * Spends one of the account's reset credits (only on the user's confirmed click), then reads
   * the limits again. Present only for agents that report resets. `key` makes a retry idempotent.
   */
  useReset?(key: string): Promise<ResetOutcome>;
  history(cwd?: string, limit?: number): Promise<HistoryEntry[]>;
  /**
   * Binds a runtime to the provider. When `rt.meta.providerSessionId` is set the
   * provider resumes that conversation; if `loadTranscript` is true it must also
   * fill the runtime's timeline from the provider's stored history.
   */
  open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession>;
  /**
   * Starts an agent process for a session that is about to be created (no prompt is sent, so
   * no tokens). The first session opened with the same choice adopts it. One at a time.
   */
  prewarm?(choice: WarmChoice): Promise<void>;
  /** Stops the warm process, if any. */
  discardWarm?(): Promise<void>;
  /** The config folder this account's agent reads and writes (its transcripts live there). */
  configHome?(): string;
  /**
   * Makes a conversation stored under another account of this agent (`fromHome`, that account's
   * `configHome()`) resumable by this one. True when this account can now resume `providerSessionId`.
   */
  adoptConversation?(fromHome: string, providerSessionId: string): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface WarmChoice {
  cwd: string;
  model?: string;
  mode?: string;
  effort?: Effort;
  options?: SessionOptions;
  ultracode?: boolean;
}
