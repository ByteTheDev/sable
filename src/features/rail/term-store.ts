import { useSyncExternalStore } from 'react';
import type { ProjectScript } from '@shared/protocol';
import { bridge } from '@/lib/bridge';
import { devServerUrls, mayHaveDevUrl, type DevUrl } from '@/lib/dev-url';
import { onTerm } from '@/state/store';
import { rememberDevUrl } from './dev-urls';

/**
 * The panel terminal's transcript, kept outside React and outside the app store:
 * output is high-volume and only this view reads it. Runs survive tab switches and
 * closing the panel for the app's lifetime. Writers append to per-run chunks; views
 * are notified at most once per animation frame.
 */

export type RunState = 'starting' | 'running' | 'done' | 'killed' | 'failed';

export interface Chunk {
  s: 'out' | 'err';
  t: string;
}

export interface TermRun {
  id: number;
  sessionId: string;
  termId?: string;
  command: string;
  /** A script's name: the run is that script's terminal (from the Run control or the palette). */
  name?: string;
  /** Which script it runs ("package:dev"), so choosing the script again finds this run. */
  script?: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  code?: number | null;
  state: RunState;
  stopping?: boolean;
  error?: string;
  chunks: Chunk[];
  size: number;
  trimmed: boolean;
  /** Local dev-server addresses its output announced, the latest last (see lib/dev-url.ts). */
  urls: DevUrl[];
  /** Start again in place once this process has exited (Restart). */
  restart?: boolean;
  /** Each stream's unfinished last line, held until its line ends (addresses are read per line). */
  tails: Record<Chunk['s'], string>;
  /** Bumped on every change, so memoized views know when to re-render. */
  v: number;
}

interface SessionTerm {
  runs: TermRun[];
  history: string[];
}

/** Characters of output kept per run; older output is dropped from the front. */
const KEEP = 200_000;
const MAX_RUNS = 80;
const MAX_HISTORY = 200;

const sessions = new Map<string, SessionTerm>();
const byTerm = new Map<string, { sessionId: string; run: TermRun }>();
/** Events for a termId that arrived before `term.run` answered. */
const early = new Map<string, Parameters<Parameters<typeof onTerm>[0]>[0][]>();
let nextId = 1;
let version = 0;
const listeners = new Set<() => void>();
let frame = 0;

function notify() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    version++;
    for (const l of listeners) l();
  });
}

function subscribe(l: () => void) {
  ensureListening();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function get(sessionId: string): SessionTerm {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { runs: [], history: [] };
    sessions.set(sessionId, s);
  }
  return s;
}

/** Longest unfinished line kept for the address scan. */
const TAIL_MAX = 4000;

/**
 * Reads the lines this output completes for dev-server addresses: per stream, only whole lines
 * (an address cut across two reads is read once it is whole), and only text that names a loopback
 * address at all, so a chatty command costs one quick test per chunk.
 */
function scanUrls(run: TermRun, s: Chunk['s'], t: string) {
  const text = run.tails[s] + t;
  const nl = text.lastIndexOf('\n');
  if (nl < 0) {
    run.tails[s] = text.length > TAIL_MAX ? text.slice(-TAIL_MAX) : text;
    return;
  }
  const rest = text.slice(nl + 1);
  run.tails[s] = rest.length > TAIL_MAX ? rest.slice(-TAIL_MAX) : rest;
  const lines = text.slice(0, nl + 1);
  if (!mayHaveDevUrl(lines)) return;
  const found = devServerUrls(lines, run.command);
  if (!found.length) return;
  for (const u of found) {
    const i = run.urls.findIndex((x) => x.label === u.label);
    const keep = i >= 0 ? run.urls[i] : u;
    if (i >= 0) run.urls.splice(i, 1);
    run.urls.push(keep);
  }
  rememberDevUrl(run.cwd, run.urls[run.urls.length - 1].url, run.name ?? run.command);
}

function append(run: TermRun, s: Chunk['s'], t: string) {
  if (!t) return;
  scanUrls(run, s, t);
  const last = run.chunks[run.chunks.length - 1];
  if (last && last.s === s) last.t += t;
  else run.chunks.push({ s, t });
  run.size += t.length;
  if (run.size > KEEP) {
    // Drop whole chunks, then cut the first one at a line break.
    let excess = run.size - Math.floor(KEEP * 0.8);
    while (excess > 0 && run.chunks.length) {
      const c = run.chunks[0];
      if (c.t.length <= excess) {
        excess -= c.t.length;
        run.size -= c.t.length;
        run.chunks.shift();
      } else {
        let cut = c.t.indexOf('\n', excess);
        if (cut < 0 || cut - excess > 2000) cut = excess;
        else cut += 1;
        run.size -= cut;
        c.t = c.t.slice(cut);
        excess = 0;
      }
    }
    run.trimmed = true;
  }
  run.v++;
}

function apply(sessionId: string, run: TermRun, e: Parameters<Parameters<typeof onTerm>[0]>[0]) {
  if (e.type === 'term.data') {
    append(run, e.stream, e.data);
  } else {
    run.code = e.code;
    run.endedAt = Date.now();
    run.state = run.stopping ? 'killed' : 'done';
    run.v++;
    byTerm.delete(e.termId);
    if (run.restart) relaunch(run);
  }
  void sessionId;
}

let listening = false;
function ensureListening() {
  if (listening) return;
  listening = true;
  onTerm((e) => {
    const hit = byTerm.get(e.termId);
    if (!hit) {
      const list = early.get(e.termId) ?? [];
      list.push(e);
      early.set(e.termId, list);
      // Unclaimed ids belong to someone else; forget them soon.
      window.setTimeout(() => early.delete(e.termId), 10_000);
      return;
    }
    apply(hit.sessionId, hit.run, e);
    notify();
  });
}

/** Starts a run's process (a new run, or one starting again in place). */
function launch(run: TermRun) {
  const { sessionId } = run;
  bridge
    .call('term.run', { cwd: run.cwd, command: run.command })
    .then(({ termId }) => {
      run.termId = termId;
      if (run.state === 'starting') run.state = 'running';
      run.v++;
      byTerm.set(termId, { sessionId, run });
      const pending = early.get(termId);
      early.delete(termId);
      for (const e of pending ?? []) apply(sessionId, run, e);
      notify();
    })
    .catch((err: Error) => {
      run.state = 'failed';
      run.error = err.message || String(err);
      run.endedAt = Date.now();
      run.v++;
      notify();
    });
}

/** Starts the same command again in the same block: its output starts over. */
function relaunch(run: TermRun) {
  Object.assign(run, {
    termId: undefined,
    code: undefined,
    endedAt: undefined,
    error: undefined,
    stopping: false,
    restart: false,
    state: 'starting',
    startedAt: Date.now(),
    chunks: [],
    size: 0,
    trimmed: false,
    urls: [],
    tails: { out: '', err: '' },
  } satisfies Partial<TermRun>);
  run.v++;
  notify();
  launch(run);
}

export function runCommand(sessionId: string, cwd: string, command: string, as?: { name: string; script: string }): TermRun | undefined {
  ensureListening();
  const cmd = command.trim();
  if (!cmd) return undefined;
  const s = get(sessionId);
  if (s.history[s.history.length - 1] !== cmd) {
    s.history.push(cmd);
    if (s.history.length > MAX_HISTORY) s.history.shift();
  }
  const run: TermRun = {
    id: nextId++,
    sessionId,
    command: cmd,
    ...(as ? { name: as.name, script: as.script } : {}),
    cwd,
    startedAt: Date.now(),
    state: 'starting',
    chunks: [],
    size: 0,
    trimmed: false,
    urls: [],
    tails: { out: '', err: '' },
    v: 0,
  };
  s.runs.push(run);
  if (s.runs.length > MAX_RUNS) {
    const drop = s.runs.findIndex((r) => r.state !== 'running' && r.state !== 'starting');
    if (drop >= 0) s.runs.splice(drop, 1);
  }
  notify();
  launch(run);
  return run;
}

export const scriptKey = (script: Pick<ProjectScript, 'source' | 'name'>) => `${script.source}:${script.name}`;

const isLive = (r: TermRun) => r.state === 'running' || r.state === 'starting';

/** The session's live run of a script in a folder, if one is running. */
export function runningScript(sessionId: string, cwd: string, key: string): TermRun | undefined {
  return getRuns(sessionId).find((r) => r.script === key && r.cwd === cwd && isLive(r));
}

/**
 * Runs a script as a terminal named after it. Chosen again while it runs, its terminal comes into
 * view instead of a second copy (a dev server would only fight the first for its port).
 */
export function runScript(sessionId: string, cwd: string, script: ProjectScript): TermRun | undefined {
  const key = scriptKey(script);
  const live = runningScript(sessionId, cwd, key);
  if (live) {
    focusRun(live, true);
    return live;
  }
  const run = runCommand(sessionId, cwd, script.run, { name: script.name, script: key });
  if (run) focusRun(run, false);
  return run;
}

/** Restart: a running process is stopped and the command starts again in the same block; a finished one starts again. */
export function restartRun(run: TermRun) {
  if (run.state === 'starting') return;
  if (run.state === 'running') {
    run.restart = true;
    run.v++;
    if (run.stopping) {
      notify();
      return;
    }
    killRun(run);
    return;
  }
  relaunch(run);
}

/* ── the run the Terminal tab brings into view (a script chosen again, or just started) ── */

const focusBy = new Map<string, { runId: number; flash: boolean; at: number }>();

function focusRun(run: TermRun, flash: boolean) {
  focusBy.set(run.sessionId, { runId: run.id, flash, at: Date.now() });
  notify();
}

export function getFocus(sessionId: string): { runId: number; flash: boolean; at: number } | undefined {
  return focusBy.get(sessionId);
}

export function killRun(run: TermRun) {
  if (run.state !== 'running' || !run.termId || run.stopping) return;
  run.stopping = true;
  run.v++;
  notify();
  void bridge.call('term.kill', { termId: run.termId }).catch(() => {});
}

/** Stops the newest running command in a session. Returns whether one was running. */
export function killLatest(sessionId: string): boolean {
  const runs = sessions.get(sessionId)?.runs ?? [];
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].state === 'running' && !runs[i].stopping) {
      killRun(runs[i]);
      return true;
    }
  }
  return false;
}

/** Clears finished runs; running ones stay so they can still be stopped. */
export function clearRuns(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.runs = s.runs.filter((r) => r.state === 'running' || r.state === 'starting');
  notify();
}

export function getRuns(sessionId: string): TermRun[] {
  return sessions.get(sessionId)?.runs ?? [];
}

export function getHistory(sessionId: string): string[] {
  return sessions.get(sessionId)?.history ?? [];
}

/** Re-renders the caller (at most once per frame) whenever any transcript changes. */
export function useTermVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
