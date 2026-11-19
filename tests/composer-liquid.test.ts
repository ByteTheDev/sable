import { describe, expect, it } from 'vitest';
import { BORN, COLLAPSE, collapseAt, collapseEase, frameBounds, linearEasing, liquidAt, liquidBounds, planLiquid, revealAt, sheetAt, shiftAt, shiftEase, SNAP, springUnit, type LiquidSpec } from '../src/features/composer/liquid-shape';

// A docked composer at 1280 x 800 whose message lands just above it, and the first message from
// home rising to the top of the column.
const idle: LiquidSpec = { from: { x: 1124, y: 683, edge: true }, to: { left: 852, top: 568, width: 306, height: 43, radii: [18, 18, 6, 18] }, kind: 'bubble' };
const home: LiquidSpec = { from: { x: 1124, y: 430, edge: true }, to: { left: 852, top: 109, width: 306, height: 43, radii: [18, 18, 6, 18] }, kind: 'bubble' };
const tall: LiquidSpec = { from: { x: 1124, y: 683, edge: true }, to: { left: 550, top: 400, width: 608, height: 226, radii: [18, 18, 6, 18] }, kind: 'bubble' };
const row: LiquidSpec = { from: { x: 1124, y: 683, edge: true }, to: { left: 404, top: 649, width: 748, height: 28, radii: [9, 9, 9, 9] }, kind: 'row' };
const free: LiquidSpec = { from: { x: 1110, y: 663, edge: false }, to: idle.to, kind: 'bubble' };

describe('the words gather', () => {
  it('as one piece toward the corner, gone before the bead rises: the bar is empty for a moment', () => {
    expect(collapseAt(0)).toEqual({ s: 1, o: 1 });
    let prev = 1;
    for (let u = 0.05; u <= 1; u += 0.05) {
      const c = collapseAt(u);
      expect(c.s).toBeLessThan(prev);
      prev = c.s;
    }
    // Gone (nothing shows) well before the bead starts out of the edge.
    let gone = 0;
    while (collapseAt(gone / COLLAPSE).o > 0.001) gone += 2;
    expect(gone).toBeLessThan(BORN - 30);
  });

  it('answers the key at once and settles (the field closes on the same curve)', () => {
    expect(collapseEase(0)).toBe(0);
    expect(collapseEase(1)).toBeCloseTo(1, 6);
    // A fifth of the way in after a tenth of the time: no wait after the key.
    expect(collapseEase(0.1)).toBeGreaterThan(0.1);
    expect(linearEasing(collapseEase, 4).startsWith('linear(0, ')).toBe(true);
  });
});

describe('liquid beats', () => {
  it('rises, parts, lands, hands over and ends in order, the words read within about 400 ms', () => {
    for (const spec of [idle, home, tall, row, free]) {
      const p = planLiquid(spec);
      expect(p.born).toBeLessThan(p.swell);
      expect(p.swell).toBeLessThan(p.snap);
      expect(p.snap).toBeLessThan(p.land);
      expect(p.land).toBeLessThan(p.hand);
      expect(p.hand).toBeLessThan(p.end);
      let t = p.land;
      while (revealAt(p, t).o < 0.95) t += 2;
      expect(t).toBeLessThanOrEqual(spec === home ? 440 : 390);
      // The card's own surface has taken over by about 600 ms.
      expect(p.hand + 90).toBeLessThanOrEqual(spec === home ? 640 : 590);
    }
    expect(planLiquid(idle).snap).toBe(SNAP);
    // A longer trip flies a little longer, never much.
    expect(planLiquid(home).land - planLiquid(home).snap).toBeGreaterThan(planLiquid(idle).land - planLiquid(idle).snap);
    expect(planLiquid(home).land - planLiquid(home).snap).toBeLessThanOrEqual(175);
  });

  it('nothing shows before the bead is born; it is joined to the edge until it parts, then free', () => {
    const p = planLiquid(idle);
    expect(liquidAt(p, BORN - 5).drop).toBeUndefined();
    const before = liquidAt(p, SNAP - 20);
    expect(before.edge?.y).toBe(idle.from.y);
    expect(before.edge!.k).toBeGreaterThan(0);
    // Leaving upward, faster as it goes.
    expect(liquidAt(p, SNAP - 5).drop!.y).toBeLessThan(liquidAt(p, SNAP - 30).drop!.y);
    // What is left on the edge sinks back for a moment, then the edge is the bar's alone.
    expect(liquidAt(p, SNAP + 10).edge).toBeDefined();
    const after = liquidAt(p, SNAP + 70);
    expect(after.edge).toBeUndefined();
    expect(after.drop).toBeDefined();
  });

  it('draws nothing under the bar it is joined to (but its hairline under the meniscus)', () => {
    const p = planLiquid(idle);
    const b = frameBounds(liquidAt(p, SNAP - 20))!;
    expect(b.y1).toBeLessThanOrEqual(idle.from.y + 2);
  });

  it('a bead with no edge just swells where the words went', () => {
    const f = liquidAt(planLiquid(free), 140);
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
      let prev = centre(spec, p.born);
      for (let t = p.born + 4; t < p.land; t += 4) {
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

  it('the drop is lit, and the light is the card\'s own quiet hairline at the handover', () => {
    const p = planLiquid(idle);
    expect(liquidAt(p, SNAP + 20).light).toBe(1);
    expect(liquidAt(p, p.hand).light).toBeCloseTo(0, 3);
    const mid = liquidAt(p, (p.land + p.hand) / 2).light;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe('the words in the sheet', () => {
  it('are hidden in the drop, revealed through a window that is the sheet, and whole at the handover', () => {
    const p = planLiquid(idle);
    expect(revealAt(p, p.land - 1).o).toBe(0);
    for (let t = p.land; t < p.hand; t += 6) {
      const r = revealAt(p, t);
      const s = sheetAt(p, t);
      // The window is the sheet (words never stand outside the ink).
      expect(idle.to.left + r.x).toBeCloseTo(s.left, 3);
      expect(idle.to.top + r.y).toBeCloseTo(s.top, 3);
      if (r.sx < 1.2 && r.sx > 0.02) expect(idle.to.width * r.sx).toBeCloseTo(s.right - s.left, 2);
    }
    expect(revealAt(p, p.hand)).toEqual({ x: 0, y: 0, sx: 1, sy: 1, o: 1 });
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
  it('covers the edge, the flight and the landing with room for its overshoot and shadow', () => {
    for (const spec of [idle, home, row]) {
      const p = planLiquid(spec);
      const b = liquidBounds(p);
      expect(b.left).toBeLessThan(spec.to.left - 20);
      expect(b.left + b.width).toBeGreaterThan(spec.from.x + p.r);
      expect(b.top).toBeLessThan(spec.to.top - 20);
      expect(b.top + b.height).toBeGreaterThan(spec.from.y);
      expect(b.top + b.height).toBeGreaterThan(spec.to.top + spec.to.height + 20);
    }
  });
});
