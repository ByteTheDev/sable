<!--
  Long-form assistant text for the demo provider. Sections start with a marker line
  of the form "@@ name" and run until the next marker. {{placeholders}} are filled at
  runtime. Everything here is written against the fictional relay-api project in
  demo-codebase.ts.
-->

@@ flagship-summary
Expiry now lives in `SessionStore.validate()`, and `requireAuth` only maps its result to a response. All 25 tests pass.

One behaviour change: expired sessions are evicted on lookup, so the count on `/admin/sessions` will drop.

@@ flagship-summary-careful
Done as planned: `requireAuth` delegates to `sessions.validate()` and clients see the same error codes. All 25 tests pass on the first run.

`SessionStore.get()` still bypasses expiry. Only a test uses it now, so it could become test-only.

@@ plan-flagship
## Plan: move session expiry into `SessionStore`

Right now `requireAuth` decides expiry itself (`session.expiresAt < Date.now()`) and extends sessions by a hard-coded 30 minutes. `SessionStore` owns `ttlMs` but never enforces it.

### Changes
1. **`src/server/session.ts`**
   - Add `validate(id): SessionCheck`, a discriminated union of `{ ok: true, session }` and `{ ok: false, reason: 'missing' | 'expired' | 'revoked' }`.
   - Evict expired sessions on lookup and apply sliding renewal from the store's `ttlMs`.
   - Accept an optional `clock` (the existing `Clock` in `src/lib/clock.ts`) so tests can control time.
2. **`src/auth/middleware.ts`**
   - Replace the inline checks and the renewal with a single `sessions.validate(token)` call.
   - Keep the public error codes (`invalid_session`, `session_expired`, `session_revoked`) exactly as they are.
3. **Verify** with `npm test`. No test changes should be needed.

### Risks
- Expired sessions get deleted on read, so `/admin/sessions` will report a lower `active` count. The old number was inflated.
- `get()` stays public for now. Only the tests still call it.

@@ plan-ratelimit
## Plan: rate-limit `POST /auth/login`

**Goal:** slow down credential stuffing against the login route without adding a dependency or touching other routes.

### Approach
1. **New `src/auth/rate-limit.ts`**: a fixed-window limiter keyed by client IP plus normalized email.
   - `createLoginLimiter({ limit, windowMs, clock })` returns `middleware`, `reset` and `sweep`.
   - Over the limit it responds **429** `{ error: 'too_many_attempts' }` with a `Retry-After` header.
   - Uses the existing `Clock` from `src/lib/clock.ts`, so tests don't need fake timers.
2. **Wire it into `src/server/routes.ts`** for `POST /auth/login` only, at 5 attempts per 15 minutes.
3. **Reset on success.** A successful login clears the window, so a user who mistyped twice isn't penalized later.
4. **Bound memory** by calling `sweep` on an `unref()`'d interval so expired windows are dropped.
5. **Tests** in `tests/rate-limit.test.ts`: the limit and `Retry-After`, window rollover, case-insensitive emails, reset on success.

### Files
| File | Change |
|---|---|
| `src/auth/rate-limit.ts` | new |
| `src/server/routes.ts` | apply limiter to login, reset on success |
| `tests/rate-limit.test.ts` | new |

### Out of scope
- **Shared state across instances.** We run a single instance today. Everything goes through `createLoginLimiter`, so a Redis-backed store can be added later without touching the routes.
- **Account lockout.** Lockout lets an attacker lock other people out, so the limiter only adds friction.

@@ ratelimit-summary
`POST /auth/login` now allows 5 attempts per 15 minutes per IP and email, then answers 429 with `Retry-After`. All 29 tests pass.

Before deploying behind a load balancer, set `app.set('trust proxy', 1)`, or every user shares one window.

@@ agents-report-a
Auth failures become HTTP responses in four places:

- `src/auth/middleware.ts:{{mwLine}}`: `deny()` sends **401** `{ error }` for `missing_token`, `invalid_session`, `session_revoked` and `session_expired`.
- `src/server/routes.ts:{{routesLine}}`: login sends **401** `{ error: 'invalid_credentials' }`.
- `src/server/admin.ts:{{adminLine}}`: non-admins get **403** `{ message: 'Forbidden' }`. This is the only auth response that uses `message` instead of `error`.
- `src/server/webhooks.ts:{{webhookLine}}`: `verifyToken()` throws `TokenError` on a bad signature and nothing catches it. `errorHandler` (`src/server/errors.ts`) only knows `HttpError` and `ZodError`, so the request falls through to **500** `internal_error`.

Inconsistencies: the shape of the admin 403 body, and webhook signature failures surfacing as 500s.

@@ agents-report-b
Auth-failure coverage is thin outside `requireAuth`:

- `tests/auth.test.ts` asserts `missing_token`, `invalid_session` and `session_expired` (all 401) plus the happy path.
- Nothing exercises `session_revoked`, even though logout depends on `revoke()`.
- `tests/routes.test.ts` covers login failure (401 `invalid_credentials`) and an unauthenticated `/me`. Its logout test checks that the cookie is cleared, but never checks that the old session is rejected afterwards.
- No test hits the admin 403 or the webhook signature path.

@@ agents-synthesis
Auth failures are mostly consistent. `requireAuth` and login both return **401** with an `{ error }` code. The two investigations did turn up two real bugs and some coverage gaps.

### Findings

| # | Where | Issue | Severity |
|---|---|---|---|
| 1 | `src/server/webhooks.ts:{{webhookLine}}` | A bad signature throws `TokenError`, which `errorHandler` doesn't recognize, so callers get **500** `internal_error` instead of 401 | High |
| 2 | `src/server/admin.ts:{{adminLine}}` | The 403 body is `{ message: 'Forbidden' }`. Every other auth response uses `{ error: <code> }` | Medium |
| 3 | `tests/` | No test for `session_revoked`, the admin 403 or the webhook signature path | Medium |
| 4 | `tests/routes.test.ts` | The logout test checks the cookie but never that the session was actually revoked | Low |

### Suggested fixes
1. Map `TokenError` in `errorHandler` (`src/server/errors.ts`):
   ```ts
   if (err instanceof TokenError) {
     return res.status(401).json({ error: 'invalid_signature' });
   }
   ```
2. Change the admin guard to `res.status(403).json({ error: 'forbidden' })`. Check the admin dashboard first, since it may read `message`.
3. Add tests for the three uncovered paths, and extend the logout test to call `/me` with the old cookie and expect `session_revoked`.

Fixes 1 and 3 are safe to make now. Fix 2 is a small API change.

@@ search-websummary
Top results: the Node.js `http` docs for `server.close()`, `server.closeIdleConnections()` and `server.closeAllConnections()`; the Express guide "Health Checks and Graceful Shutdown"; the Node.js process signal events docs; the `@godaddy/terminus` library README; and a Kubernetes doc on pod termination (SIGTERM, then a grace period, then SIGKILL).

@@ search-fetch-node
Summary of the relevant `http.Server` methods:

- `server.close([callback])`: stops accepting new connections. Since v19.0.0 it also closes idle keep-alive connections. The callback runs once all remaining connections have ended.
- `server.closeIdleConnections()` (v18.2.0+): closes connections that are not currently handling a request.
- `server.closeAllConnections()` (v18.2.0+): closes every connection, including ones with requests in flight. Meant as a last resort after a timeout.
- `server.keepAliveTimeout` (default 5000 ms) and `server.headersTimeout` control how long idle sockets linger.

@@ search-fetch-express
The Express guide says to stop accepting traffic on SIGTERM, let in-flight requests finish, close resources such as database pools, and exit. It suggests failing the readiness check during shutdown so load balancers stop routing new requests, and points to libraries such as `@godaddy/terminus` that wrap this pattern.

@@ search-answer
Node 22 already does most of the work. The shutdown handler only needs to sequence the steps and put a deadline on them.

**What the docs say**
- [`server.close()`](https://nodejs.org/api/http.html#serverclosecallback) stops accepting connections, and since Node 19 it also drops idle keep-alive sockets. Before v19 you had to call `closeIdleConnections()` yourself.
- [`server.closeAllConnections()`](https://nodejs.org/api/http.html#servercloseallconnections) is the forced fallback for requests that don't finish in time.
- The [Express shutdown guide](https://expressjs.com/en/advanced/healthcheck-graceful-shutdown.html) recommends handling `SIGTERM`, draining, then closing pools. [`terminus`](https://github.com/godaddy/terminus) wraps this, but it's about 20 lines without a dependency.
- Kubernetes sends `SIGTERM` and then waits `terminationGracePeriodSeconds` (30 s by default) before `SIGKILL`, so the deadline has to be shorter than that. See [pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination).

**Applied to `src/main.ts`**, which currently calls `app.listen()` and never closes anything:

```ts
const server = app.listen(config.port, () => {
  console.log(`relay-api listening on :${config.port}`);
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, draining`);

  const force = setTimeout(() => server.closeAllConnections(), 20_000).unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(force);

  await users.close(); // release the pg pool last
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

Two details matter:
1. **Close the pg pool last.** In-flight requests may still be querying `users`.
2. **Keep the deadline under the platform's grace period.** 20 s leaves headroom inside Kubernetes' default 30 s.

If you also add a readiness endpoint, make it return 503 once `shuttingDown` is true so the load balancer stops sending traffic before the sockets close.

@@ markdown-showcase
# How authentication works in relay-api

relay-api uses **opaque server-side sessions**. A session ID is a random token that means nothing on its own, so *revocation is instant* and nothing sensitive ever reaches the client. This page covers the moving parts, the request flow and the trade-offs behind them.

## Components

- **`SessionStore`** (`src/server/session.ts`)
  - Holds sessions in a `Map`, keyed by a 192-bit random ID
  - Owns the TTL (30 minutes by default) and sliding renewal
  - `validate(id)` is the only place that decides whether a session is usable
- **`requireAuth`** (`src/auth/middleware.ts`)
  - Reads the token from `Authorization: Bearer …` or the `relay_sid` cookie
  - Maps validation failures to stable public error codes
- **Login and logout routes** (`src/server/routes.ts`)
  1. `POST /auth/login` checks the password with `verifyPassword()` and creates a session
  2. `POST /auth/logout` revokes the session and clears the cookie
     - Revocation is immediate, because every request goes back to the store

## Request flow

> Every authenticated request costs exactly one `Map` lookup. There is no signature verification and no database round-trip, and that is why sessions beat JWTs for this service.

1. The client sends the cookie or bearer token.
2. `requireAuth` calls `sessions.validate(token)`.
3. On success the session is renewed and attached to `req.session`. On failure the client gets a `401`.

## Error codes

| Code | Status | Meaning | Client should |
|---|:---:|---|---|
| `missing_token` | 401 | No cookie or bearer header | Redirect to login |
| `invalid_session` | 401 | Unknown token | Redirect to login |
| `session_expired` | 401 | TTL elapsed with no activity | Re-authenticate, keep the draft |
| `session_revoked` | 401 | Logged out elsewhere | Redirect to login |
| `too_many_attempts` | 429 | Login rate limit hit | Wait for `Retry-After` |

## Code

The heart of validation:

```ts
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
```

Trying it from a shell:

```bash
# log in and keep the cookie
curl -si -c jar.txt -H 'content-type: application/json' \
  -d '{"email":"ada@relay.dev","password":"correct horse"}' \
  http://localhost:3000/auth/login

# use it
curl -s -b jar.txt http://localhost:3000/me | jq
```

A successful login response:

```json
{
  "userId": "u_1",
  "expiresAt": 1763215384000
}
```

The change that centralized expiry, in short:

```diff
-    const session = sessions.get(token);
-    if (!session) return deny(res, 'invalid_session');
-    if (session.revoked) return deny(res, 'session_revoked');
-    if (session.expiresAt < Date.now()) {
-      return deny(res, 'session_expired');
-    }
+    const check = sessions.validate(token);
+    if (!check.ok) return deny(res, FAILURE_CODES[check.reason]);
```

A [Locust](https://locust.io/) script for load-testing the auth path:

```python
from locust import HttpUser, between, task


class AuthenticatedUser(HttpUser):
    wait_time = between(0.5, 2)

    def on_start(self):
        self.client.post("/auth/login", json={
            "email": "ada@relay.dev",
            "password": "correct horse",
        })

    @task(10)
    def me(self):
        self.client.get("/me")

    @task(1)
    def logout_and_back(self):
        self.client.post("/auth/logout")
        self.on_start()
```

---

### Trade-offs

- ***Memory-bound:*** sessions live in process memory, so a restart logs everyone out and you can't run more than one instance. A Redis-backed store would fix both. See the [Express session store list](https://expressjs.com/en/resources/middleware/session.html#compatible-session-stores).
- **Cookie flags:** `httpOnly`, `secure` and `sameSite=lax` are set on login. ~~`sameSite=strict`~~ was tried and broke the email magic-link flow.
- *Further reading:* the [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

@@ long-stress
# relay-api engineering handbook

This handbook is for someone joining the project who wants the whole picture in one sitting. It goes through the codebase module by module, explains why things are built the way they are, and ends with the operational knowledge that usually lives only in people's heads. Code snippets match the current `main` branch.

## 1. What relay-api is

relay-api is the authentication and account service behind the Relay web and mobile apps. It handles login, logout, session validation, a small admin surface and an inbound billing webhook. It does not serve product data. Other services call it to find out who a request belongs to, either directly through `/me` or by forwarding the session cookie.

The service is deliberately small: one Express application, one Postgres database and no background workers. Most design decisions follow from that. When the choice is between a clever distributed mechanism and something that works well on a single instance, we pick the single-instance version and make sure it can be swapped out later. The session store and the login rate limiter are the clearest examples. Both keep their state in memory today, and both sit behind narrow interfaces that a Redis-backed version could implement without touching the routes.

The codebase is TypeScript in strict mode, compiled with `tsc` for production and run with `tsx` in development. The runtime is Node 22. We use native ES modules everywhere, which is why imports inside `src/` have no file extensions and the package declares `"type": "module"`.

## 2. Repository layout

```text
relay-api/
├── migrations/          # node-pg-migrate files, timestamped
├── src/
│   ├── main.ts          # process entry: config, db, listen
│   ├── app.ts           # builds the Express app (no listen)
│   ├── auth/            # middleware, tokens, passwords, rate limiting
│   ├── lib/             # clock, config, logger
│   ├── server/          # routes, sessions, admin, errors, webhooks
│   ├── types/           # Express request augmentation
│   └── users/           # UserRepo (Postgres + in-memory)
└── tests/               # vitest + supertest
```

The split between `main.ts` and `app.ts` matters more than it looks. `createApp(users)` builds a fully wired Express app without opening a port or a database connection. The integration tests in `tests/routes.test.ts` call it with an `InMemoryUserRepo`, and this keeps the whole suite under two seconds. If you ever feel tempted to read configuration or connect to anything at import time inside `app.ts`, don't. Pass it in from `main.ts` instead.

## 3. The request lifecycle

Every request goes through the same middleware stack, in this order:

1. `express.json({ limit: '100kb' })` parses JSON bodies and rejects anything larger. Nothing in this API needs a bigger body, and the limit cheaply blocks a whole class of abuse.
2. `cookieParser()` populates `req.cookies` so the auth middleware can read `relay_sid`.
3. The routers: the public routes, then admin, then webhooks. Order matters only for the admin router, which mounts `requireAuth` on the `/admin` prefix.
4. `errorHandler` runs last and turns thrown errors into JSON responses.

Handlers are written as async functions that return early on failure. We don't use a validation framework beyond `zod`. Each route that accepts a body declares a schema next to it and calls `safeParse`, so a malformed request turns into a `400 invalid_body` before any business logic runs. Keeping the schema next to the handler makes routes easy to read top to bottom, and the OpenAPI generator can find the schemas by name.

```ts
const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
```

## 4. Sessions

Sessions are opaque. The token a client holds is 24 random bytes encoded as base64url, and it means nothing without the server-side record. We chose this over signed tokens such as JWTs for three reasons. Revocation is immediate, because the record is deleted or flagged. Tokens leak nothing if they are logged by accident. And the validation path is a single map lookup, which is faster than verifying a signature.

`SessionStore` owns the whole lifecycle: `create`, `validate`, `revoke` and `size`. The important method is `validate`. It is the single source of truth for whether a session can be used. It returns a discriminated union rather than throwing, so callers have to handle every failure reason explicitly:

```ts
export type SessionCheck =
  | { ok: true; session: Session }
  | { ok: false; reason: 'missing' | 'expired' | 'revoked' };
```

Expiry is sliding. Each successful validation pushes `expiresAt` forward by the store's TTL, which defaults to thirty minutes. Expired sessions are evicted the moment they are looked up, so the map does not grow without bound. Sessions that are never looked up again can still linger, and that is why the admin endpoint's `active` count is an upper bound rather than an exact figure.

Time comes from an injected `Clock`. In production this is `systemClock`, which wraps `Date.now()`. In tests you pass `{ now: () => t }` and move `t` forward by hand. This is much more predictable than fake timers, which interact badly with `supertest`'s own use of timers and sockets.

## 5. The authentication middleware

`requireAuth(sessions)` is a factory that returns Express middleware. It reads the token from the `Authorization: Bearer` header first and falls back to the `relay_sid` cookie. Mobile clients use the header and the web app uses the cookie. If there is no token at all, the middleware responds `401 missing_token` without touching the store.

Otherwise it calls `sessions.validate(token)` and maps any failure reason to a public error code through a lookup table:

```ts
const FAILURE_CODES: Record<SessionFailure, string> = {
  missing: 'invalid_session',
  expired: 'session_expired',
  revoked: 'session_revoked',
};
```

The table exists because those strings are part of the API contract. The web app shows a different screen for `session_expired`, where it keeps your draft, than for `invalid_session`, where it sends you straight to login. An earlier refactor derived the codes from the internal reason names and briefly turned `invalid_session` into `session_missing`. The test suite caught it. Treat any change to these strings as a breaking API change.

On success the middleware attaches the session to `req.session`. The type augmentation in `src/types/express.d.ts` declares it as optional. That is why handlers behind `requireAuth` use a non-null assertion: the middleware guarantees it, but the type system can't see that.

## 6. Passwords and tokens

Passwords are hashed with bcrypt in `src/auth/passwords.ts`. The cost factor comes from `BCRYPT_COST` and defaults to 12 in production. Tests set it to 4, because at cost 12 every `beforeEach` that creates a user spends about 250 ms hashing, and that used to push the route tests into intermittent timeouts on CI. `verifyPassword` always runs a comparison, even when the user doesn't exist, using a dummy hash. Without that, an attacker could tell valid email addresses from invalid ones by response time.

`src/auth/tokens.ts` is a separate concern. It signs and verifies short payloads with HMAC-SHA256 for the billing webhook. Verification uses `timingSafeEqual` and checks lengths first, because `timingSafeEqual` throws on buffers of different lengths. Both failure modes throw `TokenError`. Note a known gap: `errorHandler` doesn't map `TokenError` yet, so a bad webhook signature currently produces a 500 instead of a 401. It's tracked as a high-priority fix.

## 7. Rate limiting

The login route has a fixed-window limiter in `src/auth/rate-limit.ts`, keyed by client IP plus the normalized email address. The default is five attempts per fifteen minutes. A request over the limit gets `429 too_many_attempts` and a `Retry-After` header with the seconds remaining. A successful login resets the window, so a user who mistypes twice and then gets it right starts the next session with a clean slate.

Two design choices are worth knowing. First, we key on IP *and* email rather than either alone. IP alone would punish everyone behind a shared corporate NAT. Email alone would let an attacker lock any user out by guessing at their address. Second, we deliberately don't lock accounts. Lockout turns the rate limiter into a denial-of-service tool against your own users.

The limiter needs `req.ip` to be the real client address. Behind a load balancer that means setting `app.set('trust proxy', 1)` in `createApp`. Without it every request appears to come from the balancer, and all users share a single window.

## 8. Errors

There are two error styles in the codebase, and you should know both. Route handlers that fail in expected ways return a response directly: `res.status(401).json({ error: 'invalid_credentials' })`. Code deeper in the stack throws an `HttpError(status, code)`, and `errorHandler` turns it into the same `{ error }` shape. `ZodError`s that escape a handler become `400 invalid_body` with the issue list attached, which helps during development.

Anything else is logged with the request path and turned into `500 internal_error`. We never send error messages or stack traces to clients. When you add a new failure mode, prefer an `HttpError` with a specific code over letting it fall through to the 500 branch. A 500 pages someone, and a 4xx doesn't.

One inconsistency remains: the admin guard responds `403 { message: 'Forbidden' }` instead of using the `{ error }` shape. Changing it touches the admin dashboard, which reads `message`, so it needs a coordinated release.

## 9. Configuration

All configuration is read once, in `src/lib/config.ts`, from environment variables. It is validated with `zod` and exported as a frozen object. If a required variable is missing, the process exits at startup with a readable message. That beats failing on the first request that needs it.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection string |
| `PORT` | no | `3000` | HTTP port |
| `WEBHOOK_SECRET` | yes | | HMAC key for billing webhooks |
| `BCRYPT_COST` | no | `12` | Password hashing cost |
| `LOG_LEVEL` | no | `info` | Logger threshold |

For local development, copy `.env.example` to `.env`. The `dev` script loads it through `tsx --env-file`.

## 10. Logging

Logs are structured JSON, one object per line, written by the logger in `src/lib/logger.ts`. The request-log middleware writes one line per request when the response finishes. It includes the method, the route *template* (`/users/:id` rather than `/users/u_123`, so dashboards can group by endpoint), the status, the latency in milliseconds and a request ID. The request ID is taken from an incoming `x-request-id` header when present and echoed back on the response, so a single ID can be followed across services.

The logger redacts the `authorization` and `cookie` headers. If you add logging of request data anywhere else, redact session tokens there too. A leaked opaque token is still a live credential until it expires.

## 11. Testing

The suite runs on vitest with supertest. There are three kinds of test, and new code should usually get the narrowest kind that gives you confidence:

- **Unit tests** such as `tests/session.test.ts` and `tests/tokens.test.ts` exercise one module directly, with an injected clock where time matters.
- **Middleware tests** such as `tests/auth.test.ts` build a tiny Express app around a single middleware and drive it with supertest.
- **Route tests** in `tests/routes.test.ts` use the real `createApp` with an in-memory user repository.

Run everything with `npm test`, one file with `npm test -- auth`, and watch mode with `npx vitest`. The suite should stay under two seconds. If a change makes it noticeably slower, look for real I/O or real timers that slipped in.

```bash
npm test                 # whole suite
npm test -- rate-limit   # one file
npx vitest --coverage    # coverage report in ./coverage
```

## 12. Local development

You need Node 22 and Docker. Postgres runs in a container defined in `docker-compose.yml`. The usual first-run sequence:

```bash
docker compose up -d postgres
cp .env.example .env
npm install
npm run migrate
npm run dev
```

`npm run dev` starts `tsx watch`, which restarts the server on every save. If migrations fail with `ECONNREFUSED 127.0.0.1:5432`, the database container isn't running. `docker compose ps` will show it, and `docker compose up -d postgres` fixes it.

## 13. Database and migrations

Schema changes go through `node-pg-migrate`. Migration files live in `migrations/`, are prefixed with a millisecond timestamp, and must include both `up` and `down`. Review the `down` step as carefully as the `up`. Rollbacks happen under pressure, which is exactly when an untested `down` fails.

A few conventions keep migrations safe on a live database:

1. Add columns as nullable, or with a default, so existing rows stay valid and the migration doesn't rewrite the table.
2. Create indexes `concurrently` on large tables. A migration that wants that has to disable its transaction wrapper.
3. Never rename a column in one step. Add the new column, backfill, deploy code that reads both, then drop the old one in a later release.

## 14. Deployment

The service ships as a container image. CI runs typecheck, lint and tests on every pull request. Merges to `main` build an image and deploy it to staging automatically, and production deploys are a manual promotion of the same image. Migrations run as a separate pre-deploy job, so the application never migrates on startup.

On shutdown the process handles `SIGTERM`. It stops accepting connections, lets in-flight requests finish for up to twenty seconds, closes the Postgres pool and exits. That deadline sits inside the orchestrator's thirty-second grace period on purpose. If you change one, change the other.

## 15. Operational runbook

**Spike in 401s.** Check whether they are `session_expired` or `invalid_session`. A burst of `invalid_session` right after a deploy is expected, because in-memory sessions don't survive restarts. A steady rise in `session_expired` usually means a client stopped renewing, for example a mobile app polling less often than the TTL.

**Spike in 429s on login.** Look at the distribution of request IPs. Many emails from a few IPs is credential stuffing, and the limiter is doing its job. Many IPs that all look like one address means `trust proxy` is misconfigured.

**Webhook 500s.** Almost always a secret rotation on the billing provider's side. Until the `TokenError` mapping ships, these show up as 500s in the logs with `bad signature` in the error.

## 16. Known issues and roadmap

- Map `TokenError` to `401 invalid_signature` in `errorHandler`.
- Align the admin 403 body with the `{ error }` convention, coordinated with the dashboard.
- Add tests for `session_revoked`, the admin guard and the webhook signature path.
- Move sessions and rate-limit windows to Redis when we need a second instance. The interfaces are already narrow enough that this is a contained change.
- Generate the OpenAPI spec from the zod schemas and publish it alongside each release.

## 17. Contributing

Branches are named after what they do, such as `fix/webhook-signature-401` or `feat/login-rate-limit`. Each pull request should do one thing. A refactor and a behaviour change in the same diff are hard to review and harder to revert, so split them, even when the refactor exists to enable the change.

Before asking for review, run the same checks CI runs:

```bash
npm run build && npm run lint && npm test
```

Reviewers look for these things, roughly in this order:

1. **Contract changes.** Does any response shape, status code or error string change? If so, the description must say so, and clients must be checked first.
2. **Failure paths.** Every new branch that can fail should return a specific `{ error }` code, and a test should cover it.
3. **Time and randomness.** New logic that depends on the current time takes a `Clock`. New identifiers come from `node:crypto`, never `Math.random()`.
4. **Secrets in logs.** Nothing that could hold a token, password or cookie should be logged without redaction.

Small follow-ups are fine to leave as comments on the pull request. Anything that affects correctness or security gets fixed before merge.

If something in this handbook is wrong or out of date, fix it in the same pull request as the code change that made it wrong.

@@ mcp-answer
I found **3 open issues** mentioning sessions. #214 is fixed by the expiry refactor, because expired sessions are now evicted on lookup. #209 is still open (the admin 403 body shape), and #188 is a feature request.

Here's a changelog entry in the project's Keep a Changelog format:

```markdown
## [Unreleased]

### Changed
- Session expiry is now enforced in one place, `SessionStore.validate()`.
  `requireAuth` no longer re-implements expiry or hard-codes the 30-minute TTL.

### Fixed
- Expired sessions are evicted from memory when they are looked up, so the
  session map no longer grows until restart and `/admin/sessions` reports an
  accurate count. (#214)
```

I left #209 out because it hasn't shipped. Its fix changes the response shape, so it will need its own **Changed** entry with a migration note for dashboard clients.

@@ review
Reviewed the uncommitted changes (2 files). Overall this is a clean refactor and I'd approve it, with three follow-ups.

**1. `validate()` both checks and renews** (`src/server/session.ts`)
The name reads like a pure query, but a successful call extends the session. That's what `requireAuth` wants, but a future caller using it for a quick "is this still valid?" check would renew sessions as a side effect. Consider a doc comment on the type, or splitting renewal into `touch()` if a second caller appears. *Non-blocking.*

**2. `get()` still bypasses expiry**
`SessionStore.get()` returns expired and revoked sessions without complaint. After this change only `tests/auth.test.ts` uses it, so mark it `/** @internal */` or move tests to `validate()` before someone reaches for it in a route.

**3. Missing test for `session_revoked`**
The `FAILURE_CODES` table is the contract, and only two of its three entries are tested. One more case in `tests/auth.test.ts` closes the gap:

```ts
it('rejects revoked sessions', async () => {
  const { id } = sessions.create('u_1');
  sessions.revoke(id);
  const res = await request(app).get('/me').set('Authorization', `Bearer ${id}`);
  expect(res.body).toEqual({ error: 'session_revoked' });
});
```

No correctness or security problems found. The error codes clients depend on are unchanged.

@@ init-claude-md
# relay-api

Express + TypeScript auth/session service. Node 22, ESM, strict TypeScript.

## Commands
- `npm run dev`: start with `tsx watch` (loads `.env`)
- `npm test`: vitest + supertest, whole suite (< 2 s)
- `npm test -- <name>`: run one test file
- `npm run build`: typecheck and compile with `tsc`
- `npm run migrate`: apply migrations (needs `docker compose up -d postgres`)

## Layout
- `src/app.ts` builds the app without listening. Tests use it with `InMemoryUserRepo`.
- `src/server/session.ts`: `SessionStore`; `validate()` is the only place expiry is decided.
- `src/auth/`: `requireAuth`, password hashing, HMAC tokens, login rate limiting.
- `src/lib/clock.ts`: inject `Clock` instead of calling `Date.now()` in logic.

## Conventions
- Error responses are `{ error: '<code>' }`. The codes are public API, so never rename them.
- Validate request bodies with a zod schema declared next to the route.
- Prefer an injected `Clock` over fake timers in tests.
- Migrations need both `up` and `down`. Add columns nullable or with a default.

@@ init-summary
Created `CLAUDE.md` with the commands, layout and conventions I could confirm from the code. The most important conventions to keep:

- Error codes in `{ error }` responses are public API.
- `SessionStore.validate()` is the single place where expiry is decided.
- Tests inject a `Clock` instead of using fake timers.

Edit it whenever something changes. Future sessions load it automatically.

@@ error-summary
Migrations are applied. They failed at first because Postgres was not running, so I started it with `docker compose up -d postgres`.

The container keeps running. Stop it with `docker compose stop postgres` when you are done.

@@ logging-summary
Structured request logging is in place using **{{library}}**.

**Files**
- `src/lib/logger.ts` (new): the shared logger. It writes JSON lines with an ISO timestamp, the level and `service: "relay-api"`.
- `src/server/request-log.ts` (new): logs one line per request when the response finishes.
- `src/app.ts`: mounts `requestLog` right after `cookieParser()`, so it sees every route, including failures from `requireAuth`.

**Fields on every request line:** {{fields}}.

A typical line:

```json
{{sample}}
```

`npx tsc --noEmit` is clean. Set `LOG_LEVEL=debug` locally if you want more detail.
