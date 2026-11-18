import { describe, expect, it } from 'vitest';
import { columnEdges, firstLanding, landingCertain, RELEASE, springPath } from '../src/features/composer/flight';

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

describe('send flight path', () => {
  const start = { t: 0, x: 0, y: 0, vx: 0, vy: 0 };

  it('lands exactly on the landing and is there within 450 ms', () => {
    // From the home field to the top of the column at 1536 x 912, and a short hop above the dock.
    for (const [gx, gy, sideways] of [[515, -307, true], [496, -514, false], [240, -96, false]] as const) {
      const path = springPath(start, gx, gy, { release: RELEASE, sideways });
      const end = path[path.length - 1];
      expect(end.x).toBe(gx);
      expect(end.y).toBe(gy);
      expect(end.vx).toBe(0);
      expect(end.vy).toBe(0);
      expect(end.t).toBeLessThanOrEqual(450);
      // Within two pixels long before it rests: the eye reads it as landed by 350 ms.
      const near = path.find((p) => Math.hypot(gx - p.x, gy - p.y) < 2);
      expect(near!.t).toBeLessThanOrEqual(350);
    }
  });

  it('settles with a small overshoot at most, and never wanders', () => {
    const gx = 515;
    const gy = -307;
    const path = springPath(start, gx, gy, { release: RELEASE, sideways: true });
    for (const p of path) {
      expect(p.x).toBeLessThanOrEqual(gx * 1.03);
      expect(p.y).toBeGreaterThanOrEqual(gy * 1.03);
      expect(p.y).toBeLessThanOrEqual(3);
    }
    // Time only moves forward, in steps the compositor can interpolate.
    for (let i = 1; i < path.length; i++) expect(path[i].t).toBeGreaterThan(path[i - 1].t);
  });

  it('gathers until the release, then leaves', () => {
    const path = springPath(start, 400, -400, { release: RELEASE });
    const before = path.filter((p) => p.t <= RELEASE);
    for (const p of before) expect(Math.abs(p.x) + Math.abs(p.y)).toBeLessThan(3);
    const soon = path.find((p) => p.t >= RELEASE + 100)!;
    expect(soon.y).toBeLessThan(-120);
  });

  it('goes on from where it is when re-aimed, at its speed', () => {
    const first = springPath(start, 300, -300, { release: RELEASE });
    const mid = first[Math.floor(first.length / 3)];
    const path = springPath(mid, 320, -280, { release: RELEASE });
    expect(path[0]).toEqual(mid);
    const end = path[path.length - 1];
    expect([end.x, end.y]).toEqual([320, -280]);
  });
});

describe('first message landing', () => {
  it('sits on the column\'s right edge under the top padding', () => {
    // The stage at 1536 x 912 with the sidebar open: the card measured there is at 1061, 109 (225 wide).
    expect(firstLanding({ left: 285, top: 53, width: 1242 }, 760, { width: 225 })).toEqual({ left: 1061, top: 109 });
  });
});
