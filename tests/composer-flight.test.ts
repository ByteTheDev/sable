import { describe, expect, it } from 'vitest';
import { columnEdges, landingCertain } from '../src/features/composer/flight';

describe('send flight landing', () => {
  it('centres the reading column in a wide conversation', () => {
    // A 1490 px conversation with a 760 px column: the card's right edge is the column's, not the stage's.
    const c = columnEdges(0, 1490, 760);
    expect(c.right).toBe(1125);
    expect(c.left).toBe(365);
    expect(c.width).toBe(760);
  });

  it('keeps the minimum side padding in a narrow conversation', () => {
    const c = columnEdges(100, 600, 760);
    expect(c.left).toBe(124);
    expect(c.right).toBe(676);
    expect(c.width).toBe(552);
  });

  const col = { left: 365, right: 1125 };
  const view = { top: 0, bottom: 800 };
  const box = (left: number, top: number, width = 120, height = 22) => ({ left, top, width, height, right: left + width, bottom: top + height });

  it('flies to a row inside the column and near the view', () => {
    expect(landingCertain(box(1000, 600), col, view)).toBe(true);
    // Still rising from behind the composer while the view follows it.
    expect(landingCertain(box(1000, 1100), col, view)).toBe(true);
  });

  it('does not fly to a row outside the column', () => {
    // The stray: a landing at the stage's right edge, outside the column.
    expect(landingCertain(box(1322, 600), col, view)).toBe(false);
  });

  it('does not fly to a row far off screen or not laid out', () => {
    expect(landingCertain(box(1000, 4000), col, view)).toBe(false);
    expect(landingCertain(box(1000, -900), col, view)).toBe(false);
    expect(landingCertain(box(0, 0, 0, 0), col, view)).toBe(false);
  });
});
