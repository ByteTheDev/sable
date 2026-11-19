import type { TimelineItem } from '@shared/protocol';

/**
 * Turn structure for the conversation: which root items belong to which turn, which text is
 * a segment's answer, and what folds away as the work behind it. Pure and string-driven, so
 * the view recomputes it only when the shape of the timeline changes, never on a streamed word.
 *
 * Each root item is reduced to one character (`shapeOf`):
 *   U  a sent message that starts a turn       Q  a queued message, not taken yet (floats to the end)
 *   S  a message steered into the running turn  t  assistant prose (an answer candidate)
 *   c  command output (an answer candidate)     p  a plan (an answer candidate)
 *   w  a step: a tool call                      n  any other notice (mode, model, compaction, retry): not a step
 *   h  thinking: part of the work, not counted as a step
 *   k  a task list update: kept in the work, not counted as a step (the dock shows the list)
 *   i  "Interrupted"                            e  an error notice
 *   T  turn end                                 F  turn end with an error
 *   g  a widget (generative UI): never folded, shown with the answer
 *   Z  an until loop's end line: closes a turn left open (an interrupted one), stands on its own
 *   x  a check of a turn by the other agent: never part of a turn, shown under the turn it checks
 *   .  nothing to show (an empty, finished text)
 */

export type StoryChunk = { kind: 'text'; id: string } | { kind: 'steps'; key: string; ids: string[]; count: number };

export interface Segment {
  key: string;
  /** The message that opened this segment (the turn's own message, or one steered into it). */
  lead: string | null;
  steered: boolean;
  /** Everything folded behind the work line, in order. */
  work: string[];
  /** The work as a story: intermediate texts, and the runs of steps between them. */
  story: StoryChunk[];
  /** Tool calls and thinking in `work`. */
  steps: number;
  /** The last thing said in this segment: shown in full under the work line. */
  answer: string | null;
  /**
   * A steered segment's first words, when more followed: the direct reply to the message that
   * was steered in, kept in view right under it (before the work line).
   */
  reply: string | null;
  /** Error notices, and notices that are all a segment holds: never folded. */
  errors: string[];
  /**
   * What shows under the work line, in order: the answer, every widget, and the text that leads
   * into a widget ("Here is the chart:"). Just `[answer]` when there are no widgets.
   */
  shown: string[];
}

export type TurnState = 'running' | 'done' | 'failed' | 'interrupted';

export interface TurnGroup {
  kind: 'turn';
  key: string;
  segments: Segment[];
  /** The closing turn item, when the provider wrote one. */
  end: string | null;
  state: TurnState;
  /** Every root id in the turn, in order (for copy, previews and reveal). */
  ids: string[];
  /** Checks of this turn by the other agent ("Check with Codex"), shown under it, oldest first. */
  checks?: string[];
}

export interface ItemGroup {
  kind: 'item';
  key: string;
  id: string;
}

export type Group = TurnGroup | ItemGroup;

export interface TurnLayout {
  groups: Group[];
  /** Queued messages, shown after everything else until the agent takes them. */
  queued: string[];
}

export function shapeOf(item: TimelineItem | undefined): string {
  if (!item) return '.';
  switch (item.type) {
    case 'user':
      if (item.steered) return 'S';
      return item.state === 'queued' ? 'Q' : 'U';
    case 'text':
      return item.streaming || item.text.trim() ? 't' : '.';
    case 'thinking':
      return 'h';
    case 'tool':
      if (item.check) return 'x';
      return item.kind === 'plan' ? 'p' : item.kind === 'widget' ? 'g' : item.kind === 'todo' ? 'k' : 'w';
    case 'notice':
      if (item.until) return 'Z';
      if (item.variant === 'interrupted') return 'i';
      if (item.variant === 'error') return 'e';
      if (item.variant === 'command') return 'c';
      return 'n';
    case 'turn':
      return item.error ? 'F' : 'T';
    default:
      return '.';
  }
}

const ANSWER = new Set(['t', 'c', 'p']);
/** What counts as a step in the turn's line: tool calls and plans. A notice is never a step. */
const STEP = new Set(['w', 'p']);

interface Open {
  ids: string[];
  chars: string[];
  segs: { lead: string | null; steered: boolean; ids: string[]; chars: string[] }[];
  interrupted: boolean;
  failed: boolean;
}

function buildSegment(seg: Open['segs'][number], index: number, turnKey: string, failed: boolean, live = false): Segment {
  const errors: string[] = [];
  let answerAt = -1;
  for (let i = seg.chars.length - 1; i >= 0; i--) {
    if (ANSWER.has(seg.chars[i])) {
      answerAt = i;
      break;
    }
    // While the segment runs, a text the agent has gone on from is part of the story, in order:
    // it is the answer only while nothing has come after it.
    if (live && seg.chars[i] !== '.' && seg.chars[i] !== 'i' && seg.chars[i] !== 'e') break;
  }
  // A failed segment answers with its error card; its last text becomes part of the story.
  if (failed) answerAt = -1;
  // Nothing but notices (a /compact, a model change on its own): they are the turn, so they show.
  const lone = !seg.chars.some((c) => c !== 'n' && c !== '.' && c !== 'i' && c !== 'e');
  let replyAt = -1;
  if (seg.steered) {
    const first = seg.chars.findIndex((c) => c === 't');
    if (first >= 0 && first !== answerAt) replyAt = first;
  }
  // Widgets are never folded away, and neither is the text that leads into one.
  const shownAt = new Set<number>();
  if (answerAt >= 0) shownAt.add(answerAt);
  for (let i = 0; i < seg.chars.length; i++) {
    if (seg.chars[i] !== 'g') continue;
    shownAt.add(i);
    let j = i - 1;
    while (j >= 0 && seg.chars[j] === '.') j--;
    if (j >= 0 && seg.chars[j] === 't' && j !== replyAt) shownAt.add(j);
  }
  const shown: string[] = [];
  const work: string[] = [];
  const story: StoryChunk[] = [];
  let steps = 0;
  let run: string[] = [];
  let runCount = 0;
  const flush = () => {
    if (run.length) story.push({ kind: 'steps', key: run[0], ids: run, count: runCount });
    run = [];
    runCount = 0;
  };
  for (let i = 0; i < seg.chars.length; i++) {
    const ch = seg.chars[i];
    const id = seg.ids[i];
    if (i === replyAt || ch === '.' || ch === 'i') continue;
    if (shownAt.has(i)) {
      shown.push(id);
      continue;
    }
    if (ch === 'e' || (lone && ch === 'n')) {
      errors.push(id);
      continue;
    }
    work.push(id);
    if (ch === 't' || ch === 'c') {
      flush();
      story.push({ kind: 'text', id });
      continue;
    }
    run.push(id);
    if (STEP.has(ch)) {
      steps++;
      runCount++;
    }
  }
  flush();
  return {
    key: seg.lead ?? `${turnKey}:${index}`,
    lead: seg.lead,
    steered: seg.steered,
    work,
    story,
    steps,
    answer: answerAt >= 0 ? seg.ids[answerAt] : null,
    reply: replyAt >= 0 ? seg.ids[replyAt] : null,
    errors,
    shown,
  };
}

/**
 * Groups root items into turns. A turn runs from a sent message to its closing turn item; when
 * there is none (an interrupted turn, history from a provider that keeps no turn records), the
 * next sent message closes it. Messages steered into a turn split it into segments, each with
 * its own answer, so a question asked mid-turn gets its reply right under it. Items outside any
 * turn (notices between turns, anything before the first message) stay single items.
 * `busy`: the session is working, so a turn left open at the end is the running one.
 * `checkOf`: the turn a check (`x`) belongs to (its first message); a check goes under that turn,
 * wherever it sits in the timeline, or stands on its own where it is when that turn is gone.
 */
export function groupTurns(ids: readonly string[], shape: string, busy: boolean, checkOf?: (id: string) => string | undefined): TurnLayout {
  const groups: Group[] = [];
  const queued: string[] = [];
  const checks: { id: string; at: number }[] = [];
  let open: Open | null = null;

  const close = (end: string | null, failedEnd: boolean, atEnd: boolean) => {
    if (!open) return;
    const o = open;
    open = null;
    if (end) o.ids.push(end);
    const failed = failedEnd || o.failed;
    const state: TurnState = atEnd && !end && busy && !o.interrupted ? 'running' : failed ? 'failed' : o.interrupted ? 'interrupted' : 'done';
    const key = o.ids[0];
    const last = o.segs.length - 1;
    const segments = o.segs.map((s, i) => buildSegment(s, i, key, failed && i === last, state === 'running' && i === last));
    groups.push({ kind: 'turn', key, segments, end, state, ids: o.ids });
  };

  const start = (id: string, steered: boolean) => {
    open = { ids: [id], chars: [], segs: [{ lead: id, steered, ids: [], chars: [] }], interrupted: false, failed: false };
  };

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const ch = shape[i] ?? '.';
    if (ch === 'Q') {
      queued.push(id);
      continue;
    }
    // A check runs beside the conversation: it never joins (or ends) the turn around it.
    if (ch === 'x') {
      checks.push({ id, at: groups.length });
      continue;
    }
    if (ch === 'U' || (ch === 'S' && !open)) {
      close(null, false, false);
      start(id, ch === 'S');
      continue;
    }
    if (ch === 'Z') {
      close(null, false, false);
      groups.push({ kind: 'item', key: id, id });
      continue;
    }
    if (ch === 'T' || ch === 'F') {
      if (open) close(id, ch === 'F', false);
      else groups.push({ kind: 'item', key: id, id });
      continue;
    }
    if (!open) {
      const prev = groups[groups.length - 1];
      // Some providers write "Interrupted" after the turn record: it still belongs to that turn.
      if (ch === 'i' && prev?.kind === 'turn' && prev.state !== 'running') {
        prev.state = prev.state === 'failed' ? 'failed' : 'interrupted';
        prev.ids.push(id);
        continue;
      }
      groups.push({ kind: 'item', key: id, id });
      continue;
    }
    // An interrupted turn has ended even without its record: a notice after it (a lane landed, a
    // model changed) stands on its own instead of folding into that turn's work and its time.
    if (ch === 'n' && (open as Open).interrupted) {
      close(null, false, false);
      groups.push({ kind: 'item', key: id, id });
      continue;
    }
    const o: Open = open;
    o.ids.push(id);
    if (ch === 'S') {
      o.segs.push({ lead: id, steered: true, ids: [], chars: [] });
      continue;
    }
    const seg = o.segs[o.segs.length - 1];
    seg.ids.push(id);
    seg.chars.push(ch);
    if (ch === 'i') o.interrupted = true;
    else if (ch === 'e') o.failed = true;
    // The agent recovered and went on to say something: the error was not the end.
    else if (ANSWER.has(ch)) o.failed = false;
  }
  close(null, false, true);
  if (checks.length) {
    const turns = new Map<string, TurnGroup>();
    for (const g of groups) if (g.kind === 'turn') turns.set(g.key, g);
    const loose: { id: string; at: number }[] = [];
    for (const c of checks) {
      const turn = turns.get(checkOf?.(c.id) ?? '');
      if (turn) (turn.checks ??= []).push(c.id);
      else loose.push(c);
    }
    // From the end, so the places counted before stay right.
    for (let i = loose.length - 1; i >= 0; i--) groups.splice(loose[i].at, 0, { kind: 'item', key: loose[i].id, id: loose[i].id });
  }
  return { groups, queued };
}
