import { describe, expect, it } from 'vitest';
import { cycle, firstIndex, recentOrder, visit } from '@/features/session/quick';

const s = (id: string, updatedAt: number, archived = false) => ({ id, updatedAt, archived });

describe('quick switcher order', () => {
  it('puts visited sessions first, most recent first, then the rest by activity', () => {
    const all = [s('a', 1), s('b', 5), s('c', 3), s('d', 9)];
    expect(recentOrder(all, ['c', 'a']).map((x) => x.id)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('leaves out archived and removed sessions, and keeps to the limit', () => {
    const all = [s('a', 1), s('b', 5, true), s('c', 3)];
    expect(recentOrder(all, ['b', 'gone', 'a']).map((x) => x.id)).toEqual(['a', 'c']);
    expect(recentOrder([s('a', 1), s('b', 2), s('c', 3)], [], 2).map((x) => x.id)).toEqual(['c', 'b']);
  });

  it('moves a visit to the front without duplicates', () => {
    expect(visit(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(visit(['a', 'b'], 'x', 2)).toEqual(['x', 'a']);
  });

  it('lands on the previous session first, and wraps', () => {
    expect(firstIndex(['a', 'b', 'c'], 'a', 1)).toBe(1);
    expect(firstIndex(['a', 'b', 'c'], 'a', -1)).toBe(2);
    expect(firstIndex(['a', 'b', 'c'], null, 1)).toBe(0);
    expect(firstIndex([], 'a', 1)).toBe(-1);
    expect(cycle(2, 3, 1)).toBe(0);
    expect(cycle(0, 3, -1)).toBe(2);
  });
});
