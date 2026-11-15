/**
 * The fictional project every demo scenario works on: `relay-api`, a small Express +
 * TypeScript service with cookie/bearer sessions. Keeping the sources here means reads,
 * grep hits, diffs and test output always agree with each other.
 */

const code = (s: string) => s.replace(/^\n/, '');

export const PACKAGE_JSON = code(`
{
  "name": "relay-api",
  "version": "0.9.2",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "eslint src tests",
    "migrate": "node-pg-migrate up"
  },
  "dependencies": {
    "cookie-parser": "^1.4.7",
    "express": "^4.21.1",
    "pg": "^8.13.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/cookie-parser": "^1.4.7",
    "@types/express": "^5.0.0",
    "@types/supertest": "^6.0.2",
    "node-pg-migrate": "^7.7.1",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
`);

export const CLOCK_TS = code(`
/** Time source, injectable so tests can control expiry without fake timers. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
`);

export const SESSION_TS = code(`
import { randomBytes } from 'node:crypto';

export interface Session {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface SessionStoreOptions {
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class SessionStore {
  private sessions = new Map<string, Session>();
  private ttlMs: number;

  constructor(options: SessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  create(userId: string): Session {
    const now = Date.now();
    const session: Session = {
      id: randomBytes(24).toString('base64url'),
      userId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      revoked: false,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  revoke(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.revoked = true;
  }

  get size(): number {
    return this.sessions.size;
  }
}
`);

export const SESSION_TS_AFTER = code(`
import { randomBytes } from 'node:crypto';
import { systemClock, type Clock } from '../lib/clock';

export interface Session {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

export type SessionFailure = 'missing' | 'expired' | 'revoked';

export type SessionCheck =
  | { ok: true; session: Session }
  | { ok: false; reason: SessionFailure };

export interface SessionStoreOptions {
  ttlMs?: number;
  clock?: Clock;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class SessionStore {
  private sessions = new Map<string, Session>();
  private ttlMs: number;
  private clock: Clock;

  constructor(options: SessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = options.clock ?? systemClock;
  }

  create(userId: string): Session {
    const now = this.clock.now();
    const session: Session = {
      id: randomBytes(24).toString('base64url'),
      userId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      revoked: false,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Single source of truth for whether a session may be used. Expired sessions are
   * evicted; valid ones get a sliding renewal of \`ttlMs\`.
   */
  validate(id: string): SessionCheck {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, reason: 'missing' };
    if (session.revoked) return { ok: false, reason: 'revoked' };

    const now = this.clock.now();
    if (session.expiresAt < now) {
      this.sessions.delete(id);
      return { ok: false, reason: 'expired' };
    }

    session.expiresAt = now + this.ttlMs;
    return { ok: true, session };
  }

  revoke(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.revoked = true;
  }

  get size(): number {
    return this.sessions.size;
  }
}
`);

export const MIDDLEWARE_TS = code(`
import type { NextFunction, Request, Response } from 'express';
import type { SessionStore } from '../server/session';

const SESSION_COOKIE = 'relay_sid';

function readToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies?.[SESSION_COOKIE];
}

function deny(res: Response, error: string) {
  res.status(401).json({ error });
}

export function requireAuth(sessions: SessionStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = readToken(req);
    if (!token) return deny(res, 'missing_token');

    const session = sessions.get(token);
    if (!session) return deny(res, 'invalid_session');
    if (session.revoked) return deny(res, 'session_revoked');
    if (session.expiresAt < Date.now()) {
      return deny(res, 'session_expired');
    }

    // Sliding expiry: every authenticated request buys another 30 minutes.
    session.expiresAt = Date.now() + 30 * 60 * 1000;
    req.session = session;
    next();
  };
}
`);

/** First attempt: derives the wire code from the internal reason (the regression). */
export const MIDDLEWARE_TS_AFTER = code(`
import type { NextFunction, Request, Response } from 'express';
import type { SessionStore } from '../server/session';

const SESSION_COOKIE = 'relay_sid';

function readToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies?.[SESSION_COOKIE];
}

function deny(res: Response, error: string) {
  res.status(401).json({ error });
}

export function requireAuth(sessions: SessionStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = readToken(req);
    if (!token) return deny(res, 'missing_token');

    const check = sessions.validate(token);
    if (!check.ok) return deny(res, \`session_\${check.reason}\`);

    req.session = check.session;
    next();
  };
}
`);

/** Final version: public error codes pinned explicitly. */
export const MIDDLEWARE_TS_FIXED = code(`
import type { NextFunction, Request, Response } from 'express';
import type { SessionFailure, SessionStore } from '../server/session';

const SESSION_COOKIE = 'relay_sid';

/** Public error codes. Clients branch on these, so they must not change. */
const FAILURE_CODES: Record<SessionFailure, string> = {
  missing: 'invalid_session',
  expired: 'session_expired',
  revoked: 'session_revoked',
};

function readToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies?.[SESSION_COOKIE];
}

function deny(res: Response, error: string) {
  res.status(401).json({ error });
}

export function requireAuth(sessions: SessionStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = readToken(req);
    if (!token) return deny(res, 'missing_token');

    const check = sessions.validate(token);
    if (!check.ok) return deny(res, FAILURE_CODES[check.reason]);

    req.session = check.session;
    next();
  };
}
`);

export const ROUTES_TS = code(`
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware';
import { verifyPassword } from '../auth/passwords';
import type { UserRepo } from '../users/repo';
import type { SessionStore } from './session';

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export function createRoutes(sessions: SessionStore, users: UserRepo): Router {
  const router = Router();

  router.post('/auth/login', async (req, res) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body' });

    const user = await users.findByEmail(body.data.email);
    if (!user || !(await verifyPassword(body.data.password, user.passwordHash))) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const session = sessions.create(user.id);
    res.cookie('relay_sid', session.id, { httpOnly: true, sameSite: 'lax', secure: true });
    res.json({ userId: user.id, expiresAt: session.expiresAt });
  });

  router.post('/auth/logout', requireAuth(sessions), (req, res) => {
    sessions.revoke(req.session!.id);
    res.clearCookie('relay_sid');
    res.status(204).end();
  });

  router.get('/me', requireAuth(sessions), async (req, res) => {
    const user = await users.findById(req.session!.userId);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    res.json({ id: user.id, email: user.email, name: user.name });
  });

  return router;
}
`);

export const ROUTES_TS_AFTER = code(`
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware';
import { verifyPassword } from '../auth/passwords';
import { createLoginLimiter } from '../auth/rate-limit';
import type { UserRepo } from '../users/repo';
import type { SessionStore } from './session';

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function createRoutes(sessions: SessionStore, users: UserRepo): Router {
  const router = Router();
  const loginLimiter = createLoginLimiter({ limit: 5, windowMs: LOGIN_WINDOW_MS });
  setInterval(loginLimiter.sweep, LOGIN_WINDOW_MS).unref();

  router.post('/auth/login', loginLimiter.middleware, async (req, res) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body' });

    const user = await users.findByEmail(body.data.email);
    if (!user || !(await verifyPassword(body.data.password, user.passwordHash))) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    loginLimiter.reset(req);
    const session = sessions.create(user.id);
    res.cookie('relay_sid', session.id, { httpOnly: true, sameSite: 'lax', secure: true });
    res.json({ userId: user.id, expiresAt: session.expiresAt });
  });

  router.post('/auth/logout', requireAuth(sessions), (req, res) => {
    sessions.revoke(req.session!.id);
    res.clearCookie('relay_sid');
    res.status(204).end();
  });

  router.get('/me', requireAuth(sessions), async (req, res) => {
    const user = await users.findById(req.session!.userId);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    res.json({ id: user.id, email: user.email, name: user.name });
  });

  return router;
}
`);

export const RATE_LIMIT_TS = code(`
import type { NextFunction, Request, Response } from 'express';
import { systemClock, type Clock } from '../lib/clock';

export interface LoginLimiterOptions {
  /** Attempts allowed per window, per IP + email pair. */
  limit: number;
  windowMs: number;
  clock?: Clock;
}

interface Window {
  count: number;
  resetAt: number;
}

function keyFor(req: Request): string {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return \`\${req.ip}|\${email}\`;
}

/**
 * Fixed-window limiter for the login route. In-memory on purpose: we run a single
 * instance today, and everything goes through this factory so a shared store can be
 * swapped in later without touching the routes.
 */
export function createLoginLimiter({ limit, windowMs, clock = systemClock }: LoginLimiterOptions) {
  const windows = new Map<string, Window>();

  function middleware(req: Request, res: Response, next: NextFunction) {
    const now = clock.now();
    const key = keyFor(req);
    let win = windows.get(key);
    if (!win || win.resetAt <= now) {
      win = { count: 0, resetAt: now + windowMs };
      windows.set(key, win);
    }
    win.count += 1;
    if (win.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((win.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'too_many_attempts' });
    }
    next();
  }

  /** Clears the window after a successful login so earlier typos don't count. */
  function reset(req: Request) {
    windows.delete(keyFor(req));
  }

  /** Drops expired windows so the map cannot grow without bound. */
  function sweep() {
    const now = clock.now();
    for (const [key, win] of windows) {
      if (win.resetAt <= now) windows.delete(key);
    }
  }

  return { middleware, reset, sweep };
}
`);

export const RATE_LIMIT_TEST_TS = code(`
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLoginLimiter } from '../src/auth/rate-limit';

function setup(limit = 3) {
  let now = 0;
  const limiter = createLoginLimiter({ limit, windowMs: 60_000, clock: { now: () => now } });
  const app = express();
  app.use(express.json());
  app.post('/login', limiter.middleware, (req, res) => {
    if (req.body.password === 'right') limiter.reset(req);
    res.status(204).end();
  });
  const attempt = (email: string, password = 'wrong') => request(app).post('/login').send({ email, password });
  return { attempt, advance: (ms: number) => (now += ms) };
}

describe('createLoginLimiter', () => {
  it('blocks attempts over the limit with 429 and Retry-After', async () => {
    const { attempt } = setup();
    for (let i = 0; i < 3; i++) await attempt('ada@relay.dev').expect(204);
    const res = await attempt('ada@relay.dev');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
  });

  it('opens a new window once the old one expires', async () => {
    const { attempt, advance } = setup(1);
    await attempt('ada@relay.dev').expect(204);
    await attempt('ada@relay.dev').expect(429);
    advance(60_000);
    await attempt('ada@relay.dev').expect(204);
  });

  it('treats emails case-insensitively', async () => {
    const { attempt } = setup(1);
    await attempt('Ada@Relay.dev').expect(204);
    await attempt('ada@relay.dev ').expect(429);
  });

  it('clears the window after a successful login', async () => {
    const { attempt } = setup(2);
    await attempt('ada@relay.dev').expect(204);
    await attempt('ada@relay.dev', 'right').expect(204);
    await attempt('ada@relay.dev').expect(204);
    await attempt('ada@relay.dev').expect(204);
  });
});
`);

export const ADMIN_TS = code(`
import { Router } from 'express';
import { requireAuth } from '../auth/middleware';
import type { UserRepo } from '../users/repo';
import type { SessionStore } from './session';

export function createAdminRoutes(sessions: SessionStore, users: UserRepo): Router {
  const router = Router();
  router.use('/admin', requireAuth(sessions));

  router.use('/admin', async (req, res, next) => {
    const user = await users.findById(req.session!.userId);
    if (!user?.roles.includes('admin')) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    next();
  });

  router.get('/admin/sessions', (_req, res) => {
    res.json({ active: sessions.size });
  });

  router.post('/admin/users/:id/disable', async (req, res) => {
    await users.disable(req.params.id);
    res.status(204).end();
  });

  return router;
}
`);

export const ERRORS_TS = code(`
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'invalid_body', issues: err.issues });
  }
  console.error('unhandled error', { path: req.path, err });
  res.status(500).json({ error: 'internal_error' });
}
`);

export const TOKENS_TS = code(`
import { createHmac, timingSafeEqual } from 'node:crypto';

export class TokenError extends Error {}

export function signToken(payload: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return \`\${payload}.\${mac}\`;
}

export function verifyToken(token: string, secret: string): string {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) throw new TokenError('malformed token');
  const payload = token.slice(0, dot);
  const expected = Buffer.from(signToken(payload, secret).slice(dot + 1));
  const actual = Buffer.from(token.slice(dot + 1));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new TokenError('bad signature');
  }
  return payload;
}
`);

export const WEBHOOKS_TS = code(`
import { Router } from 'express';
import { verifyToken } from '../auth/tokens';
import { config } from '../lib/config';

export function createWebhookRoutes(): Router {
  const router = Router();

  router.post('/webhooks/billing', (req, res) => {
    const payload = verifyToken(String(req.headers['x-relay-signature'] ?? ''), config.webhookSecret);
    const event = JSON.parse(payload) as { type: string; customerId: string };
    console.info('billing webhook', { type: event.type, customer: event.customerId });
    res.status(202).end();
  });

  return router;
}
`);

export const APP_TS = code(`
import cookieParser from 'cookie-parser';
import express from 'express';
import { createAdminRoutes } from './server/admin';
import { errorHandler } from './server/errors';
import { createRoutes } from './server/routes';
import { SessionStore } from './server/session';
import { createWebhookRoutes } from './server/webhooks';
import type { UserRepo } from './users/repo';

export function createApp(users: UserRepo) {
  const sessions = new SessionStore();
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use(createRoutes(sessions, users));
  app.use(createAdminRoutes(sessions, users));
  app.use(createWebhookRoutes());

  app.use(errorHandler);
  return app;
}
`);

export const APP_TS_WITH_LOGGING = APP_TS.replace(
  "import { createAdminRoutes } from './server/admin';\n",
  "import { createAdminRoutes } from './server/admin';\nimport { requestLog } from './server/request-log';\n",
).replace('  app.use(cookieParser());\n', '  app.use(cookieParser());\n  app.use(requestLog);\n');

export const MAIN_TS = code(`
import { createApp } from './app';
import { config } from './lib/config';
import { PgUserRepo } from './users/repo';

const users = await PgUserRepo.connect(config.databaseUrl);
const app = createApp(users);

app.listen(config.port, () => {
  console.log(\`relay-api listening on :\${config.port}\`);
});
`);

export const AUTH_TEST_TS = code(`
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { requireAuth } from '../src/auth/middleware';
import { SessionStore } from '../src/server/session';

function makeApp(sessions: SessionStore) {
  const app = express();
  app.get('/me', requireAuth(sessions), (req, res) => {
    res.json({ userId: req.session!.userId });
  });
  return app;
}

describe('requireAuth', () => {
  let sessions: SessionStore;
  let app: express.Express;

  beforeEach(() => {
    sessions = new SessionStore({ ttlMs: 60_000 });
    app = makeApp(sessions);
  });

  it('accepts a valid bearer token', async () => {
    const { id } = sessions.create('u_1');
    const res = await request(app).get('/me').set('Authorization', \`Bearer \${id}\`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'u_1' });
  });

  it('rejects requests without a token', async () => {
    const res = await request(app).get('/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'missing_token' });
  });

  it('rejects unknown session tokens with invalid_session', async () => {
    const res = await request(app).get('/me').set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_session' });
  });

  it('rejects expired sessions', async () => {
    const { id } = sessions.create('u_1');
    sessions.get(id)!.expiresAt = Date.now() - 1;
    const res = await request(app).get('/me').set('Authorization', \`Bearer \${id}\`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'session_expired' });
  });
});
`);

export const ROUTES_TEST_TS = code(`
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/passwords';
import { InMemoryUserRepo } from '../src/users/repo';

const ADA = { email: 'ada@relay.dev', password: 'correct horse' };

describe('routes', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const users = new InMemoryUserRepo();
    await users.insert({ id: 'u_1', email: ADA.email, name: 'Ada', roles: [], passwordHash: await hashPassword(ADA.password) });
    app = createApp(users);
  });

  it('logs in with valid credentials', async () => {
    const res = await request(app).post('/auth/login').send(ADA);
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toMatch(/^relay_sid=/);
  });

  it('rejects a wrong password', async () => {
    const res = await request(app).post('/auth/login').send({ ...ADA, password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
  });

  it('rejects a malformed body', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('returns the current user from /me', async () => {
    const login = await request(app).post('/auth/login').send(ADA);
    const res = await request(app).get('/me').set('Cookie', login.headers['set-cookie']);
    expect(res.body).toEqual({ id: 'u_1', email: ADA.email, name: 'Ada' });
  });

  it('requires auth for /me', async () => {
    const res = await request(app).get('/me');
    expect(res.status).toBe(401);
  });

  it('clears the cookie on logout', async () => {
    const login = await request(app).post('/auth/login').send(ADA);
    const res = await request(app).post('/auth/logout').set('Cookie', login.headers['set-cookie']);
    expect(res.status).toBe(204);
    expect(res.headers['set-cookie']?.[0]).toMatch(/^relay_sid=;/);
  });
});
`);

/** Every file in the repo (what a glob over the project would return). */
export const FILES = [
  'package.json',
  'tsconfig.json',
  'vitest.config.ts',
  'docker-compose.yml',
  'migrations/1731412800000_add-sessions-table.ts',
  'migrations/1731499200000_add-user-roles.ts',
  'src/main.ts',
  'src/app.ts',
  'src/auth/middleware.ts',
  'src/auth/passwords.ts',
  'src/auth/tokens.ts',
  'src/lib/clock.ts',
  'src/lib/config.ts',
  'src/server/admin.ts',
  'src/server/errors.ts',
  'src/server/routes.ts',
  'src/server/session.ts',
  'src/server/webhooks.ts',
  'src/types/express.d.ts',
  'src/users/repo.ts',
  'tests/auth.test.ts',
  'tests/routes.test.ts',
  'tests/session.test.ts',
  'tests/tokens.test.ts',
];

/** Sources available to grep, keyed by repo-relative path. */
export const SOURCES: Record<string, string> = {
  'package.json': PACKAGE_JSON,
  'src/main.ts': MAIN_TS,
  'src/app.ts': APP_TS,
  'src/auth/middleware.ts': MIDDLEWARE_TS,
  'src/auth/tokens.ts': TOKENS_TS,
  'src/lib/clock.ts': CLOCK_TS,
  'src/server/admin.ts': ADMIN_TS,
  'src/server/errors.ts': ERRORS_TS,
  'src/server/routes.ts': ROUTES_TS,
  'src/server/session.ts': SESSION_TS,
  'src/server/webhooks.ts': WEBHOOKS_TS,
  'tests/auth.test.ts': AUTH_TEST_TS,
  'tests/routes.test.ts': ROUTES_TEST_TS,
};

/** `path:line:text` hits for a regex, like `rg -n`. */
export function grep(re: RegExp, prefix = '', sources: Record<string, string> = SOURCES): string[] {
  const out: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    if (!file.startsWith(prefix)) continue;
    text.split('\n').forEach((line, i) => {
      if (re.test(line)) out.push(`${file}:${i + 1}:${line}`);
    });
  }
  return out;
}

/** 1-based line number of the first line containing `needle`. */
export function lineOf(text: string, needle: string): number {
  const i = text.split('\n').findIndex((l) => l.includes(needle));
  return i + 1;
}

export function globFiles(prefix: string, suffix = ''): string[] {
  return FILES.filter((f) => f.startsWith(prefix) && f.endsWith(suffix));
}
