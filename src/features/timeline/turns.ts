import type { TimelineItem } from '@shared/protocol';
import { changedSince, type ItemsRevision } from '@/state/revision';

/**
 * Turn structure for the conversation: which root items belong to which turn, how each segment
 * reads, and what folds away as the work behind it. Pure and string-driven, so the view
 * recomputes it only when the shape of the timeline changes, never on a streamed word.
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
 *   g  a widget (generative UI): never folded, shown in its place
 *   Z  an until loop's end line: closes a turn left open (an interrupted one), stands on its own
 *   x  a check of a turn by the other agent: never part of a turn, shown under the turn it checks
 *   .  nothing to show (an empty, finished text)
 */

/**
 * One piece of a segment as it reads, in order:
 * - `text`: something the agent said (a report along the way, the reply to a steered message, the answer): always in view;
 * - `show`: command output, a widget or a plan: always in view;
 * - `steps`: a run of work between them (tool calls, thinking, task updates, notices): folded
 *   behind the work line, opened all at once by it;
 * - `line`: where the work line stands (the live line while the agent works, the summary after).
 */
export type FlowChunk = { kind: 'text'; id: string } | { kind: 'show'; id: string } | { kind: 'steps'; key: string; ids: string[]; count: number } | { kind: 'line' };

/** The work line's place in a flow (one shared object, so a flow can be searched by identity). */
export const LINE: FlowChunk = { kind: 'line' };

export interface Segment {
  key: string;
  /** The message that opened this segment (the turn's own message, or one steered into it). */
  lead: string | null;
  steered: boolean;
  /** Everything folded behind the work line, in order (the ids of the `steps` chunks). */
  work: string[];
  /**
   * The segment as it reads. The line stands before the first run of steps, and at the end while
   * there is none yet, so it never moves once placed: what the agent says before its first step
   * sits above it, everything after below it. A steered segment keeps its reply above the line:
   * there the line waits for the first text.
   */
  flow: FlowChunk[];
  /** Tool calls in `work` (thinking, task updates and notices are not steps). */
  steps: number;
  /** The last thing said in this segment: it reads at full strength. */
  answer: string | null;
  /** A steered segment's first words, when more followed: the direct reply, at full strength too. */
  reply: string | null;
  /** Error notices, and notices that are all a segment holds: never folded, after the flow. */
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

/**
 * The shape of a session's roots (one `shapeOf` character per root), followed write by write: a
 * write re-reads only the items it changed (`changedSince`), roots that grew at their end add their
 * new characters, and anything else (a new timeline, a removed root, a write it did not see) reads
 * every root again. The result is always the string `roots.map((id) => shapeOf(items[id])).join('')`.
 */
export function shapeIndex() {
  let ids: readonly string[] = [];
  let items: object | null = null;
  let rev = -1;
  let chars: string[] = [];
  let pos = new Map<string, number>();
  let out = '';
  return (d: (ItemsRevision & { items: Record<string, TimelineItem | undefined> }) | undefined, roots: readonly string[]): string => {
    if (!d) {
      items = null;
      return '';
    }
    if (d.items === items && d.rev === rev && roots === ids) return out;
    const changed = d.items === items ? changedSince(d, rev) : null;
    const n = ids.length;
    // Roots change only by joining at the end or leaving: the old last root still in its place
    // means nothing before it left (as `grow` in the Agents tab reads it).
    const grew = roots === ids || (roots.length >= n && (n === 0 || (roots[0] === ids[0] && roots[n - 1] === ids[n - 1])));
    if (!changed || !grew) {
      chars = new Array<string>(roots.length);
      pos = new Map();
      for (let i = 0; i < roots.length; i++) {
        chars[i] = shapeOf(d.items[roots[i]]);
        pos.set(roots[i], i);
      }
      out = chars.join('');
    } else {
      let edited = false;
      for (const id of changed) {
        const i = pos.get(id);
        if (i === undefined) continue;
        const c = shapeOf(d.items[id]);
        if (c === chars[i]) continue;
        chars[i] = c;
        edited = true;
      }
      let tail = '';
      for (let i = n; i < roots.length; i++) {
        const c = shapeOf(d.items[roots[i]]);
        chars.push(c);
        pos.set(roots[i], i);
        tail += c;
      }
      if (edited) out = chars.join('');
      else if (tail) out += tail;
    }
    items = d.items;
    rev = d.rev;
    ids = roots;
    return out;
  };
}

const ANSWER = new Set(['t', 'c', 'p']);
/** Always in view, in their place: command output, widgets, plans. */
const SHOW = new Set(['c', 'g', 'p']);

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
    // While the segment runs, a text the agent has gone on from is a report along the way: it is
    // the answer only while nothing has come after it.
    if (live && seg.chars[i] !== '.' && seg.chars[i] !== 'i' && seg.chars[i] !== 'e') break;
  }
  // A failed segment answers with its error card; its last text is one more report.
  if (failed) answerAt = -1;
  // Nothing but notices (a /compact, a model change on its own): they are the turn, so they show.
  const lone = !seg.chars.some((c) => c !== 'n' && c !== '.' && c !== 'i' && c !== 'e');
  let replyAt = -1;
  if (seg.steered) {
    const first = seg.chars.indexOf('t');
    if (first >= 0 && first !== answerAt) replyAt = first;
  }
  const flow: FlowChunk[] = [];
  const work: string[] = [];
  let steps = 0;
  let lined = false;
  // A steered segment's line waits for the reply: the question, its answer, then the work.
  let ready = !seg.steered;
  let run: string[] = [];
  let runCount = 0;
  const flush = () => {
    if (!run.length) return;
    if (!lined && ready) {
      flow.push(LINE);
      lined = true;
    }
    flow.push({ kind: 'steps', key: run[0], ids: run, count: runCount });
    run = [];
    runCount = 0;
  };
  for (let i = 0; i < seg.chars.length; i++) {
    const ch = seg.chars[i];
    const id = seg.ids[i];
    if (ch === '.' || ch === 'i') continue;
    if (ch === 'e' || (lone && ch === 'n')) {
      errors.push(id);
      continue;
    }
    if (ch === 't' || SHOW.has(ch)) {
      flush();
      flow.push({ kind: ch === 't' ? 'text' : 'show', id });
      if (ch === 't') ready = true;
      continue;
    }
    work.push(id);
    run.push(id);
    if (ch === 'w') {
      steps++;
      runCount++;
    }
  }
  flush();
  // No run after the place the line waits for (yet): it stands at the end.
  if (!lined && (live || work.length)) flow.push(LINE);
  return {
    key: seg.lead ?? `${turnKey}:${index}`,
    lead: seg.lead,
    steered: seg.steered,
    work,
    flow,
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
 * `checkOf`: the turn a check (`x`) belongs to (its first message); a check goes under that turn,
 * wherever it sits in the timeline, or stands on its own where it is when that turn is gone.
 */
export function groupTurns(ids: readonly string[], shape: string, busy: boolean, checkOf?: (id: string) => string | undefined): TurnLayout {
  const g: Grouping = { groups: [], queued: [], checks: [] };
  groupFrom(g, ids, shape, busy, 0);
  return { groups: withChecks(g.groups, g.checks, checkOf), queued: g.queued };
}

/** What grouping has gathered so far; a check's `at` is how many groups stood before it. */
interface Grouping {
  groups: Group[];
  queued: string[];
  checks: { id: string; at: number }[];
}

/** A sent message with nothing open before it: everything grouped before it is final (see `turnsIndex`). */
interface Cut {
  at: number;
  groups: number;
  queued: number;
  checks: number;
}

/**
 * Groups `ids[from..]` onto `g`, which holds the grouping of `ids[..from)` with nothing open at
 * `from` (so `from` is 0 or a cut). Notes each sent message in `cuts`, with what stood before it.
 */
function groupFrom(g: Grouping, ids: readonly string[], shape: string, busy: boolean, from: number, cuts?: Cut[]) {
  const { groups, queued, checks } = g;
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

  for (let i = from; i < ids.length; i++) {
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
      // Nothing is open here and nothing after this point reaches back before it (an "Interrupted"
      // only joins a turn closed right before it, and this message opens one).
      if (ch === 'U') cuts?.push({ at: i, groups: groups.length, queued: queued.length, checks: checks.length });
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
}

/**
 * The groups with their checks: under the turn each checks (a copy of that turn, so the groups
 * passed in are left as they are), or on their own where they stand when that turn is gone.
 */
function withChecks(groups: Group[], checks: Grouping['checks'], checkOf?: (id: string) => string | undefined): Group[] {
  const out = groups.slice();
  if (!checks.length) return out;
  const turns = new Map<string, number>();
  for (let i = 0; i < out.length; i++) if (out[i].kind === 'turn') turns.set(out[i].key, i);
  const loose: { id: string; at: number }[] = [];
  for (const c of checks) {
    const at = turns.get(checkOf?.(c.id) ?? '');
    if (at === undefined) {
      loose.push(c);
      continue;
    }
    const turn = out[at] as TurnGroup;
    out[at] = { ...turn, checks: [...(turn.checks ?? []), c.id] };
  }
  // From the end, so the places counted before stay right.
  for (let i = loose.length - 1; i >= 0; i--) out.splice(loose[i].at, 0, { kind: 'item', key: loose[i].id, id: loose[i].id });
  return out;
}

/**
 * `groupTurns`, followed run by run (one per TurnList): the groups before the last sent message
 * that the timeline has not changed since the last run are kept as they are (the same objects),
 * and only what follows it is grouped again. A step joining a running turn regroups that turn,
 * not the whole conversation. Always equal to `groupTurns` of the same arguments.
 */
export function turnsIndex() {
  let ids: readonly string[] = [];
  let shape = '';
  let g: Grouping = { groups: [], queued: [], checks: [] };
  let cuts: Cut[] = [];
  return (nextIds: readonly string[], nextShape: string, busy: boolean, checkOf?: (id: string) => string | undefined): TurnLayout => {
    // The first place this timeline differs from the last one grouped.
    const n = Math.min(ids.length, nextIds.length);
    let d = 0;
    while (d < n && ids[d] === nextIds[d] && (shape[d] ?? '.') === (nextShape[d] ?? '.')) d++;
    // The last cut before it: grouping starts again there (the cut itself is noted again).
    let k = cuts.length - 1;
    while (k >= 0 && cuts[k].at >= d) k--;
    if (k >= 0) {
      const cut = cuts[k];
      g.groups.length = cut.groups;
      g.queued.length = cut.queued;
      g.checks.length = cut.checks;
      cuts.length = k;
      groupFrom(g, nextIds, nextShape, busy, cut.at, cuts);
    } else {
      g = { groups: [], queued: [], checks: [] };
      cuts = [];
      groupFrom(g, nextIds, nextShape, busy, 0, cuts);
    }
    ids = nextIds;
    shape = nextShape;
    return { groups: withChecks(g.groups, g.checks, checkOf), queued: g.queued.slice() };
  };
}
