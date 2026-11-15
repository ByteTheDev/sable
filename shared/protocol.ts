/**
 * Sable wire protocol — the single contract between the bridge (Node) and the UI.
 *
 * The bridge owns all state (sessions, timelines, pending prompts). The UI is a view:
 * it calls RPC methods and applies pushed events. Every provider (Claude Code, Codex,
 * the scripted demo) is normalized into the same timeline model so the UI never
 * branches on provider.
 */

// ───────────────────────────── providers & auth ─────────────────────────────

export type ProviderId = 'claude' | 'codex' | 'demo';

export interface AuthState {
  loggedIn: boolean;
  /** e.g. "claude.ai", "chatgpt", "apiKey" */
  method?: string;
  email?: string;
  /**
   * Display-ready name of the connected plan: "Max", "Pro", "Ultra", "Team", "Plus",
   * "Business", "API key", "Console"… Absent when unknown.
   */
  plan?: string;
  /** The agent's raw plan / subscription value ("max", "plus", "Claude Ultra"…), when it reported one. */
  planId?: string;
  org?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  installed: boolean;
  version?: string;
  /** The built-in default account's sign-in (same as `accounts[0].auth`). */
  auth: AuthState;
  /** Set when the CLI is missing or broken. */
  problem?: string;
  /** Every profile of this agent, the built-in `default` first. Absent from older bridges. */
  accounts?: AccountInfo[];
}

/** The id of the account every provider always has: the CLI's own config (~/.claude, ~/.codex). */
export const DEFAULT_ACCOUNT = 'default';

/**
 * A named, isolated agent profile. Extra accounts get their own config folder managed by
 * Sable (own sign-in, settings, skills, plugins, MCP servers and history).
 */
export interface AccountInfo {
  id: string;
  provider: ProviderId;
  label: string;
  /** New sessions with this agent use this account unless told otherwise. */
  isDefault: boolean;
  auth: AuthState;
  /** Plan limits, when known. */
  limits?: RateLimit[];
  /** The account's config folder; absent for the built-in default (the CLI's own). */
  dir?: string;
  problem?: string;
}

/** Reasoning effort, lowest first. `ultra` is Codex's level above `max` (the model may delegate to sub-agents). */
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  efforts?: Effort[];
  defaultEffort?: Effort;
  supportsFast?: boolean;
  isDefault?: boolean;
}

export type ModeTone = 'ask' | 'edit' | 'plan' | 'auto' | 'danger';

/** A permission / approval preset. Ids are provider-defined. */
export interface ModeInfo {
  id: string;
  name: string;
  description: string;
  tone: ModeTone;
}

export type CommandKind = 'app' | 'builtin' | 'command' | 'skill';

export interface CommandInfo {
  /** Without the leading slash. */
  name: string;
  description: string;
  argumentHint?: string;
  kind: CommandKind;
  source?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  source?: string;
  path?: string;
  enabled?: boolean;
}

export interface AgentInfo {
  name: string;
  description: string;
  model?: string;
  source?: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
}

export interface McpServerInfo {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  scope?: string;
  error?: string;
  version?: string;
  tools?: McpToolInfo[];
}

export interface Capabilities {
  models: ModelInfo[];
  modes: ModeInfo[];
  commands: CommandInfo[];
  skills: SkillInfo[];
  agents: AgentInfo[];
  mcpServers: McpServerInfo[];
  tools: string[];
  /** Character that invokes a skill inline: "/" for Claude Code, "$" for Codex. */
  skillTrigger: '/' | '$';
  features: {
    images: boolean;
    thinking: boolean;
    rewind: boolean;
    /** Can a message be injected while a turn is running? */
    steer: boolean;
    compact: boolean;
    fast: boolean;
    /** The agent can drive a web browser in this setup (Claude in Chrome, Codex's browser plugin). */
    browser?: boolean;
    /** The agent can see and control the desktop in this setup. */
    computerUse?: boolean;
    /** The session can be continued from another device (claude.ai/code, the ChatGPT app). */
    remoteControl?: boolean;
    /** Codex: browser and computer use come from one plugin and switch together. */
    linkedBrowserComputer?: boolean;
    /** Claude Code's ultracode mode (standing workflow orchestration) can be switched (`session.setUltracode`). */
    ultracode?: boolean;
  };
}

/** Per-session agent capabilities the user switches on. Applied when the agent process starts. */
export interface SessionOptions {
  browser?: boolean;
  computerUse?: boolean;
  remoteControl?: boolean;
}

/** State of an optional capability the user may need to act on. */
export interface CapabilityState {
  /** One short line: "Connected to Chrome", "Chrome extension not connected". */
  status: string;
  tone?: 'ok' | 'waiting' | 'error';
  /** A link to open (the remote session). */
  url?: string;
  /** A code to type on the other device. */
  code?: string;
}

// ───────────────────────────────── sessions ─────────────────────────────────

export type SessionStatus = 'idle' | 'starting' | 'running' | 'awaiting' | 'error';

export interface SessionUsage {
  contextTokens?: number;
  contextWindow?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  costUsd?: number;
  turns: number;
}

export interface SessionMeta {
  id: string;
  provider: ProviderId;
  /** The provider's own id (Claude session uuid / Codex thread id) once known. */
  providerSessionId?: string;
  cwd: string;
  title: string;
  titleSource: 'auto' | 'user';
  model: string;
  effort?: Effort;
  mode: string;
  fast?: boolean;
  /** Claude Code ultracode is on for this session (see `Capabilities.features.ultracode`). */
  ultracode?: boolean;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  unread?: boolean;
  pinned?: boolean;
  archived?: boolean;
  branch?: string;
  usage: SessionUsage;
  lastError?: string;
  /** One line describing what the agent is doing right now. */
  activity?: string;
  /** The account the session runs under; absent means `default`. */
  accountId?: string;
  /** Capabilities switched on for this session (browser, computer use, remote control). */
  options?: SessionOptions;
  /** Remote control state: the link or pairing code to continue elsewhere. */
  remote?: { url?: string; code?: string; status: string; tone?: CapabilityState['tone'] };
  /** Live state of the browser and computer-use capabilities, when there is something to say. */
  capState?: { browser?: CapabilityState; computerUse?: CapabilityState };
}

/** A session that exists on disk at the provider but is not open in Sable. */
export interface HistoryEntry {
  provider: ProviderId;
  providerSessionId: string;
  title: string;
  cwd?: string;
  branch?: string;
  updatedAt: number;
  preview?: string;
}

// ───────────────────────────────── timeline ─────────────────────────────────

export interface Attachment {
  id: string;
  kind: 'image' | 'file' | 'text';
  name: string;
  /** Absolute path for files; data URL for pasted images. */
  path?: string;
  dataUrl?: string;
  mime?: string;
  size?: number;
  text?: string;
}

interface BaseItem {
  id: string;
  /**
   * When the item was created (ms since epoch): when a message was sent (or taken from the
   * queue), when a text or thinking block started streaming, when a tool call began. Items
   * loaded from history carry the provider's stored times.
   */
  ts: number;
  /** Tool item id of the subagent this item belongs to. */
  parentId?: string;
}

export interface UserItem extends BaseItem {
  type: 'user';
  text: string;
  attachments?: Attachment[];
  /**
   * 'queued': handed to the agent while it works, not taken yet (a steered message stays where
   * it was sent; other queued items move down to where the agent takes them). 'sent': taken.
   */
  state?: 'queued' | 'sent';
  /** Sent into a running turn (`session.send` with `steer`, or `queue.sendNow`): the agent takes it at its next step. */
  steered?: boolean;
  /** Provider message id, used for rewind. */
  providerId?: string;
}

export interface TextItem extends BaseItem {
  type: 'text';
  text: string;
  streaming: boolean;
}

export interface ThinkingItem extends BaseItem {
  type: 'thinking';
  text: string;
  streaming: boolean;
  endedAt?: number;
}

export type ToolKind =
  | 'bash'
  | 'read'
  | 'edit'
  | 'write'
  | 'search'
  | 'glob'
  | 'fetch'
  | 'websearch'
  | 'agent'
  | 'todo'
  | 'mcp'
  | 'question'
  | 'plan'
  | 'skill'
  | 'other';

export type ToolStatus = 'pending' | 'running' | 'awaiting' | 'done' | 'error' | 'denied' | 'cancelled';

export interface Todo {
  id?: string;
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Lines prefixed with " ", "+" or "-". */
  lines: string[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  binary?: boolean;
}

/** Normalized, display-ready view of a tool's input. All fields optional. */
export interface ToolDetail {
  command?: string;
  description?: string;
  cwd?: string;
  background?: boolean;
  path?: string;
  range?: [number, number];
  pattern?: string;
  glob?: string;
  url?: string;
  query?: string;
  oldText?: string;
  newText?: string;
  content?: string;
  subagent?: string;
  prompt?: string;
  todos?: Todo[];
  questions?: Question[];
  plan?: string;
  server?: string;
  tool?: string;
  skill?: string;
}

export interface ToolResult {
  text?: string;
  stderr?: string;
  exitCode?: number;
  isError?: boolean;
  interrupted?: boolean;
  diff?: FileDiff[];
  file?: { path: string; content?: string; startLine?: number; numLines?: number; totalLines?: number };
  files?: string[];
  count?: number;
  links?: { title: string; url: string }[];
  images?: string[];
  answers?: Record<string, string[]>;
  truncated?: boolean;
}

export interface ToolItem extends BaseItem {
  type: 'tool';
  /** Raw provider tool name, e.g. "Bash", "mcp__github__create_issue". */
  name: string;
  kind: ToolKind;
  /** Short human label: "Read session.ts", "Run tests". */
  title: string;
  status: ToolStatus;
  detail: ToolDetail;
  /** Raw input; while streaming this may be missing and `inputText` grows. */
  input?: unknown;
  inputText?: string;
  /** Live output while running (bash stdout etc). */
  output?: string;
  result?: ToolResult;
  endedAt?: number;
}

export interface NoticeItem extends BaseItem {
  type: 'notice';
  variant: 'info' | 'error' | 'interrupted' | 'compact' | 'retry' | 'mode' | 'model' | 'command' | 'rewind';
  text: string;
  detail?: string;
}

/** Closes a turn: duration, cost, token counts. */
export interface TurnItem extends BaseItem {
  type: 'turn';
  durationMs: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  error?: string;
}

export type TimelineItem = UserItem | TextItem | ThinkingItem | ToolItem | NoticeItem | TurnItem;

// ───────────────────────────── prompts to the user ──────────────────────────

export interface PermissionOption {
  id: string;
  label: string;
  hint?: string;
  tone: 'allow' | 'always' | 'deny';
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  /** Tool item this request gates, if any. */
  itemId?: string;
  toolName: string;
  kind: ToolKind;
  title: string;
  description?: string;
  detail: ToolDetail;
  diff?: FileDiff[];
  reason?: string;
  options: PermissionOption[];
  /** When true the UI offers a free-text field with the deny option. */
  allowFeedback?: boolean;
  createdAt: number;
}

export interface QuestionRequest {
  id: string;
  sessionId: string;
  itemId?: string;
  questions: Question[];
  createdAt: number;
}

// ─────────────────────────────── workspace data ─────────────────────────────

export interface Project {
  path: string;
  name: string;
  lastOpened: number;
  pinned?: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
  ignored?: boolean;
}

export interface GitFileStatus {
  path: string;
  /** Short status: M, A, D, R, ?, U */
  status: string;
  staged: boolean;
  additions?: number;
  deletions?: number;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  files: GitFileStatus[];
  additions: number;
  deletions: number;
}

export interface RateLimit {
  id: string;
  label: string;
  /** 0..100 */
  percent: number;
  resetsAt?: number;
}

export interface ContextBreakdown {
  totalTokens: number;
  maxTokens: number;
  percent: number;
  model?: string;
  categories: { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' }[];
}

export interface MemoryFile {
  path: string;
  scope: 'user' | 'project' | 'local';
  exists: boolean;
  content?: string;
}

export type BackdropSource = 'pattern' | 'image' | 'off';
export type BackdropPattern = 'streaks' | 'tubes' | 'tiles' | 'aurora';
/** halftone: round dots sized by brightness; soft: no texture (a smooth field, or the image itself). */
export type BackdropStyle = 'dither' | 'ascii' | 'halftone' | 'soft';
/** agent: the active agent's palette; image: the image's own colours (image source only). */
export type BackdropColour = 'agent' | 'mono' | 'custom' | 'image';

/**
 * The light behind home, sessions and onboarding. Always pass stored or user values through
 * `normalizeBackdrop` (`shared/backdrop.ts`), which also holds the default and the presets.
 */
export interface BackdropConfig {
  source: BackdropSource;
  pattern: BackdropPattern;
  /** An uploaded image (`AppSettings.backdropImages`), drawn when `source` is 'image'. */
  image: string | null;
  style: BackdropStyle;
  /** Strength on the home screen and onboarding, 0–100 (0 draws nothing). */
  amount: number;
  /** Strength of the band behind a session's composer, 0–100 (0 draws nothing). */
  sessionAmount: number;
  /** Where the light gathers, 0–1 across and down the stage. */
  focus: { x: number; y: number };
  /** How far the light spreads from the focus, 0–100; 100 is the whole background evenly. */
  reach: number;
  /** Cell size, 0 coarse to 100 fine. */
  detail: number;
  /** 0 is completely still. */
  speed: number;
  /** Direction of streaks and of the tubes' wave, degrees 0–180. */
  angle: number;
  colour: BackdropColour;
  /** Custom colour: hue 0–360 and saturation 0–100. */
  hue: number;
  saturation: number;
  /** The light answers the pointer and swells when a message is sent. */
  react: boolean;
}

/**
 * Subtle: low strength over the full stage, fine cells, slow drift (the Streaks and Vivid presets
 * are the louder steps). Lives here (not
 * in `shared/backdrop.ts`) so this module imports nothing at run time.
 */
export const DEFAULT_BACKDROP: BackdropConfig = {
  source: 'pattern',
  pattern: 'streaks',
  image: null,
  style: 'dither',
  amount: 14,
  sessionAmount: 30,
  focus: { x: 0.72, y: 0.78 },
  reach: 100,
  detail: 90,
  speed: 30,
  angle: 35,
  colour: 'agent',
  hue: 28,
  saturation: 70,
  react: true,
};

/** An image uploaded for the backdrop. Ids come from the bridge only. */
export interface BackdropImage {
  id: string;
  type: string;
  width: number;
  height: number;
  bytes: number;
  addedAt: number;
}

export interface AppSettings {
  accent: 'spectrum' | 'ember' | 'iris' | 'mint';
  ambience: 'full' | 'calm' | 'off';
  fontScale: number;
  defaultProvider: ProviderId;
  defaultModels: Partial<Record<ProviderId, string>>;
  defaultModes: Partial<Record<ProviderId, string>>;
  defaultEfforts: Partial<Record<ProviderId, Effort>>;
  notifyOnDone: boolean;
  sendWithEnter: boolean;
  showThinking: boolean;
  /** The light behind the home screen ('bloom' is no longer offered but still draws for older settings). */
  backdrop: 'streaks' | 'tubes' | 'tiles' | 'aurora' | 'bloom';
  /** How every light field is drawn: dithered tiles or characters. */
  texture: 'dither' | 'ascii';
  /** The backdrop as drawn (`ambience`, `backdrop` and `texture` are kept only for older profiles). */
  backdropConfig: BackdropConfig;
  /** Uploaded backdrop images; changed only through the `backdrop.*` methods. */
  backdropImages: BackdropImage[];
  /** The first-run welcome has been shown (or skipped). Installs from before it existed are marked by the UI. */
  onboarded: boolean;
  /** Which account new sessions use per agent; absent means `default`. */
  defaultAccounts?: Partial<Record<ProviderId, string>>;
  /**
   * Models shown or hidden in the model menu, keyed `${provider}:${modelId}`. Absent means
   * the default: only the current generation (see `src/lib/models.ts`).
   */
  modelVisibility?: Record<string, boolean>;
  /** Capabilities new sessions start with, per agent. */
  sessionOptions?: Partial<Record<ProviderId, SessionOptions>>;
  /** Start the agent process while the home composer is focused, so the first reply comes sooner. Absent means on. */
  prewarm?: boolean;
  /**
   * Ask agents for short final answers (and a localhost link when there is something to view).
   * Appended to the agent's own system prompt; applies when an agent process starts.
   */
  conciseReplies: boolean;
}

/** One permission rule set from an agent's settings file (read-only view). */
export interface ConfigPermissions {
  allow: string[];
  ask: string[];
  deny: string[];
  defaultMode?: string;
  additionalDirectories: string[];
}

export interface ConfigHook {
  event: string;
  matcher?: string;
  /** The command (or prompt / url for non-command hooks), with secret-looking values masked. */
  command: string;
  type: string;
}

/** An agent settings file as Sable shows it. Secrets (env, API keys, tokens) are never included. */
export interface AgentConfigFile {
  path: string;
  scope: 'user' | 'project' | 'local';
  exists: boolean;
  format: 'json' | 'toml';
  /** The file exists but could not be read or parsed. */
  error?: string;
  permissions?: ConfigPermissions;
  hooks?: ConfigHook[];
  /** TOML files: the text with secret values masked, capped at 64 KB. */
  raw?: string;
  truncated?: boolean;
}

export interface GitCommitResult {
  ok: boolean;
  /** Short hash of the new commit. */
  hash?: string;
  /** First line of the commit message. */
  summary?: string;
  error?: string;
}

export interface AppState {
  version: string;
  platform: string;
  home: string;
  providers: ProviderInfo[];
  projects: Project[];
  sessions: SessionMeta[];
  settings: AppSettings;
}

// ─────────────────────────────────── events ─────────────────────────────────

export type BridgeEvent =
  | { type: 'provider.updated'; provider: ProviderInfo }
  | { type: 'auth.progress'; provider: ProviderId; accountId?: string; state: 'started' | 'url' | 'done' | 'error' | 'cancelled'; url?: string; message?: string }
  | { type: 'projects.updated'; projects: Project[] }
  | { type: 'settings.updated'; settings: AppSettings }
  | { type: 'session.added'; session: SessionMeta }
  | { type: 'session.updated'; id: string; patch: Partial<SessionMeta> }
  | { type: 'session.removed'; id: string }
  | { type: 'session.caps'; id: string; caps: Capabilities }
  | { type: 'item.added'; sessionId: string; item: TimelineItem }
  | { type: 'item.delta'; sessionId: string; id: string; field: 'text' | 'inputText' | 'output'; delta: string }
  | { type: 'item.patch'; sessionId: string; id: string; patch: Partial<TimelineItem> }
  | { type: 'item.removed'; sessionId: string; id: string }
  | { type: 'timeline.reset'; sessionId: string; items: TimelineItem[] }
  | { type: 'permission.added'; request: PermissionRequest }
  | { type: 'permission.removed'; sessionId: string; id: string }
  | { type: 'question.added'; request: QuestionRequest }
  | { type: 'question.removed'; sessionId: string; id: string }
  | { type: 'todos.updated'; sessionId: string; todos: Todo[] }
  | { type: 'suggestion'; sessionId: string; text: string }
  | { type: 'queue.updated'; sessionId: string; queue: QueuedMessage[] }
  | { type: 'limits.updated'; provider: ProviderId; accountId?: string; limits: RateLimit[] }
  /** Fresh capabilities for the home composer (after a cached answer was served first). */
  | { type: 'caps.updated'; provider: ProviderId; accountId?: string; cwd?: string; caps: Capabilities }
  | { type: 'term.data'; termId: string; data: string; stream: 'out' | 'err' }
  | { type: 'term.exit'; termId: string; code: number | null }
  | { type: 'toast'; level: 'info' | 'success' | 'error'; text: string };

// ──────────────────────────────────── RPC ───────────────────────────────────

export interface SessionSnapshot {
  session: SessionMeta;
  items: TimelineItem[];
  caps?: Capabilities;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  todos: Todo[];
  suggestion?: string;
  /** Messages sent while a turn was running, waiting for it to end. */
  queue: QueuedMessage[];
}

/**
 * A message the user sent while the agent was busy. The bridge holds it (it is not in the
 * timeline yet) and sends it when the turn ends normally, one per turn end.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: Attachment[];
  createdAt: number;
}

export interface RpcMethods {
  'app.hello': { params: Record<string, never>; result: AppState };
  'app.setSettings': { params: { patch: Partial<AppSettings> }; result: AppSettings };

  'auth.refresh': { params: { provider: ProviderId; accountId?: string }; result: ProviderInfo };
  'auth.login': { params: { provider: ProviderId; accountId?: string }; result: { started: boolean } };
  'auth.cancel': { params: { provider: ProviderId; accountId?: string }; result: { ok: boolean } };
  'auth.logout': { params: { provider: ProviderId; accountId?: string }; result: ProviderInfo };

  /** Adds an account with its own empty config folder; the result carries the new `account`. Sign in next with `auth.login`. */
  'account.add': { params: { provider: ProviderId; label?: string }; result: ProviderInfo & { account: AccountInfo } };
  'account.rename': { params: { provider: ProviderId; accountId: string; label: string }; result: ProviderInfo };
  /** Never the default. Refuses while one of its sessions is busy; deletes the account's folder. */
  'account.remove': { params: { provider: ProviderId; accountId: string }; result: ProviderInfo };

  /** Models, modes, commands… for a provider before any session exists. */
  'provider.caps': { params: { provider: ProviderId; cwd?: string; accountId?: string }; result: Capabilities };
  'provider.limits': { params: { provider: ProviderId; accountId?: string }; result: RateLimit[] };
  /**
   * Starts the agent process for the session about to be created from the home composer (no
   * prompt is sent). `session.create` with the same choice adopts it. At most one is kept.
   */
  'provider.prewarm': {
    params: { provider: ProviderId; accountId?: string; cwd: string; model?: string; mode?: string; effort?: Effort; ultracode?: boolean };
    result: { ok: boolean };
  };

  'project.add': { params: { path: string }; result: Project };
  'project.remove': { params: { path: string }; result: { ok: boolean } };
  'project.pin': { params: { path: string; pinned: boolean }; result: { ok: boolean } };

  'session.create': {
    params: { provider: ProviderId; cwd: string; model?: string; effort?: Effort; mode?: string; resume?: string; title?: string; accountId?: string; options?: SessionOptions; ultracode?: boolean };
    result: SessionSnapshot;
  };
  'session.snapshot': { params: { sessionId: string }; result: SessionSnapshot };
  /**
   * Sends a message. While a turn runs it is held in the queue (sent when the turn ends), or with
   * `steer` handed to the running agent now: it shows in the timeline where it was sent
   * (`UserItem.steered`) and the agent takes it at its next step. Without a running turn `steer`
   * changes nothing. An agent that cannot steer (`caps.features.steer` false) queues it instead.
   */
  'session.send': { params: { sessionId: string; text: string; attachments?: Attachment[]; steer?: boolean }; result: { ok: boolean; queued?: boolean } };
  'session.interrupt': { params: { sessionId: string }; result: { ok: boolean } };
  'session.setModel': { params: { sessionId: string; model: string }; result: { ok: boolean } };
  'session.setEffort': { params: { sessionId: string; effort: Effort }; result: { ok: boolean } };
  'session.setMode': { params: { sessionId: string; mode: string }; result: { ok: boolean } };
  'session.setFast': { params: { sessionId: string; fast: boolean }; result: { ok: boolean } };
  /** Claude Code ultracode on or off: applied live to a running agent, and at every later start. */
  'session.setUltracode': { params: { sessionId: string; on: boolean }; result: { ok: boolean } };
  'session.rename': { params: { sessionId: string; title: string }; result: { ok: boolean } };
  'session.update': { params: { sessionId: string; patch: Pick<Partial<SessionMeta>, 'pinned' | 'archived' | 'unread'> }; result: { ok: boolean } };
  'session.close': { params: { sessionId: string; remove?: boolean }; result: { ok: boolean } };
  'session.rewind': { params: { sessionId: string; itemId: string; restoreFiles: boolean }; result: { ok: boolean; message?: string } };
  'session.context': { params: { sessionId: string }; result: ContextBreakdown | null };
  'session.mcp': { params: { sessionId: string }; result: McpServerInfo[] };
  /** Switches capabilities; an idle agent process restarts to apply them, a running turn finishes first. */
  'session.setOptions': { params: { sessionId: string; options: SessionOptions }; result: { ok: boolean } };

  /**
   * Replaces a queued message's text, and its attachments when `attachments` is given (an empty
   * array clears them). A message left with no text and no attachments is removed.
   */
  'queue.update': { params: { sessionId: string; id: string; text: string; attachments?: Attachment[] }; result: { ok: boolean } };
  'queue.remove': { params: { sessionId: string; id: string }; result: { ok: boolean } };
  /**
   * Removes a queued message and returns it, atomically (for "edit": put it back in the composer).
   * `message` is absent when it already went out or was removed.
   */
  'queue.take': { params: { sessionId: string; id: string }; result: { message?: QueuedMessage } };
  /** Reorders the queue: `ids` first in that order, any message not named keeps its place after them. */
  'queue.reorder': { params: { sessionId: string; ids: string[] }; result: { ok: boolean } };
  /** Takes a queued message out of the queue and gives it to the agent now (steered into the running turn, if any). */
  'queue.sendNow': { params: { sessionId: string; id: string }; result: { ok: boolean } };

  'permission.respond': { params: { sessionId: string; requestId: string; optionId: string; message?: string }; result: { ok: boolean } };
  'question.respond': {
    params: { sessionId: string; requestId: string; answers: Record<string, string[]> | null };
    result: { ok: boolean };
  };

  'history.list': { params: { provider: ProviderId; cwd?: string; limit?: number; accountId?: string }; result: HistoryEntry[] };

  'fs.list': { params: { path: string }; result: { path: string; parent: string | null; entries: DirEntry[] } };
  'fs.read': { params: { path: string; maxBytes?: number }; result: { path: string; content: string; truncated: boolean; size: number; binary: boolean } };
  'fs.search': { params: { cwd: string; query: string; limit?: number }; result: { path: string; rel: string; dir: boolean }[] };
  'fs.roots': { params: Record<string, never>; result: { roots: DirEntry[]; home: string } };

  'git.status': { params: { cwd: string }; result: GitStatus };
  'git.diff': { params: { cwd: string; path?: string; staged?: boolean }; result: FileDiff[] };
  'git.branches': { params: { cwd: string }; result: { current?: string; branches: string[] } };
  /** Stages everything (`git add -A`) and commits it with `message`. */
  'git.commit': { params: { cwd: string; message: string }; result: GitCommitResult };

  /** The agent's own settings files (permission rules, hooks), read-only and without secrets. */
  'config.read': { params: { provider: ProviderId; cwd?: string }; result: AgentConfigFile[] };

  'term.run': { params: { cwd: string; command: string }; result: { termId: string } };
  'term.kill': { params: { termId: string }; result: { ok: boolean } };

  'memory.list': { params: { cwd: string; provider: ProviderId }; result: MemoryFile[] };
  'memory.write': { params: { path: string; content: string }; result: { ok: boolean } };

  /** Stores an image for the backdrop (base64; PNG, JPEG, WebP or GIF, at most 8 MB). The bridge picks the id. */
  'backdrop.add': { params: { data: string; width: number; height: number }; result: BackdropImage };
  'backdrop.get': { params: { id: string }; result: { id: string; type: string; data: string } };
  /** Deletes the image; a backdrop that showed it moves to another image, or to no image. */
  'backdrop.remove': { params: { id: string }; result: { ok: boolean } };
}

export type RpcName = keyof RpcMethods;

export interface RpcRequest<M extends RpcName = RpcName> {
  id: number;
  method: M;
  params: RpcMethods[M]['params'];
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export type ServerFrame = RpcResponse | { event: BridgeEvent };

export const BRIDGE_PATH = '/__sable';

export const DEFAULT_SETTINGS: AppSettings = {
  accent: 'spectrum',
  ambience: 'full',
  fontScale: 1,
  defaultProvider: 'claude',
  defaultModels: {},
  defaultModes: {},
  defaultEfforts: {},
  notifyOnDone: true,
  sendWithEnter: true,
  showThinking: true,
  backdrop: 'streaks',
  texture: 'dither',
  backdropConfig: DEFAULT_BACKDROP,
  backdropImages: [],
  onboarded: false,
  modelVisibility: {},
  conciseReplies: true,
};

/**
 * Appended to the agent's own system prompt (Claude Code) or developer instructions (Codex)
 * while `AppSettings.conciseReplies` is on. Never replaces what the user configured.
 */
export const CONCISE_REPLIES_PROMPT =
  'When you finish, answer briefly: the outcome in one or two sentences first, then only what the user needs to know or decide next. No long reports and no file-by-file recaps unless asked. If you built or changed something that can be viewed in a browser, start or reuse a local dev server in the background and put its http://localhost URL on its own line.';
