import { describe, expect, it } from 'vitest';
import { countIn, findHits, jumpTarget, ordinal, startAt, step, totalOf } from '@/features/session/find';

const src = [
  { id: 'u1', text: 'Refactor the session module' },
  { id: 't1', text: 'The session module has two parts. SESSION state and session views.' },
  { id: 'u2', text: 'ok' },
  { id: 't2', text: 'Done: session.ts' },
];

describe('find in conversation', () => {
  it('counts occurrences without regard to case, not overlapping', () => {
    expect(countIn('aaaa', 'aa')).toBe(2);
    expect(countIn('Session session SESSION', 'session')).toBe(3);
    expect(countIn('anything', '')).toBe(0);
  });

  it('lists matching items in order with their counts', () => {
    const hits = findHits(src, ' session ');
    expect(hits).toEqual([
      { itemId: 'u1', count: 1 },
      { itemId: 't1', count: 3 },
      { itemId: 't2', count: 1 },
    ]);
    expect(totalOf(hits)).toBe(5);
    expect(findHits(src, '   ')).toEqual([]);
  });

  it('treats the query literally', () => {
    expect(findHits([{ id: 'a', text: 'a.b (c) [d]' }], '(c)')).toEqual([{ itemId: 'a', count: 1 }]);
    expect(findHits([{ id: 'a', text: 'axb' }], 'a.b')).toEqual([]);
  });

  it('starts at the last occurrence, steps through every one and wraps', () => {
    const hits = findHits(src, 'session');
    let c = startAt(hits);
    expect(ordinal(hits, c)).toBe(5);
    c = step(hits, c, 1);
    expect(ordinal(hits, c)).toBe(1);
    c = step(hits, c, 1);
    expect(c).toEqual({ hit: 1, nth: 0 });
    c = step(hits, step(hits, c, 1), 1);
    expect(ordinal(hits, c)).toBe(4);
    c = step(hits, c, -1);
    expect(ordinal(hits, c)).toBe(3);
    expect(ordinal(hits, step(hits, { hit: 0, nth: 0 }, -1))).toBe(5);
  });

  it('stays on the same message when the query changes and it still matches', () => {
    expect(startAt(findHits(src, 'module'), 'u1')).toEqual({ hit: 0, nth: 0 });
    expect(startAt(findHits(src, 'done'), 'u1')).toEqual({ hit: 0, nth: 0 });
    expect(startAt([], 'u1')).toBeNull();
    expect(step([], null, 1)).toBeNull();
    expect(ordinal([], null)).toBe(0);
  });

  it('jumps between your messages and stops at the ends', () => {
    const ids = ['a', 'b', 'c'];
    expect(jumpTarget(ids, 2, -1)).toBe('b');
    expect(jumpTarget(ids, 0, -1)).toBe('a');
    expect(jumpTarget(ids, 1, 1)).toBe('c');
    expect(jumpTarget(ids, 2, 1)).toBeUndefined();
    expect(jumpTarget([], 0, 1)).toBeUndefined();
  });
});
