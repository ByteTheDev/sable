/**
 * A tiny real project for the Demo's until-green scenario: two source files with three bugs and a
 * check script that tests them and prints a vitest-style run. `/until node check.mjs` fails twice
 * (three failing, then one) and passes once the Demo's turns have fixed both files for real.
 *
 * It lives in the session's own folder when that is a throwaway one (under the temp folder, or a
 * chat folder Sable made), otherwise in a temp folder of its own, named in the check command.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const SESSION_JS = `// Session lifetime for relay-api.
export const IDLE_MINUTES = 60;

/** A session used now lives another IDLE_MINUTES from now. */
export function refresh(session, now = Date.now()) {
  return { ...session, expires: now + IDLE_MINUTES * 60_000 };
}
`;

export const SESSION_FIXED = `// Session lifetime for relay-api.
export const IDLE_MINUTES = 30;

/** A session used now lives another IDLE_MINUTES from now. */
export function refresh(session, now = Date.now()) {
  return { ...session, expiresAt: now + IDLE_MINUTES * 60_000 };
}
`;

export const AUTH_JS = `// Why requireAuth turns a request away.
export function rejection(token, sessions) {
  if (!token) return 'missing_token';
  return sessions.has(token) ? null : 'session_missing';
}
`;

export const AUTH_FIXED = `// Why requireAuth turns a request away.
export function rejection(token, sessions) {
  if (!token) return 'missing_token';
  return sessions.has(token) ? null : 'invalid_session';
}
`;

export interface UntilFixture {
  dir: string;
  /** The check to arm: `node check.mjs` in the session's own folder, else with the full path. */
  command: string;
  read(rel: 'src/session.js' | 'src/auth.js'): string;
  write(rel: 'src/session.js' | 'src/auth.js', content: string): void;
}

const inside = (dir: string, root: string) => {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Where the fixture goes for this session (nothing is written). */
export function untilFixture(cwd: string, sessionId: string, chat = false): UntilFixture {
  const own = chat || inside(cwd, tmpdir());
  const dir = own ? cwd : path.join(tmpdir(), `sable-until-${sessionId.slice(0, 8)}`);
  const file = (rel: string) => path.join(dir, ...rel.split('/'));
  return {
    dir,
    command: own ? 'node check.mjs' : `node "${path.join(dir, 'check.mjs')}"`,
    read: (rel) => {
      try {
        return readFileSync(file(rel), 'utf8');
      } catch {
        return '';
      }
    },
    write: (rel, content) => {
      mkdirSync(path.dirname(file(rel)), { recursive: true });
      writeFileSync(file(rel), content);
    },
  };
}

/** Writes the project with its three bugs (again, when it was fixed before); `check` is the script (demo-content.md's `until-check`). */
export function seedUntilFixture(f: UntilFixture, check: string) {
  mkdirSync(path.join(f.dir, 'src'), { recursive: true });
  writeFileSync(path.join(f.dir, 'check.mjs'), check.trimEnd() + '\n');
  f.write('src/session.js', SESSION_JS);
  f.write('src/auth.js', AUTH_JS);
}

