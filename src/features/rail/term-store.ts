import { useSyncExternalStore } from 'react';
import { bridge } from '@/lib/bridge';
import { onTerm } from '@/state/store';

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
  termId?: string;
  command: string;
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

function append(run: TermRun, s: Chunk['s'], t: string) {
  if (!t) return;
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

export function runCommand(sessionId: string, cwd: string, command: string) {
  ensureListening();
  const cmd = command.trim();
  if (!cmd) return;
  const s = get(sessionId);
  if (s.history[s.history.length - 1] !== cmd) {
    s.history.push(cmd);
    if (s.history.length > MAX_HISTORY) s.history.shift();
  }
  const run: TermRun = { id: nextId++, command: cmd, cwd, startedAt: Date.now(), state: 'starting', chunks: [], size: 0, trimmed: false, v: 0 };
  s.runs.push(run);
  if (s.runs.length > MAX_RUNS) {
    const drop = s.runs.findIndex((r) => r.state !== 'running' && r.state !== 'starting');
    if (drop >= 0) s.runs.splice(drop, 1);
  }
  notify();
  bridge
    .call('term.run', { cwd, command: cmd })
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
