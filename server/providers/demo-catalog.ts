/** Static catalog for the demo provider: capabilities, limits, history, context. */
import path from 'node:path';
import type {
  Capabilities,
  CommandInfo,
  ContextBreakdown,
  HistoryEntry,
  McpServerInfo,
  ModelInfo,
  RateLimit,
  SkillInfo,
} from '../../shared/protocol';
import { BASE_CONTEXT, CONTEXT_WINDOW, type Pricing } from './demo-script';

export const MODELS: ModelInfo[] = [
  {
    id: 'demo-large',
    name: 'Demo Large',
    description: 'Most capable. Best for multi-file refactors and tricky debugging',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    isDefault: true,
  },
  {
    // A model whose top level is Ultra (as Codex's are), so the composer's Ultra stop can be built against the demo.
    id: 'demo-deep',
    name: 'Demo Deep',
    description: 'Longest reasoning, may split work across sub-agents',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'medium',
  },
  {
    id: 'demo-fast',
    name: 'Demo Fast',
    description: 'Balanced speed and quality for everyday coding',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'demo-mini',
    name: 'Demo Mini',
    description: 'Quick answers and small, well-scoped edits',
    efforts: ['minimal', 'low', 'medium'],
    defaultEffort: 'low',
  },
];

export const DEFAULT_MODEL = 'demo-large';

export const PRICING: Record<string, Pricing> = {
  'demo-large': { input: 3, output: 15, cacheRead: 0.3, pace: 1 },
  'demo-deep': { input: 5, output: 25, cacheRead: 0.5, pace: 1.2 },
  'demo-fast': { input: 1, output: 5, cacheRead: 0.1, pace: 0.75 },
  'demo-mini': { input: 0.25, output: 1.25, cacheRead: 0.03, pace: 0.55 },
};

export const COMMANDS: CommandInfo[] = [
  { name: 'compact', description: 'Summarize the conversation to free up context', argumentHint: '[focus instructions]', kind: 'builtin' },
  { name: 'context', description: 'Show how the context window is being used', kind: 'builtin' },
  { name: 'cost', description: 'Show token usage and cost for this session', kind: 'builtin' },
  { name: 'review', description: 'Review the uncommitted changes in this repository', kind: 'builtin' },
  { name: 'init', description: 'Create a CLAUDE.md with notes about this codebase', kind: 'builtin' },
  { name: 'help', description: 'List the available commands', kind: 'builtin' },
  { name: 'pr-comments', description: 'Fetch and summarize review comments on the current pull request', argumentHint: '[pr number]', kind: 'command', source: 'user' },
  { name: 'deploy-check', description: 'Run the pre-deploy checklist: typecheck, tests, migrations, env vars', kind: 'command', source: 'project' },
];

export const SKILLS: (SkillInfo & { followup: string })[] = [
  {
    name: 'changelog',
    description: 'Draft Keep a Changelog entries from recent commits and closed issues',
    source: 'project',
    path: '.claude/skills/changelog/SKILL.md',
    enabled: true,
    followup:
      'I’ll collect the commits since the last tag, group them into **Added / Changed / Fixed**, and link each entry to its issue. Which release should the entry be for, or should I put it under **Unreleased**?',
  },
  {
    name: 'write-tests',
    description: 'Write focused vitest tests for a module, following the repo’s supertest patterns',
    source: 'project',
    path: '.claude/skills/write-tests/SKILL.md',
    enabled: true,
    followup:
      'The skill wants one behaviour per test and real Express apps via `supertest`, like `tests/auth.test.ts`. Which module should I cover first? `SessionStore.validate()` has no direct tests yet.',
  },
  {
    name: 'security-audit',
    description: 'Review auth, session and input-validation code for common vulnerabilities',
    source: 'user',
    enabled: true,
    followup:
      'I’ll go through `src/auth/` and `src/server/` against the checklist: token handling, cookie flags, timing-safe comparisons, rate limiting and error leakage. Should I include the webhook signature path as well?',
  },
  {
    name: 'db-migration',
    description: 'Create a reversible node-pg-migrate migration with up and down steps',
    source: 'project',
    path: '.claude/skills/db-migration/SKILL.md',
    enabled: true,
    followup:
      'Migrations in this repo live in `migrations/` and are timestamped. What schema change do you need? I’ll write both `up` and `down` and run it against the local Postgres.',
  },
  {
    name: 'openapi',
    description: 'Generate or update the OpenAPI 3.1 spec from the Express routes and zod schemas',
    source: 'user',
    enabled: true,
    followup:
      'I’ll derive request bodies from the zod schemas (`LoginBody` and friends) and response shapes from the handlers. Do you want the spec at `docs/openapi.yaml` or served from `/openapi.json`?',
  },
  {
    name: 'perf-profile',
    description: 'Profile a Node endpoint with autocannon and --cpu-prof, then summarize hotspots',
    source: 'user',
    enabled: false,
    followup:
      'I’ll start the server with `--cpu-prof`, drive the endpoint with `autocannon`, and read the profile. Which route should I profile? `/me` touches both the session store and Postgres.',
  },
];

export const MCP_SERVERS: McpServerInfo[] = [
  {
    name: 'github',
    status: 'connected',
    scope: 'user',
    version: '0.6.2',
    tools: [
      { name: 'search_issues', description: 'Search issues and pull requests' },
      { name: 'get_issue', description: 'Get an issue with its comments' },
      { name: 'create_pull_request', description: 'Open a pull request' },
      { name: 'list_pull_request_comments', description: 'List review comments on a pull request' },
    ],
  },
  {
    name: 'linear',
    status: 'connected',
    scope: 'project',
    version: '1.3.0',
    tools: [
      { name: 'list_issues', description: 'List issues in a team or project' },
      { name: 'create_issue', description: 'Create an issue' },
      { name: 'update_issue', description: 'Update status, assignee or labels' },
    ],
  },
  {
    name: 'postgres',
    status: 'failed',
    scope: 'project',
    error: 'connect ECONNREFUSED 127.0.0.1:5432',
    tools: [
      { name: 'query', description: 'Run a read-only SQL query' },
      { name: 'describe_table', description: 'Show columns and indexes for a table' },
    ],
  },
  {
    name: 'sentry',
    status: 'needs-auth',
    scope: 'user',
    tools: [
      { name: 'search_issues', description: 'Search Sentry issues' },
      { name: 'get_event', description: 'Get a single event with its stack trace' },
    ],
  },
];

export function capabilities(): Capabilities {
  const mcpTools = MCP_SERVERS.flatMap((s) => (s.status === 'connected' ? (s.tools ?? []).map((t) => `mcp__${s.name}__${t.name}`) : []));
  return {
    models: MODELS.map((m) => ({ ...m })),
    modes: [
      { id: 'default', name: 'Ask first', description: 'Asks before editing files or running commands', tone: 'ask' },
      { id: 'acceptEdits', name: 'Accept edits', description: 'Edits files freely, still asks before commands', tone: 'edit' },
      { id: 'plan', name: 'Plan', description: 'Explores and proposes a plan without changing anything', tone: 'plan' },
      { id: 'bypassPermissions', name: 'Bypass', description: 'Runs everything without asking. Use in sandboxes only', tone: 'danger' },
    ],
    commands: COMMANDS.map((c) => ({ ...c })),
    skills: SKILLS.map(({ followup: _f, ...s }) => ({ ...s })),
    agents: [
      { name: 'general-purpose', description: 'Multi-step research and implementation tasks', source: 'builtin' },
      { name: 'Explore', description: 'Fast read-only codebase exploration: finds files, traces call paths, answers “where is…”', model: 'demo-fast', source: 'builtin' },
      { name: 'code-reviewer', description: 'Reviews a diff for correctness, security and test coverage', model: 'demo-large', source: 'project' },
    ],
    mcpServers: MCP_SERVERS.map((s) => ({ ...s, tools: s.tools?.map((t) => ({ ...t })) })),
    tools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'Skill', ...mcpTools],
    skillTrigger: '/',
    features: { images: true, thinking: true, rewind: true, steer: true, compact: true, fast: false, browser: true, computerUse: true, remoteControl: true, ultracode: true },
  };
}

export function rateLimits(now = Date.now()): RateLimit[] {
  const nextMonday = new Date(now);
  nextMonday.setHours(9, 0, 0, 0);
  nextMonday.setDate(nextMonday.getDate() + (((8 - nextMonday.getDay()) % 7) || 7));
  return [
    { id: 'session', label: '5-hour session', percent: 34, resetsAt: now + (2 * 60 + 13) * 60_000 },
    { id: 'weekly', label: 'Weekly · all models', percent: 61, resetsAt: nextMonday.getTime() },
  ];
}

export interface PastSession extends HistoryEntry {
  prompt: string;
  reply: string;
  readPath: string;
}

const HOUR = 3_600_000;

export function pastSessions(cwd: string | undefined, now = Date.now()): PastSession[] {
  const dir = cwd ?? path.join(process.cwd(), 'relay-api');
  const rows: Omit<PastSession, 'provider' | 'cwd'>[] = [
    {
      providerSessionId: 'demo-4c1e9a7b-2f60-4d1a-9b8e-61f0c2d5a913',
      title: 'Why does /admin/sessions over-count?',
      branch: 'main',
      updatedAt: now - 3 * HOUR,
      preview: 'Expired sessions are never evicted, so `size` counts them too.',
      prompt: 'Why does /admin/sessions report more active sessions than we have users online?',
      reply:
        '`/admin/sessions` returns `sessions.size`, and `SessionStore` never evicts anything: expired sessions stay in the map until the process restarts. `requireAuth` rejects them, but nothing removes them. Evicting on lookup, or sweeping on an interval, would make the count accurate.',
      readPath: 'src/server/session.ts',
    },
    {
      providerSessionId: 'demo-8d2b07f4-91c3-4e0b-a5d2-3e7c9b1f0a68',
      title: 'Fix flaky timeout in routes.test.ts',
      branch: 'fix/flaky-routes-test',
      updatedAt: now - 26 * HOUR,
      preview: 'bcrypt cost factor in tests was 12; dropped to 4 via env.',
      prompt: 'routes.test.ts times out on CI about once a day. Can you find out why?',
      reply:
        'The slow part is `hashPassword()`: it uses bcrypt cost 12 in every `beforeEach`, about 250 ms per hash on the CI runners, so the suite sits right at the 5 s timeout. I made the cost configurable through `BCRYPT_COST` and set it to 4 in `vitest.config.ts`. Locally the suite went from 3.9 s to 0.6 s.',
      readPath: 'src/auth/passwords.ts',
    },
    {
      providerSessionId: 'demo-1a9f3c52-7e84-4b6d-8c0f-d24b5e7a3c19',
      title: 'Webhook signature errors return 500',
      branch: 'main',
      updatedAt: now - 2 * 24 * HOUR,
      preview: 'TokenError falls through errorHandler to internal_error.',
      prompt: 'Billing says our webhook endpoint returns 500 when they rotate secrets. Why?',
      reply:
        '`verifyToken()` throws `TokenError` when the signature does not match, and `/webhooks/billing` does not catch it. `errorHandler` only knows `HttpError` and `ZodError`, so the request ends as a 500 `internal_error`. Mapping `TokenError` to a 401 fixes the status code and keeps their retry logic from hammering us.',
      readPath: 'src/server/webhooks.ts',
    },
    {
      providerSessionId: 'demo-6e0c8b1d-3a27-4f95-b7e4-0c9d2a6f5b81',
      title: 'Set up structured logging with pino',
      branch: 'feat/logging',
      updatedAt: now - 4 * 24 * HOUR,
      preview: 'Added src/lib/logger.ts and a request-log middleware.',
      prompt: 'Set up structured JSON logging for requests.',
      reply:
        'Added `src/lib/logger.ts` (pino, ISO timestamps, `authorization` and `cookie` headers redacted) and `src/server/request-log.ts`, which logs method, route template, status, latency and request ID once the response finishes. It is mounted right after `cookieParser()` in `src/app.ts`.',
      readPath: 'src/app.ts',
    },
    {
      providerSessionId: 'demo-b37d5e90-c18a-4a2f-9e61-7f4b0d8c2e35',
      title: 'Upgrade vitest to v2',
      branch: 'chore/vitest-2',
      updatedAt: now - 7 * 24 * HOUR,
      preview: 'Renamed deprecated config keys; all 25 tests pass.',
      prompt: 'Upgrade vitest to v2 and fix whatever breaks.',
      reply:
        'Bumped `vitest` to `^2.1.4`. The only breaking change that affected us was `poolOptions.threads.singleThread`, which is now `poolOptions.threads.singleFork` in `vitest.config.ts`. All 25 tests pass and the run is about 15% faster.',
      readPath: 'vitest.config.ts',
    },
    {
      providerSessionId: 'demo-29f6a1c8-5d03-4e7b-8a4c-e1b7d3f9068a',
      title: 'Add user roles migration',
      branch: 'feat/admin-roles',
      updatedAt: now - 11 * 24 * HOUR,
      preview: 'Migration adds users.roles text[] with a GIN index.',
      prompt: 'We need an admin role. Add whatever the database needs.',
      reply:
        'Created `migrations/1731499200000_add-user-roles.ts`, which adds `users.roles text[] not null default \'{}\'` plus a GIN index for `roles @> \'{admin}\'` lookups, with a matching `down`. I ran it against the local database and updated `UserRepo` to read the column.',
      readPath: 'migrations/1731499200000_add-user-roles.ts',
    },
  ];
  return rows.map((r) => ({ ...r, provider: 'demo' as const, cwd: dir }));
}

const FIXED = [
  { name: 'System prompt', tokens: 2_900 },
  { name: 'System tools', tokens: 11_700 },
  { name: 'MCP tools', tokens: 4_200 },
  { name: 'Memory files', tokens: 1_200 },
];

export function contextBreakdown(contextTokens: number | undefined, turns: number, model: string): ContextBreakdown {
  const max = CONTEXT_WINDOW;
  const buffer = 40_000;
  const fixed = FIXED.reduce((n, c) => n + c.tokens, 0);
  const messages = Math.max((contextTokens ?? BASE_CONTEXT) - BASE_CONTEXT, turns * 2_400);
  const used = fixed + messages;
  const free = Math.max(0, max - used - buffer);
  return {
    totalTokens: used,
    maxTokens: max,
    percent: Math.round((used / max) * 100),
    model,
    categories: [
      ...FIXED.map((c) => ({ ...c, kind: 'used' as const })),
      { name: 'Messages', tokens: messages, kind: 'used' },
      { name: 'Free space', tokens: free, kind: 'free' },
      { name: 'Autocompact buffer', tokens: buffer, kind: 'buffer' },
    ],
  };
}
