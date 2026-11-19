import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@shared/protocol';
import { groupTurns, shapeOf, type TurnGroup } from '@/features/timeline/turns';

/** Builds ids and a shape string from a compact spec: "U1 w2 t3 T4" (shape char + id). */
function spec(s: string) {
  const parts = s.split(/\s+/).filter(Boolean);
  return { ids: parts.map((p) => p.slice(1)), shape: parts.map((p) => p[0]).join('') };
}

const turns = (s: string, busy = false) => {
  const { ids, shape } = spec(s);
  return groupTurns(ids, shape, busy);
};

const onlyTurn = (s: string, busy = false) => {
  const { groups } = turns(s, busy);
  expect(groups).toHaveLength(1);
  expect(groups[0].kind).toBe('turn');
  return groups[0] as TurnGroup;
};

describe('shapeOf', () => {
  const base = { id: 'x', ts: 0 };
  it('reduces items to one character', () => {
    const cases: [TimelineItem, string][] = [
      [{ ...base, type: 'user', text: 'hi' }, 'U'],
      [{ ...base, type: 'user', text: 'hi', state: 'queued' }, 'Q'],
      [{ ...base, type: 'user', text: 'hi', state: 'queued', steered: true }, 'S'],
      [{ ...base, type: 'user', text: 'hi', state: 'sent', steered: true }, 'S'],
      [{ ...base, type: 'text', text: 'Hello', streaming: false }, 't'],
      [{ ...base, type: 'text', text: '', streaming: true }, 't'],
      [{ ...base, type: 'text', text: '  ', streaming: false }, '.'],
      [{ ...base, type: 'thinking', text: '', streaming: false }, 'h'],
      [{ ...base, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: {} }, 'w'],
      [{ ...base, type: 'tool', name: 'ExitPlanMode', kind: 'plan', title: 'Plan', status: 'awaiting', detail: {} }, 'p'],
      [{ ...base, type: 'notice', variant: 'interrupted', text: 'Interrupted' }, 'i'],
      [{ ...base, type: 'notice', variant: 'error', text: 'Boom' }, 'e'],
      [{ ...base, type: 'notice', variant: 'command', text: '/context' }, 'c'],
      [{ ...base, type: 'notice', variant: 'mode', text: 'Plan mode' }, 'n'],
      [{ ...base, type: 'turn', durationMs: 1 }, 'T'],
      [{ ...base, type: 'turn', durationMs: 1, error: 'x' }, 'F'],
    ];
    for (const [item, ch] of cases) expect(shapeOf(item)).toBe(ch);
  });
});

describe('groupTurns', () => {
  it('shows the last text as the answer and folds the rest into a story', () => {
    const t = onlyTurn('U1 w2 t3 w4 w5 w6 t7 w8 t9 T10');
    expect(t.state).toBe('done');
    expect(t.end).toBe('10');
    expect(t.segments).toHaveLength(1);
    const s = t.segments[0];
    expect(s.lead).toBe('1');
    expect(s.answer).toBe('9');
    expect(s.work).toEqual(['2', '3', '4', '5', '6', '7', '8']);
    expect(s.steps).toBe(5);
    expect(s.story).toEqual([
      { kind: 'steps', key: '2', ids: ['2'], count: 1 },
      { kind: 'text', id: '3' },
      { kind: 'steps', key: '4', ids: ['4', '5', '6'], count: 3 },
      { kind: 'text', id: '7' },
      { kind: 'steps', key: '8', ids: ['8'], count: 1 },
    ]);
    expect(t.ids).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  });

  it('starts a segment for every steered message, each with its own answer', () => {
    const t = onlyTurn('U1 w2 t3 S4 t5 w6 w7 t8 T9');
    expect(t.segments.map((s) => [s.lead, s.steered, s.reply, s.answer, s.work])).toEqual([
      ['1', false, null, '3', ['2']],
      ['4', true, '5', '8', ['6', '7']],
    ]);
  });

  it('keeps the direct reply to a steered question in view', () => {
    const t = onlyTurn('U1 w2 S3 w4 t5 w6 t7 t8 T9');
    expect(t.segments[1]).toMatchObject({ reply: '5', answer: '8', work: ['4', '6', '7'] });
    // A reply that is also the last word is the answer, shown once.
    expect(onlyTurn('U1 w2 S3 t4 T5').segments[1]).toMatchObject({ reply: null, answer: '4', work: [] });
  });

  it('keeps a steered message that is not answered yet as its own live segment', () => {
    const t = onlyTurn('U1 w2 w3 S4', true);
    expect(t.state).toBe('running');
    expect(t.segments).toHaveLength(2);
    expect(t.segments[0].answer).toBeNull();
    expect(t.segments[1]).toMatchObject({ lead: '4', steered: true, answer: null, work: [], steps: 0 });
  });

  it('treats a steered message outside a turn as an ordinary one', () => {
    const t = onlyTurn('S1 t2 T3');
    expect(t.segments[0]).toMatchObject({ lead: '1', steered: true, answer: '2' });
  });

  it('keeps the running story in order: a text is the answer only while nothing follows it', () => {
    const t = onlyTurn('U1 w2 t3 w4', true);
    expect(t.state).toBe('running');
    expect(t.segments[0].answer).toBeNull();
    expect(t.segments[0].work).toEqual(['2', '3', '4']);
    expect(t.segments[0].story.map((c) => c.kind)).toEqual(['steps', 'text', 'steps']);
    const writing = onlyTurn('U1 w2 t3 w4 t5', true);
    expect(writing.segments[0].answer).toBe('5');
    // Settled, the last text is the answer again, wherever it stands.
    expect(onlyTurn('U1 w2 t3 w4').segments[0].answer).toBe('3');
  });

  it('shows notices that are all a turn holds (a /compact) instead of folding them', () => {
    const t = onlyTurn('U1 n2 T3');
    expect(t.segments[0].work).toEqual([]);
    expect(t.segments[0].errors).toEqual(['2']);
    // Among steps, a notice is part of the story.
    expect(onlyTurn('U1 w2 n3 t4 T5').segments[0].work).toEqual(['2', '3']);
  });

  it('does not count thinking as a step', () => {
    const t = onlyTurn('U1 h2 g3 t4 T5');
    expect(t.segments[0].steps).toBe(0);
    expect(t.segments[0].work).toEqual(['2']);
  });

  it('does not count task list updates as steps', () => {
    const t = onlyTurn('U1 w2 k3 w4 k5 t6 T7');
    expect(t.segments[0].steps).toBe(2);
    expect(t.segments[0].work).toEqual(['2', '3', '4', '5']);
  });

  it('closes an interrupted turn with its last message as the answer', () => {
    const { groups } = turns('U1 w2 t3 w4 i5 U6 t7 T8');
    expect(groups).toHaveLength(2);
    const [a, b] = groups as TurnGroup[];
    expect(a.state).toBe('interrupted');
    expect(a.end).toBeNull();
    expect(a.segments[0].answer).toBe('3');
    expect(a.segments[0].work).toEqual(['2', '4']);
    expect(a.ids).toContain('5');
    expect(b.state).toBe('done');
    expect(b.segments[0].answer).toBe('7');
  });

  it('lets a notice after an interruption stand on its own', () => {
    const { groups } = turns('U1 w2 t3 i4 n5');
    expect(groups.map((g) => g.kind)).toEqual(['turn', 'item']);
    const t = groups[0] as TurnGroup;
    expect(t.state).toBe('interrupted');
    expect(t.ids).toEqual(['1', '2', '3', '4']);
    expect(t.segments[0].work).toEqual(['2']);
  });

  it('is interrupted, not running, when the session is still busy with nothing after the notice', () => {
    expect(onlyTurn('U1 w2 i3', true).state).toBe('interrupted');
  });

  it('attaches an interruption written after the turn record to that turn', () => {
    const { groups } = turns('U1 t2 T3 i4');
    expect(groups).toHaveLength(1);
    expect((groups[0] as TurnGroup).state).toBe('interrupted');
  });

  it('answers a failed turn with its error', () => {
    const t = onlyTurn('U1 w2 t3 F4');
    expect(t.state).toBe('failed');
    expect(t.segments[0].answer).toBeNull();
    expect(t.segments[0].work).toEqual(['2', '3']);
  });

  it('keeps error notices out of the fold', () => {
    const t = onlyTurn('U1 w2 e3');
    expect(t.state).toBe('failed');
    expect(t.segments[0].errors).toEqual(['3']);
    expect(t.segments[0].work).toEqual(['2']);
  });

  it('does not fail a turn that recovered after an error', () => {
    const t = onlyTurn('U1 e2 w3 t4 T5');
    expect(t.state).toBe('done');
    expect(t.segments[0].answer).toBe('4');
    expect(t.segments[0].errors).toEqual(['2']);
  });

  it('derives turns from messages in history without turn records', () => {
    const { groups } = turns('n0 U1 w2 t3 U4 t5 w6 t7 U8 t9');
    expect(groups.map((g) => g.kind)).toEqual(['item', 'turn', 'turn', 'turn']);
    const ts = groups.slice(1) as TurnGroup[];
    expect(ts.map((t) => t.state)).toEqual(['done', 'done', 'done']);
    expect(ts.map((t) => t.segments[0].answer)).toEqual(['3', '7', '9']);
    expect(ts[1].segments[0].work).toEqual(['5', '6']);
  });

  it('marks only the open turn at the end as running', () => {
    const { groups } = turns('U1 t2 U3 w4', true);
    expect((groups as TurnGroup[]).map((t) => t.state)).toEqual(['done', 'running']);
  });

  it('keeps notices between turns as single items', () => {
    const { groups } = turns('U1 t2 T3 n4 n5 U6 t7 T8');
    expect(groups.map((g) => (g.kind === 'item' ? g.id : `turn:${g.key}`))).toEqual(['turn:1', '4', '5', 'turn:6']);
  });

  it('floats queued messages to the end', () => {
    const { groups, queued } = turns('U1 w2 Q3 t4', true);
    expect(queued).toEqual(['3']);
    expect((groups[0] as TurnGroup).segments[0].answer).toBe('4');
    expect((groups[0] as TurnGroup).ids).not.toContain('3');
  });

  it('uses command output and plans as answers', () => {
    expect(onlyTurn('U1 c2 T3').segments[0].answer).toBe('2');
    const plan = onlyTurn('U1 w2 w3 p4', true).segments[0];
    expect(plan.answer).toBe('4');
    expect(plan.steps).toBe(2);
  });

  it('skips empty texts', () => {
    const s = onlyTurn('U1 t2 w3 .4 T5').segments[0];
    expect(s.answer).toBe('2');
    expect(s.work).toEqual(['3']);
  });

  it('handles a turn with no answer at all', () => {
    const s = onlyTurn('U1 w2 w3 T4').segments[0];
    expect(s.answer).toBeNull();
    expect(s.steps).toBe(2);
  });
});
