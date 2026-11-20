/**
 * The phone's copy of the turn grouping (mobile/src/lib/turns.ts) reads a conversation as the
 * desktop does (src/features/timeline/turns.ts): the same cases, run against the phone's module.
 * And a review message (src/features/review/model.ts) reads back on the phone as on the desktop,
 * also when the phone got it cut short (mobile/src/lib/review.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@shared/protocol';

// The phone imports the desktop's lead-in rules through its own alias.
vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));
vi.mock('@desk/features/review/model', async () => await import('../src/features/review/model'));

// Loaded by a path the root type check does not follow: the phone's module resolves `@desk` through its own config.
type FlowChunk = { kind: 'text' | 'show'; id: string } | { kind: 'steps'; key: string; ids: string[] } | { kind: 'line' };
interface Segment {
  flow: FlowChunk[];
  work: string[];
  steps: number;
  answer: string | null;
  reply: string | null;
}
type TurnGroup = { kind: 'turn'; segments: Segment[] };
type Group = TurnGroup | { kind: 'item'; id: string };
const TURNS = '../mobile/src/lib/turns';
const { groupTurns, shapeOf } = (await import(/* @vite-ignore */ TURNS)) as {
  groupTurns: (ids: readonly string[], shape: string, busy: boolean) => { groups: Group[] };
  shapeOf: (item: TimelineItem) => string;
};

function spec(s: string) {
  const parts = s.split(/\s+/).filter(Boolean);
  return { ids: parts.map((p) => p.slice(1)), shape: parts.map((p) => p[0]).join('') };
}
const flowOf = (flow: FlowChunk[]) => flow.map((c) => (c.kind === 'line' ? '|' : c.kind === 'steps' ? `[${c.ids.join(' ')}]` : c.kind === 'show' ? `*${c.id}` : c.id)).join(' ');
const onlyTurn = (s: string, busy = false) => {
  const { ids, shape } = spec(s);
  const { groups } = groupTurns(ids, shape, busy);
  expect(groups).toHaveLength(1);
  expect(groups[0].kind).toBe('turn');
  return groups[0] as TurnGroup;
};

describe('phone turns', () => {
  it('reads an agent switch as a line of its own that closes a turn', () => {
    const base = { id: 'x', ts: 0 };
    expect(shapeOf({ ...base, type: 'notice', variant: 'info', text: 'Switched to Codex', agentSwitch: { from: 'claude', to: 'codex' } } as TimelineItem)).toBe('Z');
    const { ids, shape } = spec('U1 w2 Z3 U4 t5 T6');
    const { groups } = groupTurns(ids, shape, false);
    expect(groups.map((g) => g.kind)).toEqual(['turn', 'item', 'turn']);
  });

  it('answers a settled turn with its lead-in when nothing else was said', () => {
    const s = onlyTurn('U1 l2 w3 T4').segments[0];
    expect(s).toMatchObject({ answer: '2', work: ['3'], steps: 1 });
    expect(flowOf(s.flow)).toBe('2 | [3]');
    expect(onlyTurn('U1 l2 w3 l4 w5 T6').segments[0]).toMatchObject({ answer: '4', work: ['2', '3', '5'] });
    expect(onlyTurn('U1 l2 w3', true).segments[0]).toMatchObject({ answer: null, work: ['2', '3'] });
    expect(onlyTurn('U1 t2 l3 w4 T5').segments[0]).toMatchObject({ answer: '2', work: ['3', '4'] });
    expect(onlyTurn('U1 l2 w3 F4').segments[0].answer).toBeNull();
  });

  it('keeps the last words the answer when a notice or a task list update follows them', () => {
    const s = onlyTurn('U1 t2 w3 l4 n5 T6').segments[0];
    expect(s.answer).toBe('4');
    expect(flowOf(s.flow)).toBe('2 | [3] 4 [5]');
    expect(onlyTurn('U1 w2 l3 k4 T5').segments[0]).toMatchObject({ answer: '3', work: ['2', '4'] });
    expect(onlyTurn('U1 w2 l3 h4 n5 T6').segments[0].answer).toBe('3');
    expect(onlyTurn('U1 t2 l3 n4 w5 T6').segments[0]).toMatchObject({ answer: '2', work: ['3', '4', '5'] });
    expect(onlyTurn('U1 t2 w3 l4 n5', true).segments[0].work).toEqual(['3', '4', '5']);
  });

  it('answers a settled turn from an earlier segment when the last one said nothing', () => {
    expect(onlyTurn('U1 w2 t3 S4 w5 w6 T7').segments.map((s) => s.answer)).toEqual(['3', null]);
    expect(onlyTurn('U1 w2 t3 S4 w5 w6', true).segments.map((s) => s.answer)).toEqual([null, null]);
    expect(onlyTurn('U1 w2 t3 S4 w5 t6 T7').segments.map((s) => s.answer)).toEqual([null, '6']);
  });

  it('always shows the reply to a steered message, even when it reads as a lead-in', () => {
    const t = onlyTurn('U1 w2 S3 l4 l5 w6 t7 T8');
    expect(t.segments[1]).toMatchObject({ reply: '4', answer: '7', work: ['5', '6'] });
  });

  it('reads the low-confidence openers as reports, through the desktop rules', () => {
    const base = { id: 'x', ts: 0, type: 'text' as const, streaming: false };
    expect(shapeOf({ ...base, text: 'I should note the key is read from .env.' } as TimelineItem)).toBe('t');
    expect(shapeOf({ ...base, text: 'Looking at the logs, the guard throws before the handler runs.' } as TimelineItem)).toBe('t');
    expect(shapeOf({ ...base, text: 'Looking good, let me run the tests.' } as TimelineItem)).toBe('l');
  });
});

describe('a review message on the phone', async () => {
  const { reviewMessage } = await import('../src/features/review/model');
  const REVIEW = '../mobile/src/lib/review';
  const { readReview } = (await import(/* @vite-ignore */ REVIEW)) as {
    readReview: (text: string, cut?: boolean) => { lead: string; comments: { path: string; range?: string; text: string }[]; more?: boolean } | null;
  };
  const comment = (i: number, text = `Comment ${i}`) => ({
    id: `c${i}`,
    scope: 'git:a.ts',
    path: `src/f${i}.ts`,
    at: i,
    text,
    lines: [{ t: '+' as const, text: `line ${i}`, neu: 10 + i }],
  });

  it('shows what was typed and each comment by its file and lines, as the desktop does', () => {
    const r = readReview(reviewMessage([comment(1), comment(2, 'Two\n\nparagraphs')], 'Please fix these'));
    expect(r?.lead).toBe('Please fix these');
    expect(r?.comments.map((c) => [c.path, c.range, c.text])).toEqual([
      ['src/f1.ts', 'line 11', 'Comment 1'],
      ['src/f2.ts', 'line 12', 'Two\n\nparagraphs'],
    ]);
    expect(r?.more).toBeUndefined();
  });

  it('leaves every other message alone', () => {
    expect(readReview('Review of your changes, please')).toBeNull();
    expect(readReview('refactor the session module')).toBeNull();
  });

  it('keeps the whole comments of a review the phone got cut short, and says there is more', () => {
    const text = reviewMessage([comment(1), comment(2), comment(3)]);
    // Cut inside the third comment's quoted lines (its fence never closes).
    const cut = text.slice(0, text.indexOf('+line 3') + 4);
    expect(readReview(cut, false)).toBeNull();
    const r = readReview(cut, true);
    expect(r?.comments.map((c) => c.path)).toEqual(['src/f1.ts', 'src/f2.ts']);
    expect(r?.more).toBe(true);
  });
});

describe("phone turns with what Claude Code writes in the person's place", () => {
  const user = (text: string, extra: Record<string, unknown> = {}) => ({ id: 'x', ts: 0, type: 'user', text, state: 'sent', ...extra }) as TimelineItem;
  const NOTE = '<task-notification>\n<status>completed</status>\n<summary>Agent "Review" completed</summary>\n<result>Two findings';

  it('reads them as the desktop does, a message the phone got cut short too', () => {
    expect(shapeOf(user(NOTE, { cut: true }))).toBe('N');
    expect(shapeOf(user('<command-name>/model</command-name><command-args>opus</command-args>'))).toBe('U');
    expect(shapeOf(user('<local-command-stdout>Set model to Opus 5.5</local-command-stdout>'))).toBe('n');
    expect(shapeOf(user('<local-command-caveat>Caveat: x</local-command-caveat>'))).toBe('u');
    expect(shapeOf(user('Build it'))).toBe('U');
  });

  it('opens a turn with a notification, stacks the next one, and gives one taken mid-turn a segment', () => {
    const two = (s: string) => {
      const { ids, shape } = spec(s);
      return groupTurns(ids, shape, false).groups;
    };
    const g = two('U1 t2 T3 N4 N5 t6 T7');
    expect(g).toHaveLength(2);
    expect((g[1] as TurnGroup).segments.map((s) => s.answer)).toEqual([null, '6']);
    const t = onlyTurn('U1 w2 N3 w4 t5 T6');
    expect(t.segments.map((s) => s.answer)).toEqual([null, '5']);
    expect(two('U1 w2 i3 N4 t5 T6')).toHaveLength(2);
  });

  it('shows a command with its output and nothing for the caveat before it', () => {
    const { ids, shape } = spec('U1 t2 T3 u4 U5 n6 T7');
    const { groups } = groupTurns(ids, shape, false);
    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({ kind: 'turn', key: '5' });
    const reminder = spec('U1 t2 T3 u4 w5 t6 T7');
    expect(groupTurns(reminder.ids, reminder.shape, false).groups).toHaveLength(2);
    const alone = spec('U1 t2 T3 u4');
    expect(groupTurns(alone.ids, alone.shape, false).groups).toHaveLength(1);
  });
});
