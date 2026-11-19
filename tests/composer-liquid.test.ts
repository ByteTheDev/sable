import { describe, expect, it } from 'vitest';
import { linearEasing, liquidAt, liquidBounds, planLiquid, sheetAt, shiftAt, shiftEase, SNAP, springUnit, wordsAt, type LiquidSpec } from '../src/features/composer/liquid-shape';

// A docked composer at 1280 x 800 whose message lands just above it, and the first message from
// home rising to the top of the column.
const idle: LiquidSpec = { from: { x: 1124, y: 683, edge: true }, to: { left: 852, top: 568, width: 306, height: 43, radii: [18, 18, 6, 18] }, kind: 'bubble' };
const home: LiquidSpec = { from: { x: 1124, y: 430, edge: true }, to: { left: 852, top: 109, width: 306, height: 43, radii: [18, 18, 6, 18] }, kind: 'bubble' };
const tall: LiquidSpec = { from: { x: 1124, y: 683, edge: true }, to: { left: 550, top: 400, width: 608, height: 226, radii: [18, 18, 6, 18] }, kind: 'bubble' };
const row: LiquidSpec = { from: { x: 1124, y: 683, edge: true }, to: { left: 404, top: 649, width: 748, height: 28, radii: [9, 9, 9, 9] }, kind: 'row' };
const free: LiquidSpec = { from: { x: 1110, y: 663, edge: false }, to: idle.to, kind: 'bubble' };

describe('liquid beats', () => {
  it('breaks, lands, hands over and ends in order, the message in place by about half a second', () => {
    for (const spec of [idle, home, tall, row, free]) {
      const p = planLiquid(spec);
      expect(p.snap).toBeLessThan(p.land);
      expect(p.land).toBeLessThan(p.hand);
      expect(p.hand).toBeLessThan(p.end);
      // The words read at full size (the card spread out) well within half a second...
      let t = p.land;
      while (wordsAt(p, t).s < 0.95) t += 2;
      expect(t).toBeLessThanOrEqual(spec === home ? 420 : 360);
      // ...and the card's own surface has taken over soon after.
      expect(p.hand + 90).toBeLessThanOrEqual(spec === home ? 560 : 500);
    }
    expect(planLiquid(idle).snap).toBe(SNAP);
    // A longer trip flies a little longer, never much.
    expect(planLiquid(home).land - planLiquid(home).snap).toBeGreaterThan(planLiquid(idle).land - planLiquid(idle).snap);
    expect(planLiquid(home).land - planLiquid(home).snap).toBeLessThanOrEqual(175);
  });

  it('is joined to the bar by a neck until the break, then free', () => {
    const p = planLiquid(idle);
    const before = liquidAt(p, SNAP - 20);
    expect(before.neck).toBeGreaterThan(0);
    expect(before.edge?.clip).toBe(true);
    const after = liquidAt(p, SNAP + 10);
    expect(after.neck).toBeUndefined();
    expect(after.drop).toBeDefined();
    expect(after.stub).toBeDefined();
  });

  it('a bead with no edge just gathers where the words went', () => {
    const f = liquidAt(planLiquid(free), 60);
    expect(f.neck).toBeUndefined();
    expect(f.edge).toBeUndefined();
    expect(f.drop!.x).toBe(free.from.x);
  });
});

describe('liquid motion', () => {
  /** The centre of what is drawn: the drop, or the sheet. */
  const centre = (spec: LiquidSpec, t: number) => {
    const f = liquidAt(planLiquid(spec), t);
    if (f.drop) return { x: f.drop.x, y: f.drop.y };
    const s = f.sheet!;
    return { x: (s.left + s.right) / 2, y: (s.top + s.bottom) / 2 };
  };

  it('never jumps: the drop moves continuously through the break and the flight', () => {
    for (const spec of [idle, home, free]) {
      const p = planLiquid(spec);
      let prev = centre(spec, 0);
      for (let t = 4; t < p.land; t += 4) {
        const c = centre(spec, t);
        // Fast (it leaves at up to ~5 px/ms), but along a path: no step is a jump.
        expect(Math.hypot(c.x - prev.x, c.y - prev.y)).toBeLessThan(24);
        prev = c;
      }
    }
  });

  it('touches down where it spreads from: the sheet starts as the drop', () => {
    const p = planLiquid(idle);
    const d = liquidAt(p, p.land - 0.01).drop!;
    const s = sheetAt(p, p.land);
    expect(Math.abs((s.left + s.right) / 2 - d.x)).toBeLessThan(1.5);
    expect(Math.abs((s.top + s.bottom) / 2 - d.y)).toBeLessThan(1.5);
    expect(s.right - s.left).toBeLessThan(p.r * 2.6);
  });

  it('is exactly the card at the handover: its box, its corners', () => {
    for (const spec of [idle, home, tall, row]) {
      const p = planLiquid(spec);
      const s = sheetAt(p, p.hand);
      const { to } = spec;
      expect(s.left).toBeCloseTo(to.left, 1);
      expect(s.top).toBeCloseTo(to.top, 1);
      expect(s.right).toBeCloseTo(to.left + to.width, 1);
      expect(s.bottom).toBeCloseTo(to.top + to.height, 1);
      expect(s.radii).toEqual(to.radii);
    }
  });

  it('spreads with a small overshoot at most', () => {
    const p = planLiquid(tall);
    for (let t = p.land; t <= p.hand; t += 4) {
      const s = sheetAt(p, t);
      expect(s.left).toBeGreaterThan(tall.to.left - 0.05 * tall.to.width);
      expect(s.top).toBeGreaterThan(tall.to.top - 0.06 * tall.to.height - 6);
    }
    expect(springUnit(0, 4.6, 4.3)).toBe(0);
    expect(springUnit(1, 4.6, 4.3)).toBe(1);
  });

  it('the light thins out as it spreads and is gone on the card', () => {
    const p = planLiquid(idle);
    expect(liquidAt(p, SNAP + 20).glow).toBe(1);
    expect(liquidAt(p, p.hand).glow).toBeCloseTo(0, 2);
    const mid = liquidAt(p, (p.land + p.hand) / 2).glow;
    expect(mid).toBeGreaterThanOrEqual(0);
    expect(mid).toBeLessThan(1);
  });
});

describe('the words in the sheet', () => {
  it('are hidden in the drop, unfold inside the sheet, and sit exactly on the card at the handover', () => {
    const p = planLiquid(idle);
    expect(wordsAt(p, p.land - 1).o).toBe(0);
    for (let t = p.land; t <= p.hand; t += 6) {
      const w = wordsAt(p, t);
      const s = sheetAt(p, t);
      // Inside the sheet (a hair of slack for rounding).
      expect(idle.to.left + w.x).toBeGreaterThanOrEqual(s.left - 0.5);
      expect(idle.to.left + w.x + idle.to.width * w.s).toBeLessThanOrEqual(s.right + 0.5);
    }
    const end = wordsAt(p, p.hand);
    expect(end.s).toBeCloseTo(1, 3);
    expect(end.x).toBeCloseTo(0, 1);
    expect(end.y).toBeCloseTo(0, 1);
    expect(end.o).toBe(1);
  });
});

describe('late corrections', () => {
  it('move everything after the break by the difference, eased in', () => {
    const p = planLiquid(idle, [{ at: 250, dx: -12, dy: 30, dur: 180 }]);
    expect(shiftAt(p, 250)).toEqual({ x: 0, y: 0 });
    const end = shiftAt(p, 430);
    expect(end.x).toBeCloseTo(-12, 6);
    expect(end.y).toBeCloseTo(30, 6);
    // Past the shift's end, before the end of the drawing.
    const plain = sheetAt(p, 440);
    const drawn = liquidAt(p, 440).sheet!;
    expect(drawn.left - plain.left).toBeCloseTo(-12, 6);
    expect(drawn.top - plain.top).toBeCloseTo(30, 6);
  });

  it('share their curve with the words (a CSS linear() of the same ease)', () => {
    const e = linearEasing(shiftEase, 4);
    expect(e).toBe('linear(0, 0.1035, 0.5, 0.8965, 1)');
  });
});

describe('liquid canvas', () => {
  it('covers the edge, the flight and the landing with room for its overshoot', () => {
    for (const spec of [idle, home, row]) {
      const p = planLiquid(spec);
      const b = liquidBounds(p);
      expect(b.left).toBeLessThan(spec.to.left - 20);
      expect(b.left + b.width).toBeGreaterThan(spec.from.x + p.r);
      expect(b.top).toBeLessThan(spec.to.top - 20);
      expect(b.top + b.height).toBeGreaterThan(spec.from.y);
    }
  });
});
