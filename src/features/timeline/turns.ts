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
 *   w  a step: a tool call or thinking          n  any other notice (mode, model, compaction, retry)
 *   i  "Interrupted"                            e  an error notice
 *   T  turn end                                 F  turn end with an error
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
  /** Error notices: never folded. */
  errors: string[];
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
      return 'w';
    case 'tool':
      return item.kind === 'plan' ? 'p' : 'w';
    case 'notice':
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
const STEP = new Set(['w', 'p', 'n']);

interface Open {
  ids: string[];
  chars: string[];
  segs: { lead: string | null; steered: boolean; ids: string[]; chars: string[] }[];
  interrupted: boolean;
  failed: boolean;
}

function buildSegment(seg: Open['segs'][number], index: number, turnKey: string, failed: boolean): Segment {
  const errors: string[] = [];
  let answerAt = -1;
  for (let i = seg.chars.length - 1; i >= 0; i--) {
    if (ANSWER.has(seg.chars[i])) {
      answerAt = i;
      break;
    }
  }
  // A failed segment answers with its error card; its last text becomes part of the story.
  if (failed) answerAt = -1;
  let replyAt = -1;
  if (seg.steered) {
    const first = seg.chars.findIndex((c) => c === 't');
    if (first >= 0 && first !== answerAt) replyAt = first;
  }
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
    if (i === answerAt || i === replyAt || ch === '.' || ch === 'i') continue;
    if (ch === 'e') {
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
  };
}

/**
 * Groups root items into turns. A turn runs from a sent message to its closing turn item; when
 * there is none (an interrupted turn, history from a provider that keeps no turn records), the
 * next sent message closes it. Messages steered into a turn split it into segments, each with
 * its own answer, so a question asked mid-turn gets its reply right under it. Items outside any
 * turn (notices between turns, anything before the first message) stay single items.
 * `busy`: the session is working, so a turn left open at the end is the running one.
 */
export function groupTurns(ids: readonly string[], shape: string, busy: boolean): TurnLayout {
  const groups: Group[] = [];
  const queued: string[] = [];
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
    const segments = o.segs.map((s, i) => buildSegment(s, i, key, failed && i === last));
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
    if (ch === 'U' || (ch === 'S' && !open)) {
      close(null, false, false);
      start(id, ch === 'S');
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
  return { groups, queued };
}
