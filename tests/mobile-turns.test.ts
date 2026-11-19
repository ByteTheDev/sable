/**
 * The phone's copy of the turn grouping (mobile/src/lib/turns.ts) reads a conversation as the
 * desktop does (src/features/timeline/turns.ts): the same cases, run against the phone's module.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@shared/protocol';

// The phone imports the desktop's lead-in rules through its own alias.
vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));

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
