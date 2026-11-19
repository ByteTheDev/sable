/**
 * Until green: `/until <check>` arms a loop on a session. After each turn that ends normally (no
 * error, not stopped, nothing left in the queue), Sable runs the check itself in the session's
 * folder; a failure goes back to the agent as the next message, until the check passes, the round
 * limit is reached, the account's usage share for the loop is spent (or the account is at its cap
 * with no account to move to), or the user stops it. Messages the user sends always go first: the
 * check waits for the turn they start. A loop lives as long as Sable runs (it says so after a restart).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { NoticeItem, UntilCheck, UntilEnd, UntilMark, UntilState } from '../../shared/protocol';
import { killTree } from '../util/proc';
import type { SessionRuntime } from './runtime';

export const UNTIL_ROUNDS = 5;
export const UNTIL_MAX_ROUNDS = 20;
/** Points of the account's weekly window one loop may use. */
export const UNTIL_USAGE = 10;
export const CHECK_TIMEOUT_MS = 10 * 60_000;
/** What is kept of a check's output for the agent and the timeline. */
const KEEP_LINES = 60;
const KEEP_CHARS = 4000;
const LINE_CHARS = 300;

// ─────────────────────────────────── the command ───────────────────────────────────

export interface UntilArgs {
  check: string;
  rounds: number;
  usage: number;
}

/**
 * What follows `/until`: the check, with `--rounds N` (1..20) and `--usage N` (weekly points,
 * 1..100) anywhere in it. `off` (or `stop`) ends the loop.
 */
export function parseUntil(text: string): { off: true } | { args: UntilArgs } | { error: string } {
  let rest = text.trim();
  if (/^(off|stop)$/i.test(rest)) return { off: true };
  let rounds = UNTIL_ROUNDS;
  let usage = UNTIL_USAGE;
  const flag = /(?:^|\s)--(rounds|usage)(?:=|\s+)(\S+)(?=\s|$)/i;
  for (let m = flag.exec(rest); m; m = flag.exec(rest)) {
    const n = Number(m[2].replace(/%$/, ''));
    if (m[1].toLowerCase() === 'rounds') {
      if (!Number.isInteger(n) || n < 1) return { error: 'Rounds is a whole number, like --rounds 8' };
      rounds = Math.min(n, UNTIL_MAX_ROUNDS);
    } else {
      if (!Number.isFinite(n) || n <= 0) return { error: 'Usage is in points of the week, like --usage 15' };
      usage = Math.min(n, 100);
    }
    rest = (rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length)).trim();
  }
  const check = rest.replace(/^`(.+)`$/s, '$1').trim();
  if (!check) return { error: 'Add a check after /until, like /until pnpm test' };
  return { args: { check, rounds, usage } };
}

// ─────────────────────────────────── the output ───────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Plain lines: no colour codes, a line redrawn with \r keeps what it ended as. */
export function cleanOutput(raw: string): string[] {
  return raw
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l.includes('\r') ? (l.split('\r').filter((p) => p.trim()).pop() ?? '') : l).replace(/\s+$/, ''));
}

/** The last match of each pattern, as numbers. */
function lastMatch(text: string, re: RegExp): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (let m = g.exec(text); m; m = g.exec(text)) last = m;
  return last;
}

/** How many failed and passed, as test runners and compilers say it in their summary. */
export function countResults(text: string): { failing?: number; passing?: number } {
  const num = (s: string | undefined) => (s === undefined ? undefined : Number(s));
  // vitest: "Tests  1 failed | 24 passed (25)"; jest: "Tests:  2 failed, 10 passed, 12 total".
  const vt = lastMatch(text, /^\s*Tests:?\s+(?:(\d+) failed)?[\s|,]*(?:\d+ skipped[\s|,]*)?(?:(\d+) passed)?/m);
  if (vt && (vt[1] || vt[2])) return { failing: num(vt[1]) ?? 0, passing: num(vt[2]) };
  // pytest: "== 2 failed, 10 passed in 0.5s ==".
  const py = lastMatch(text, /^=+ (?:(\d+) failed)?(?:, )?(?:(\d+) passed)?.* in [\d.]+s/m);
  if (py && (py[1] || py[2])) return { failing: num(py[1]) ?? 0, passing: num(py[2]) };
  // cargo: "test result: FAILED. 10 passed; 2 failed;".
  const cargo = lastMatch(text, /test result: \w+\. (\d+) passed; (\d+) failed/);
  if (cargo) return { failing: Number(cargo[2]), passing: Number(cargo[1]) };
  // mocha: "10 passing" / "2 failing"; node --test: "# fail 2" / "ℹ fail 2".
  const mFail = lastMatch(text, /^\s*(\d+) failing\b/m) ?? lastMatch(text, /^(?:#|ℹ) fail (\d+)/m);
  const mPass = lastMatch(text, /^\s*(\d+) passing\b/m) ?? lastMatch(text, /^(?:#|ℹ) pass (\d+)/m);
  if (mFail || mPass) return { failing: mFail ? Number(mFail[1]) : 0, passing: mPass ? Number(mPass[1]) : undefined };
  // tsc: "Found 3 errors in 2 files." or, without a summary, one "error TS…" per line.
  const found = lastMatch(text, /^Found (\d+) errors?\b/m);
  if (found) return { failing: Number(found[1]) };
  const ts = text.match(/\berror TS\d+:/g);
  if (ts) return { failing: ts.length };
  // eslint: "✖ 5 problems (3 errors, 2 warnings)".
  const lint = lastMatch(text, /✖ \d+ problems? \((\d+) errors?/);
  if (lint) return { failing: Number(lint[1]) };
  // go test: one "--- FAIL:" per failing test.
  const go = text.match(/^\s*--- FAIL:/gm);
  if (go) return { failing: go.length };
  return {};
}

/** A line that says something went wrong (where the useful part of a failing run starts). */
const TROUBLE =
  /(\bFAIL(?:ED)?\b|\bfailed\b|\bfailing\b|[×✗✕✖]|\bError\b|\berror\b|AssertionError|\bexpected\b|\bExpected\b|\bpanicked\b|Traceback|\bassert)/;
/** A line that only says something passed: never useful to the agent. */
const PASSING = /^\s*(?:[✓✔√]\s|PASS\s|ok \d+ |ok\s+\S+\s+[\d.]+s$)/;

export interface Digest {
  /** The useful part, trimmed (empty when the check printed nothing). */
  text: string;
  failing?: number;
  passing?: number;
}

/**
 * The useful part of a check's output: from the first line that names a failure (failing tests,
 * the first errors) on, its head and the summary at the end, passing lines left out; otherwise
 * its last lines. At most 60 lines and 4 KB.
 */
export function digest(raw: string): Digest {
  const all = cleanOutput(raw);
  const counts = countResults(all.join('\n'));
  const lines: string[] = [];
  for (const l of all) {
    if (PASSING.test(l)) continue;
    // One blank line at most between lines.
    if (!l.trim() && (!lines.length || !lines[lines.length - 1].trim())) continue;
    lines.push(l.length > LINE_CHARS ? l.slice(0, LINE_CHARS - 1) + '…' : l);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const first = lines.findIndex((l) => TROUBLE.test(l));
  let keep: string[];
  if (first < 0) {
    keep = lines.length > KEEP_LINES ? [`… ${lines.length - KEEP_LINES} lines before`, ...lines.slice(-KEEP_LINES)] : lines;
  } else {
    const from = first;
    const region = lines.slice(from);
    const tailN = 8;
    if (region.length <= KEEP_LINES) keep = region;
    else {
      const head = region.slice(0, KEEP_LINES - tailN - 1);
      const tail = region.slice(-tailN);
      keep = [...head, `… ${region.length - head.length - tail.length} lines`, ...tail];
    }
  }
  // Within the character budget: the head gives way, the summary at the end stays.
  let text = keep.join('\n');
  if (text.length > KEEP_CHARS) {
    const tail = keep.slice(-8).join('\n');
    const room = Math.max(0, KEEP_CHARS - tail.length - 20);
    let head = '';
    for (const l of keep.slice(0, -8)) {
      if (head.length + l.length + 1 > room) break;
      head += l + '\n';
    }
    text = `${head}… cut\n${tail}`;
  }
  return { text: text.trim() ? text : '', ...counts };
}

// ─────────────────────────────────── running a check ───────────────────────────────────

export interface CheckOutcome {
  code: number | null;
  output: string;
  durationMs: number;
  timedOut?: boolean;
  /** It could not start at all (no folder, no shell, the command does not exist). */
  missing?: boolean;
  /** Stopped before it ended (a turn started, the loop was stopped). */
  aborted?: boolean;
}

export type CheckRunner = (command: string, cwd: string, signal: AbortSignal) => Promise<CheckOutcome>;

const MAX_OUTPUT = 2_000_000;

/**
 * Runs a check through the shell in `cwd`, its own process tree, stdout and stderr together, with
 * no colours and CI set (no watch modes). Killed on timeout or abort.
 */
export function runCheck(command: string, cwd: string, signal: AbortSignal, timeoutMs = CHECK_TIMEOUT_MS): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    let head = '';
    let tail = '';
    let cut = false;
    let done = false;
    let child: ChildProcess | undefined;
    const output = () => (cut ? `${head}\n… output cut …\n${tail}` : head);
    const finish = (o: Omit<CheckOutcome, 'durationMs' | 'output'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ ...o, output: output(), durationMs: Date.now() - started });
    };
    const onAbort = () => {
      killTree(child);
      finish({ code: null, aborted: true });
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    const take = (d: Buffer) => {
      const s = d.toString();
      if (!cut && head.length + s.length <= MAX_OUTPUT / 2) head += s;
      else {
        cut = cut || head.length + s.length > MAX_OUTPUT / 2;
        tail = (tail + s).slice(-MAX_OUTPUT / 2);
      }
    };
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: process.env.CI || '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      });
    } catch (err) {
      head = (err as Error).message;
      return finish({ code: null, missing: true });
    }
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', (err) => {
      if (!head) head = err.message;
      finish({ code: null, missing: true });
    });
    child.on('close', (code) => finish({ code, missing: notFound(command, code, output()) }));
  });
}

/**
 * The shell could not find the command, so nothing ran and there is nothing for the agent to fix:
 * exit 127 (sh) or 9009, or a short answer of two or three lines that names the program in quotes,
 * as cmd.exe does in every language ("'pnpmm' is not recognized…", "Der Befehl "pnpmm" ist…").
 */
export function notFound(command: string, code: number | null, output: string): boolean {
  if (code === 0 || code === null) return false;
  if (code === 127 || code === 9009) return true;
  const text = output.trim();
  const m = /^"([^"]+)"|^(\S+)/.exec(command.trim());
  const prog = m?.[1] ?? m?.[2];
  if (!prog || text.length > 400 || text.split(/\r?\n/).length > 3) return false;
  return [`'${prog}'`, `"${prog}"`, `${prog}: not found`, `${prog}: command not found`].some((p) => text.includes(p));
}

// ─────────────────────────────────── what is said ───────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A fence that the output cannot close. */
function fenced(text: string): string {
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return `${fence}text\n${text}\n${fence}`;
}

/** The message the agent gets for a failing check. */
export function failureMessage(check: UntilCheck): string {
  const why = check.timedOut
    ? `it did not finish within ${Math.round(CHECK_TIMEOUT_MS / 60_000)} minutes`
    : [check.exitCode != null ? `exit code ${check.exitCode}` : '', check.failing ? `${check.failing} failing` : ''].filter(Boolean).join(', ');
  const head = `The check \`${check.command}\` failed${why ? ` (${why})` : ''}. Fix the cause, not the check. When your turn ends, Sable runs it again (round ${check.round + 1} of ${check.rounds}).`;
  return check.output ? `${head}\n\n${fenced(check.output)}` : `${head}\n\nIt printed nothing.`;
}

/** The end line: "Green after 3 rounds", "Stopped after 5 rounds: 2 still failing". */
export function endLine(end: UntilEnd, rounds: number, o: { failing?: number; used?: number; account?: string; reason?: string } = {}): string {
  const after = rounds > 0 ? `after ${plural(rounds, 'round')}` : 'before the first check';
  switch (end) {
    case 'passed':
      return `Green ${after}`;
    case 'rounds':
      return `Stopped ${after}: ${o.failing ? `${o.failing} still failing` : 'still failing'}`;
    case 'usage':
      return `Stopped ${after}: this loop used ${Math.round(o.used ?? 0)}% of ${o.account ?? 'the account'}'s week`;
    case 'cap':
      return `Stopped ${after}: ${o.reason ?? 'the account reached its cap'}`;
    case 'broken':
      return 'Stopped: the check could not run';
    case 'restart':
      return `Stopped ${after}: Sable closed`;
    default:
      return `Stopped ${after}`;
  }
}

// ─────────────────────────────────── the loop ───────────────────────────────────

export interface UntilHost {
  /** A turn runs, or a message waits for the agent to start. */
  busy(rt: SessionRuntime): boolean;
  /** What the app does between turns before anything goes out (moving off an account at its cap). */
  settle(rt: SessionRuntime): Promise<void>;
  /** The session's account's weekly window across all models, as last known. */
  weekly(rt: SessionRuntime): Promise<{ percent: number; resetsAt?: number } | undefined>;
  /** Why the session's account may not go on (at its cap, nowhere to move); undefined when it may. */
  capped(rt: SessionRuntime): Promise<string | undefined>;
  accountLabel(rt: SessionRuntime): string;
  /** Sends the failure to the agent (a user item marked with the check). */
  send(rt: SessionRuntime, text: string, mark: UntilMark): Promise<void>;
  run: CheckRunner;
  log(...args: unknown[]): void;
}

/** One account's weekly window while the loop used it: where it started, where it is, what earlier windows added. */
interface Meter {
  base: number;
  last: number;
  resetsAt?: number;
  closed: number;
}

interface Loop {
  rt: SessionRuntime;
  state: UntilState;
  /** Bumped by everything that makes a check in flight stale. */
  gen: number;
  abort?: AbortController;
  meters: Map<string, Meter>;
}

/** A new weekly window (the reset moved by more than this): what the old one added is kept. */
const NEW_WINDOW_MS = 3_600_000;

export class UntilLoops {
  private loops = new Map<string, Loop>();
  /** End lines of loops stopped while a turn ran: they go in after that turn, not folded into its work. */
  private pending = new Map<string, Omit<NoticeItem, 'id' | 'ts'>>();
  /** One check at a time across the app: a laptop running several test suites at once crawls. */
  private gate: Promise<unknown> = Promise.resolve();

  constructor(private host: UntilHost) {}

  get(sessionId: string): UntilState | undefined {
    return this.loops.get(sessionId)?.state;
  }

  /** Arms (or re-arms) the loop. Idle, the first check runs now; otherwise when the turn ends. */
  arm(rt: SessionRuntime, args: UntilArgs): UntilState {
    const old = this.loops.get(rt.id);
    if (old) this.end(old, 'stopped', undefined, {}, old.state.round <= 1);
    const busy = this.host.busy(rt);
    const loop: Loop = {
      rt,
      gen: 0,
      meters: new Map(),
      state: { check: args.check, rounds: args.rounds, round: 1, phase: busy ? 'working' : 'checking', usage: args.usage, startedAt: Date.now() },
    };
    this.loops.set(rt.id, loop);
    rt.update({ until: { ...loop.state } });
    void this.sample(loop);
    if (!busy) void this.check(loop);
    return loop.state;
  }

  /** The user stopped it (Stop, `/until off`). */
  stop(rt: SessionRuntime): boolean {
    const loop = this.loops.get(rt.id);
    if (!loop) return false;
    this.end(loop, 'stopped');
    return true;
  }

  /** Runs the check now, when the session is idle (a paused loop, or one waiting on a turn that never came). */
  checkNow(rt: SessionRuntime): boolean {
    const loop = this.loops.get(rt.id);
    if (!loop || loop.state.phase === 'checking' || this.host.busy(rt)) return false;
    void this.check(loop);
    return true;
  }

  /** A turn started: a check in flight is stale (the user's message goes first), the loop follows the turn. */
  turnStarted(rt: SessionRuntime) {
    const loop = this.loops.get(rt.id);
    if (!loop) return;
    if (loop.state.phase === 'checking') {
      loop.gen++;
      loop.abort?.abort();
      loop.abort = undefined;
    }
    if (loop.state.phase !== 'working') this.patch(loop, { phase: 'working' });
    // A loop that moved to another account starts that account's meter from here.
    void this.sample(loop);
  }

  /** Any turn ended (before the app decides what goes next): an end line held for it goes in now. */
  turnOver(rt: SessionRuntime) {
    const line = this.pending.get(rt.id);
    if (!line) return;
    this.pending.delete(rt.id);
    rt.add<NoticeItem>(line);
  }

  /** A turn ended normally and nothing waits in the queue: the check runs. */
  turnEnded(rt: SessionRuntime) {
    const loop = this.loops.get(rt.id);
    if (!loop || loop.state.phase === 'checking') return;
    void this.check(loop);
  }

  /** A turn was stopped or failed: the loop waits for the next turn (or Check now). */
  turnHeld(rt: SessionRuntime) {
    const loop = this.loops.get(rt.id);
    if (loop?.state.phase === 'working') this.patch(loop, { phase: 'paused' });
  }

  /** The session closed or was deleted: the loop ends without a word. */
  closed(rt: SessionRuntime) {
    this.pending.delete(rt.id);
    const loop = this.loops.get(rt.id);
    if (loop) this.end(loop, 'stopped', undefined, {}, true);
  }

  /** A session restored after a restart had a loop: it says the loop ended with Sable. */
  restored(rt: SessionRuntime, was: UntilState) {
    rt.add<NoticeItem>({ type: 'notice', variant: 'info', text: endLine('restart', Math.max(0, was.round - 1)), detail: was.check, until: { end: 'restart' } });
  }

  dispose() {
    for (const loop of this.loops.values()) {
      loop.gen++;
      loop.abort?.abort();
    }
    this.loops.clear();
  }

  // ── inside ──

  private live(loop: Loop, gen: number) {
    return this.loops.get(loop.rt.id) === loop && loop.gen === gen;
  }

  private patch(loop: Loop, patch: Partial<UntilState>) {
    Object.assign(loop.state, patch);
    loop.rt.update({ until: { ...loop.state } });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(fn, fn);
    this.gate = run.catch(() => {});
    return run;
  }

  private async check(loop: Loop) {
    const gen = ++loop.gen;
    const rt = loop.rt;
    const { check: command, round, rounds } = loop.state;
    this.patch(loop, { phase: 'checking', since: Date.now() });
    // A move off an account at its cap comes first: the loop goes on where the session goes.
    await this.host.settle(rt).catch(() => {});
    if (!this.live(loop, gen)) return;
    const ctrl = new AbortController();
    loop.abort = ctrl;
    let outcome: CheckOutcome;
    try {
      outcome = await this.serial(() => (ctrl.signal.aborted ? Promise.resolve<CheckOutcome>({ code: null, output: '', durationMs: 0, aborted: true }) : this.host.run(command, rt.meta.cwd, ctrl.signal)));
    } catch (err) {
      outcome = { code: null, output: (err as Error).message, durationMs: 0, missing: true };
    }
    if (loop.abort === ctrl) loop.abort = undefined;
    if (!this.live(loop, gen) || outcome.aborted) return;

    const d = digest(outcome.output);
    const passed = outcome.code === 0 && !outcome.timedOut;
    const result: UntilCheck = {
      command,
      round,
      rounds,
      passed,
      exitCode: outcome.code,
      ...(passed ? { passing: d.passing } : { failing: d.failing || undefined, passing: d.passing }),
      ...(outcome.timedOut ? { timedOut: true } : {}),
      durationMs: outcome.durationMs,
      ...(d.text ? { output: d.text } : {}),
    };
    if (passed) return this.end(loop, 'passed', result);
    if (outcome.missing) return this.end(loop, 'broken', { ...result, output: d.text || outcome.output.trim() || undefined });
    if (round >= rounds) return this.end(loop, 'rounds', result, { failing: result.failing });

    const used = await this.sample(loop);
    if (!this.live(loop, gen)) return;
    if (used >= loop.state.usage) return this.end(loop, 'usage', result, { used, account: this.host.accountLabel(rt) });
    const capped = await this.host.capped(rt).catch(() => undefined);
    if (!this.live(loop, gen)) return;
    if (capped) return this.end(loop, 'cap', result, { reason: capped });
    // Something went out meanwhile: its turn first, then the check again, same round.
    if (this.host.busy(rt)) return this.patch(loop, { phase: 'working' });

    this.patch(loop, { round: round + 1, phase: 'working', failing: result.failing, used: used > 0 ? Math.round(used * 10) / 10 : undefined });
    try {
      await this.host.send(rt, failureMessage(result), { check: result });
    } catch (err) {
      this.host.log('until: could not send the failure', (err as Error).message);
      if (this.live(loop, gen)) this.patch(loop, { phase: 'paused' });
    }
  }

  /** Reads the session's account's weekly window into its meter; the points the loop used so far. */
  private async sample(loop: Loop): Promise<number> {
    const rt = loop.rt;
    const account = rt.meta.accountId ?? 'default';
    const w = await this.host.weekly(rt).catch(() => undefined);
    if (w && Number.isFinite(w.percent)) {
      const m = loop.meters.get(account);
      if (!m) loop.meters.set(account, { base: w.percent, last: w.percent, resetsAt: w.resetsAt, closed: 0 });
      else {
        const moved = !!w.resetsAt && !!m.resetsAt && Math.abs(w.resetsAt - m.resetsAt) > NEW_WINDOW_MS;
        if (moved || w.percent < m.last - 0.5) {
          m.closed += Math.max(0, m.last - m.base);
          m.base = 0;
        }
        m.last = w.percent;
        if (w.resetsAt) m.resetsAt = w.resetsAt;
      }
    }
    let used = 0;
    for (const m of loop.meters.values()) used += m.closed + Math.max(0, m.last - m.base);
    return used;
  }

  private end(loop: Loop, end: UntilEnd, check?: UntilCheck, o: { failing?: number; used?: number; account?: string; reason?: string } = {}, silent = false) {
    const rt = loop.rt;
    loop.gen++;
    loop.abort?.abort();
    loop.abort = undefined;
    if (this.loops.get(rt.id) === loop) this.loops.delete(rt.id);
    if (!silent) {
      // Rounds whose check ran: the one that just did, or those before the round in progress.
      const done = check ? check.round : loop.state.round - 1;
      const line: Omit<NoticeItem, 'id' | 'ts'> = {
        type: 'notice',
        variant: 'info',
        text: endLine(end, done, o),
        ...(check ? {} : { detail: loop.state.check }),
        until: { end, ...(check ? { check } : {}) },
      };
      // Mid-turn (stopped while the agent works) the line waits for the turn's end.
      if (this.host.busy(rt)) this.pending.set(rt.id, line);
      else rt.add<NoticeItem>(line);
    }
    rt.update({ until: null });
  }
}
