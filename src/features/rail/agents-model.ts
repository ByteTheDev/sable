import type { TimelineItem, ToolItem, WorkflowRun } from '@shared/protocol';
import { isAgentLive, workflowGlance } from '@/features/timeline/agent-line';

/**
 * What the Agents tab reads from a session, worked out so that a streamed step costs next to
 * nothing: every index below remembers the arrays it last saw (the store replaces an array only
 * when an item joins it) and scans only what joined since. Pure, so it is tested without a page.
 */

type Items = Record<string, TimelineItem | undefined>;

export interface Timeline {
  items: Items;
  roots: readonly string[];
  children: Record<string, readonly string[] | undefined>;
}

const NONE: readonly string[] = [];

/** Matches found in one list (the roots, or one item's children). */
interface Scan<T> {
  arr: readonly string[];
  found: readonly T[];
}

/**
 * The matches in `arr`, reusing `prev` when the list only grew at its end (the usual case: an item
 * joined). The found array keeps its identity while nothing new matched.
 */
export function grow<T>(prev: Scan<T> | undefined, arr: readonly string[], pick: (id: string) => T | undefined): Scan<T> {
  if (prev?.arr === arr) return prev;
  const n = prev?.arr.length ?? 0;
  const appended = !!prev && n > 0 && arr.length >= n && arr[0] === prev.arr[0] && arr[n - 1] === prev.arr[n - 1];
  let found: T[] | readonly T[] = appended ? prev.found : [];
  let copied = !appended;
  for (let i = appended ? n : 0; i < arr.length; i++) {
    const v = pick(arr[i]);
    if (v === undefined) continue;
    if (!copied) {
      found = found.slice();
      copied = true;
    }
    (found as T[]).push(v);
  }
  return { arr, found };
}

const isAgentItem = (it: TimelineItem | undefined): it is ToolItem => it?.type === 'tool' && it.kind === 'agent';

/**
 * Every sub-agent and workflow of a session (top level and nested under another agent), oldest
 * first. Returns the same array until one joins or leaves; a streamed word or a new step of an
 * agent costs one identity check, a new step one more look at that step.
 */
export function agentIndex(): (t: Timeline | undefined) => readonly string[] {
  const scans = new Map<string, Scan<string>>();
  let roots: unknown = null;
  let children: unknown = null;
  let out: readonly string[] = NONE;
  return (t) => {
    if (!t) return NONE;
    if (t.roots === roots && t.children === children) return out;
    roots = t.roots;
    children = t.children;
    const ids: string[] = [];
    const pick = (id: string) => (isAgentItem(t.items[id]) ? id : undefined);
    const visit = (key: string, arr: readonly string[] | undefined, depth: number) => {
      if (!arr?.length || depth > 8) return;
      const scan = grow(scans.get(key), arr, pick);
      scans.set(key, scan);
      for (const id of scan.found) {
        ids.push(id);
        visit(id, t.children[id], depth + 1);
      }
    };
    visit('', t.roots, 0);
    if (ids.length > 1) ids.sort((a, b) => (t.items[a]?.ts ?? 0) - (t.items[b]?.ts ?? 0));
    if (ids.length === out.length && ids.every((id, i) => id === out[i])) return out;
    out = ids.length ? ids : NONE;
    return out;
  };
}

/** The ids of the person's messages, in order: the same array until one is added. */
export function userIndex(): (t: Timeline | undefined) => readonly string[] {
  let scan: Scan<string> | undefined;
  return (t) => {
    if (!t) return NONE;
    scan = grow(scan, t.roots, (id) => (t.items[id]?.type === 'user' ? id : undefined));
    return scan.found;
  };
}

/** One character per agent, `1` while it works: the list's sections follow it, nothing else. */
export function liveKey(items: Items | undefined, ids: readonly string[]): string {
  let k = '';
  for (const id of ids) k += isAgentLive(items?.[id] as ToolItem | undefined) ? '1' : '0';
  return k;
}

// ── a working sub-agent ──

interface Kids {
  arr: readonly string[];
  tools: number;
  /** The latest task-list step (TodoWrite) under it, if any. */
  todo: string;
}

function scanKids(prev: Kids | undefined, arr: readonly string[], items: Items): Kids {
  if (prev?.arr === arr) return prev;
  const n = prev?.arr.length ?? 0;
  const appended = !!prev && n > 0 && arr.length >= n && arr[0] === prev.arr[0] && arr[n - 1] === prev.arr[n - 1];
  let tools = appended ? prev.tools : 0;
  let todo = appended ? prev.todo : '';
  for (let i = appended ? n : 0; i < arr.length; i++) {
    const it = items[arr[i]];
    if (it?.type !== 'tool') continue;
    tools++;
    if (it.kind === 'todo') todo = arr[i];
  }
  return { arr, tools, todo };
}

export interface Progress {
  steps: number;
  /** What it does now: the latest step's title, "Thinking", or "Writing the report". */
  now: string;
  /** Its own task list, when it keeps one: the only honest measure of how far it is. */
  todo?: { done: number; total: number };
  /** Its latest step waits for the person's approval. */
  waiting?: boolean;
}

const SEP = '\u0001';

/**
 * How far one working sub-agent is, as one string (`steps`, `now`, `done/total`): its card renders
 * when that string changes, never on a streamed word. Counting is incremental.
 */
export function progressIndex(): (items: Items | undefined, kids: readonly string[] | undefined) => string {
  let scan: Kids | undefined;
  return (items, kids) => {
    if (!items || !kids?.length) return `0${SEP}${SEP}${SEP}`;
    scan = scanKids(scan, kids, items);
    const last = items[kids[kids.length - 1]];
    const now = !last ? '' : last.type === 'tool' ? last.title : last.type === 'thinking' ? 'Thinking' : last.type === 'text' ? 'Writing the report' : '';
    const todos = scan.todo ? (items[scan.todo] as ToolItem | undefined)?.detail.todos : undefined;
    const todo = todos?.length ? `${todos.filter((t) => t.status === 'completed').length}/${todos.length}` : '';
    const waiting = last?.type === 'tool' && last.status === 'awaiting' ? 'w' : '';
    return `${scan.tools}${SEP}${now}${SEP}${todo}${SEP}${waiting}`;
  };
}

export function readProgress(key: string): Progress {
  const [steps, now, todo, waiting] = key.split(SEP);
  const out: Progress = { steps: Number(steps) || 0, now: now ?? '' };
  if (todo) {
    const [done, total] = todo.split('/').map(Number);
    out.todo = { done, total };
  }
  if (waiting) out.waiting = true;
  return out;
}

/** The ids of its latest `n` steps, oldest first, as one string. */
export function latestSteps(items: Items | undefined, kids: readonly string[] | undefined, n: number): string {
  if (!items || !kids?.length) return '';
  const out: string[] = [];
  for (let i = kids.length - 1; i >= 0 && out.length < n; i--) if (items[kids[i]]?.type === 'tool') out.push(kids[i]);
  return out.reverse().join(',');
}

/** How many steps it took, counted under it (for agents that gave no count of their own). */
export function stepCount(items: Items | undefined, kids: readonly string[] | undefined): number {
  if (!items || !kids) return 0;
  let n = 0;
  for (const k of kids) if (items[k]?.type === 'tool') n++;
  return n;
}

// ── a working workflow ──

export interface WorkflowNow {
  /** "Phase 2 of 3", or '' with one phase. */
  phase: string;
  /** The title of the phase that runs now. */
  title: string;
  /** What one of its working agents does now. */
  doing: string;
  /** Agents finished of agents started. */
  done: number;
  agents: number;
}

export function workflowNow(run: WorkflowRun): WorkflowNow {
  const g = workflowGlance(run);
  let doing = '';
  for (let i = run.agents.length - 1; i >= 0; i--) {
    const a = run.agents[i];
    if (a.state === 'running' && a.activity) {
      doing = a.activity;
      break;
    }
  }
  if (!doing && g.running) doing = `${g.running} ${g.running === 1 ? 'agent' : 'agents'} working`;
  if (!doing && run.limitWait) doing = 'Waiting for a plan limit';
  return { phase: g.phases > 1 && g.phase > 0 ? `Phase ${g.phase} of ${g.phases}` : '', title: g.current ?? '', doing, done: g.done + g.failed, agents: g.agents };
}

// ── a finished agent ──

export type Outcome = 'done' | 'failed' | 'stopped' | 'interrupted' | 'denied' | 'unknown';

/** How it ended. "unknown": sent to the background and never heard from again. */
export function outcomeOf(item: ToolItem): Outcome {
  const stats = item.result?.agent;
  if (stats?.limit) return 'stopped';
  if (item.workflow) {
    if (item.status === 'error' || item.workflow.status === 'failed') return 'failed';
    if (item.status === 'cancelled' || item.status === 'denied') return 'interrupted';
    if (item.workflow.status === 'stopped') return 'stopped';
    return 'done';
  }
  if (item.status === 'error' || stats?.background === 'failed') return 'failed';
  if (item.status === 'denied') return 'denied';
  if (item.status === 'cancelled') return 'interrupted';
  if (stats?.background === 'stopped') return 'stopped';
  if (!stats?.background && item.detail.background) return 'unknown';
  return 'done';
}

export const OUTCOME_WORD: Record<Outcome, string> = {
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
  denied: 'Denied',
  unknown: 'In the background',
};

export interface Figures {
  /** Its own working time, 0 when unknown. */
  ms: number;
  tokens: number;
  /** Steps as the agent counted them, when it did. */
  steps?: number;
  /** A workflow's agents, and how many of them failed. */
  agents?: number;
  failed?: number;
}

export function figuresOf(item: ToolItem): Figures {
  const run = item.workflow;
  if (run) {
    const g = workflowGlance(run);
    return { ms: run.durationMs ?? 0, tokens: run.tokens ?? 0, steps: run.steps, agents: g.agents, failed: g.failed };
  }
  const stats = item.result?.agent;
  // A background agent's call returns at once: only its own figure says how long it worked.
  const launched = !!stats?.background || !!item.detail.background;
  const ms = stats?.durationMs ?? (launched || !item.endedAt ? 0 : Math.max(0, item.endedAt - item.ts - (item.waitedMs ?? 0)));
  return { ms, tokens: stats?.tokens ?? 0, steps: stats?.steps };
}

// ── grouping ──

export interface Group {
  /** The message whose turn started them ('' before the first message). */
  user: string;
  /** Newest first. */
  ids: string[];
}

/**
 * Finished agents under the message whose turn started them (the latest message sent before the
 * agent), newest message first, newest agent first within it. `ids` and `users` come oldest first.
 */
export function groupDone(ids: readonly string[], items: Items, users: readonly string[]): Group[] {
  const ts = users.map((u) => items[u]?.ts ?? 0);
  const byUser = new Map<string, string[]>();
  for (const id of ids) {
    const t = items[id]?.ts ?? 0;
    // The last message at or before the agent's start (binary search: messages are in order).
    let lo = 0;
    let hi = ts.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= t) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const key = at >= 0 ? users[at] : '';
    const list = byUser.get(key);
    if (list) list.push(id);
    else byUser.set(key, [id]);
  }
  const order = (u: string) => (u ? (items[u]?.ts ?? 0) : -1);
  return [...byUser]
    .map(([user, list]) => ({ user, ids: list.reverse() }))
    .sort((a, b) => order(b.user) - order(a.user));
}

/** The first line of a message, short enough for a heading. */
export function promptLine(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > 90 ? line.slice(0, 89).trimEnd() + '…' : line || 'Message';
}
