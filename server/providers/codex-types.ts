/**
 * Minimal hand-written subset of the `codex app-server` v2 protocol (codex-cli 0.166.0).
 * Source of truth: `codex app-server generate-ts`. Only what the adapter touches is here;
 * everything is read defensively because the server adds fields freely.
 *
 * Wire envelope: newline-delimited JSON, JSON-RPC 2.0 *without* the "jsonrpc" field.
 *   request      {id, method, params}
 *   response     {id, result} | {id, error: {code, message, data?}}
 *   notification {method, params}
 */

export type RequestId = string | number;

// ── enums ──

/** `on-failure` no longer exists in v2. */
export type AskForApproval = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };
/** Free-form string on the wire; observed: low, medium, high, xhigh, max, ultra (also minimal/none). */
export type ReasoningEffort = string;

// ── initialize ──

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: { experimentalApi: boolean; requestAttestation: boolean; optOutNotificationMethods?: string[] | null } | null;
}
export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

// ── account ──

export type Account =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string; workspaceName: string | null }
  | { type: 'amazonBedrock' }
  | { type: 'gcp' };
export interface GetAccountResponse {
  account: Account | null;
  requiresOpenaiAuth: boolean;
}
export type LoginAccountResponse =
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | { type: 'chatgptDeviceCode'; loginId: string; verificationUrl: string; userCode: string }
  | { type: 'apiKey' | 'chatgptAuthTokens' | 'amazonBedrock' };
export interface AccountLoginCompletedNotification {
  loginId: string | null;
  success: boolean;
  error: string | null;
}
export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  /** Unix seconds. */
  resetsAt: number | null;
}
export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}
export interface GetAccountRateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null;
}

// ── models / skills / mcp ──

export interface Model {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: { reasoningEffort: ReasoningEffort; description: string }[];
  defaultReasoningEffort: ReasoningEffort;
  inputModalities?: string[];
  isDefault: boolean;
}
export interface ModelListResponse {
  data: Model[];
  nextCursor: string | null;
}
export interface SkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  scope: 'user' | 'repo' | 'system' | 'admin';
  enabled: boolean;
}
export interface SkillsListResponse {
  data: { cwd: string; skills: SkillMetadata[]; errors: unknown[] }[];
}
export type McpServerConnectionStatus =
  | 'notStarted'
  | 'starting'
  | 'connected'
  | 'authenticationRequired'
  | 'failed'
  | 'cancelled'
  | 'disabled';
export interface McpServerStatus {
  name: string;
  runtimeStatus: McpServerConnectionStatus | null;
  serverInfo: { name: string; version: string } | null;
  tools: Record<string, { name: string; description?: string } | undefined>;
  toolsError: string | null;
  authStatus: 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth';
}
export interface ListMcpServerStatusResponse {
  data: McpServerStatus[];
  nextCursor: string | null;
}

// ── threads & turns ──

export interface Thread {
  id: string;
  preview: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  /** Unix seconds. */
  createdAt: number;
  updatedAt: number;
  status: { type: 'notLoaded' | 'idle' | 'systemError' | 'active' };
  cwd: string;
  gitInfo: { sha: string | null; branch: string | null; originUrl: string | null } | null;
  name: string | null;
  parentThreadId: string | null;
  turns: Turn[];
}
export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
}
export interface ThreadResumeParams extends ThreadStartParams {
  threadId: string;
  excludeTurns?: boolean;
}
export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  cwd: string;
  approvalPolicy: unknown;
  reasoningEffort: ReasoningEffort | null;
}
export interface ThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: 'created_at' | 'updated_at' | 'recency_at' | null;
  cwd?: string | string[] | null;
  archived?: boolean | null;
}
export interface ThreadListResponse {
  data: Thread[];
  nextCursor: string | null;
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export interface TurnError {
  message: string;
  additionalDetails: string | null;
}
export interface Turn {
  id: string;
  items: ThreadItem[];
  status: TurnStatus;
  error: TurnError | null;
  /** Unix seconds. */
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface TextElement {
  byteRange: { start: number; end: number };
  placeholder: string | null;
}
export type UserInput =
  | { type: 'text'; text: string; text_elements: TextElement[] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string };

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandboxPolicy?: SandboxPolicy | null;
  model?: string | null;
  effort?: ReasoningEffort | null;
}
export interface TurnSteerParams {
  threadId: string;
  input: UserInput[];
  expectedTurnId: string;
}
export type ReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title: string | null }
  | { type: 'custom'; instructions: string };

// ── items ──

export type CommandAction =
  | { type: 'read'; command: string; name: string; path: string }
  | { type: 'listFiles'; command: string; path: string | null }
  | { type: 'search'; command: string; query: string | null; path: string | null }
  | { type: 'unknown'; command: string };
export type PatchChangeKind = { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null };
export interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind;
  diff: string;
}
export type WebSearchAction =
  | { type: 'search'; query: string | null; queries: string[] | null }
  | { type: 'openPage'; url: string | null }
  | { type: 'findInPage'; url: string | null; pattern: string | null }
  | { type: 'other' };

interface ItemTimes {
  startedAtMs?: number | null;
  completedAtMs?: number | null;
}
export type ThreadItem = ItemTimes &
  (
    | { type: 'userMessage'; id: string; content: (UserInput | { type: string; [k: string]: unknown })[] }
    | { type: 'agentMessage'; id: string; text: string }
    | { type: 'plan'; id: string; text: string }
    | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
    | {
        type: 'commandExecution';
        id: string;
        command: string;
        cwd: string;
        source?: string;
        status: 'inProgress' | 'completed' | 'failed' | 'declined';
        commandActions: CommandAction[];
        aggregatedOutput: string | null;
        exitCode: number | null;
        durationMs: number | null;
      }
    | { type: 'fileChange'; id: string; changes: FileUpdateChange[]; status: 'inProgress' | 'completed' | 'failed' | 'declined' }
    | {
        type: 'mcpToolCall';
        id: string;
        server: string;
        tool: string;
        status: 'inProgress' | 'completed' | 'failed';
        arguments: unknown;
        result: { content: unknown[]; structuredContent: unknown } | null;
        error: { message: string } | null;
      }
    | {
        type: 'dynamicToolCall';
        id: string;
        namespace: string | null;
        tool: string;
        arguments: unknown;
        status: 'inProgress' | 'completed' | 'failed';
        contentItems: { type: string; text?: string }[] | null;
        success: boolean | null;
      }
    | {
        type: 'collabAgentToolCall';
        id: string;
        tool: string;
        status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
        receiverThreadIds: string[];
        prompt: string | null;
        model: string | null;
        agentsStates: Record<string, { status: string; message: string | null } | undefined>;
      }
    | { type: 'subAgentActivity'; id: string; kind: string; agentThreadId: string; agentPath: string; model: string | null }
    | { type: 'webSearch'; id: string; query: string; action: WebSearchAction | null }
    | { type: 'imageView'; id: string; path: string }
    | { type: 'sleep'; id: string; durationMs: number }
    | { type: 'imageGeneration'; id: string; status: string; revisedPrompt: string | null; savedPath?: string }
    | { type: 'enteredReviewMode'; id: string; review: string }
    | { type: 'exitedReviewMode'; id: string; review: string }
    | { type: 'contextCompaction'; id: string }
    | { type: 'hookPrompt'; id: string }
    | { type: 'functionCallOutput'; id: string }
  );

// ── notifications ──

export interface ItemNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}
export interface ItemDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}
export interface FileChangePatchUpdatedNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  changes: FileUpdateChange[];
}
export interface TurnNotification {
  threadId: string;
  turn: Turn;
}
export interface TurnPlanUpdatedNotification {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: { step: string; status: 'pending' | 'inProgress' | 'completed' }[];
}
export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}
export interface ThreadTokenUsageUpdatedNotification {
  threadId: string;
  turnId: string;
  tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow: number | null };
}
export interface ErrorNotification {
  error: TurnError;
  willRetry: boolean;
  threadId: string;
  turnId: string;
}
export interface WarningNotification {
  threadId: string | null;
  message: string;
}

// ── server → client requests ──

export interface CommandExecutionRequestApprovalParams {
  kind?: 'command' | 'writeStdin';
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  networkApprovalContext?: { host: string; protocol: string } | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: CommandAction[] | null;
  /** Command-prefix tokens that would be allow-listed. */
  proposedExecpolicyAmendment?: string[] | null;
}
export type CommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | 'decline'
  | 'cancel';
export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}
export type FileChangeApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export interface PermissionProfile {
  network?: { enabled: boolean | null } | null;
  fileSystem?: { read: string[] | null; write: string[] | null; [k: string]: unknown } | null;
}
export interface PermissionsRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason: string | null;
  permissions: PermissionProfile;
}
export interface PermissionsRequestApprovalResponse {
  permissions: PermissionProfile;
  scope: 'turn' | 'session';
}
export interface ToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: { id: string; header: string; question: string; isOther: boolean; isSecret: boolean; options: { label: string; description: string }[] | null }[];
}
export interface ToolRequestUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}
/** Legacy (v1) approvals. */
export interface ExecCommandApprovalParams {
  conversationId: string;
  callId: string;
  command: string[];
  cwd: string;
  reason: string | null;
}
export interface ApplyPatchApprovalParams {
  conversationId: string;
  callId: string;
  fileChanges: Record<string, unknown>;
  reason: string | null;
  grantRoot: string | null;
}
export type ReviewDecision = 'approved' | 'approved_for_session' | { denied: { rejection: string } } | 'abort';
