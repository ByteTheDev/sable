import type { TimelineItem } from '@shared/protocol';

/**
 * A conversation as turns: your message, the agent's steps (folded to one line), its sub-agents
 * and workflows as blocks, notices, and its answer (the text after its last step).
 */
export interface Turn {
  /** The user item that opened it (absent for anything before the first message). */
  user?: string;
  /** Tool calls, thinking and in-between text, in order: what folds away. */
  steps: string[];
  /** Sub-agents, workflows and widgets: shown as compact blocks. */
  blocks: string[];
  notices: string[];
  /** Text after the last step. */
  answer: string[];
  /** The closing turn item, once it ended. */
  end?: string;
  /** Messages steered into this turn while it ran. */
  steered: string[];
  /** Where a `/until` loop ended: under the answer. */
  ends: string[];
}

const BLOCK_KINDS = new Set(['agent', 'widget']);

/** Builds turns from the root items. Depends only on order and item types, so it is recomputed only when those change. */
export function buildTurns(roots: string[], items: Record<string, TimelineItem>): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | undefined;
  const open = (user?: string) => {
    cur = { user, steps: [], blocks: [], notices: [], answer: [], steered: [], ends: [] };
    turns.push(cur);
    return cur;
  };
  for (const id of roots) {
    const it = items[id];
    if (!it) continue;
    if (it.type === 'user') {
      // A message steered into a running turn stays inside it.
      if (it.steered && cur && !cur.end) {
        cur.steered.push(id);
        // What it said before the steer is no longer the answer.
        cur.steps.push(...cur.answer);
        cur.answer = [];
        continue;
      }
      open(id);
      continue;
    }
    const t = cur ?? open();
    switch (it.type) {
      case 'text':
        t.answer.push(id);
        break;
      case 'thinking':
        t.steps.push(...t.answer, id);
        t.answer = [];
        break;
      case 'tool':
        t.steps.push(...t.answer);
        t.answer = [];
        if (BLOCK_KINDS.has(it.kind) || it.workflow || it.name === 'Workflow') t.blocks.push(id);
        else t.steps.push(id);
        break;
      case 'notice':
        (it.until ? t.ends : t.notices).push(id);
        break;
      case 'turn':
        t.end = id;
        break;
    }
  }
  return turns;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Keeps the previous object of every turn that did not change (its row then does not render again). */
export function reuseTurns(next: Turn[], prev: Turn[]): Turn[] {
  if (!prev.length) return next;
  const old = new Map<string, Turn>();
  for (const t of prev) if (t.user) old.set(t.user, t);
  return next.map((t) => {
    const o = t.user ? old.get(t.user) : prev[0]?.user ? undefined : prev[0];
    return o && o.end === t.end && same(o.steps, t.steps) && same(o.blocks, t.blocks) && same(o.notices, t.notices) && same(o.answer, t.answer) && same(o.steered, t.steered) && same(o.ends, t.ends) ? o : t;
  });
}

/** A string that changes only when the turn structure would: order and types of the roots. */
export function shapeKey(roots: string[], items: Record<string, TimelineItem>): string {
  let s = '';
  for (const id of roots) {
    const it = items[id];
    if (!it) continue;
    s += it.type === 'tool' ? (it.workflow || BLOCK_KINDS.has(it.kind) ? 'B' : 'T') : it.type === 'user' ? (it.steered ? 'S' : 'U') : it.type[0];
    s += id.length;
  }
  return `${roots.length}:${roots[roots.length - 1] ?? ''}:${s}`;
}
