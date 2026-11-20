import { describe, expect, it } from 'vitest';
import {
  BAR_LEAVES,
  BORN,
  COLLAPSE,
  collapseAt,
  collapseEase,
  dampFor,
  footAt,
  frameBounds,
  glideUnit,
  GLIDE,
  HAND,
  handAlpha,
  INK,
  linearEasing,
  liquidAt,
  liquidBounds,
  planLiquid,
  revealAt,
  sheetAt,
  shiftAt,
  shiftEase,
  springFrom,
  type LiquidSpec,
} from '../src/features/composer/liquid-shape';

// A docked composer at 1280 x 800 whose message lands just above it, and the first message from
// home rising to the top of the column while the bar leaves for the dock.
const idle: LiquidSpec = { from: { x: 1124, y: 683, edge: true }, to: { left: 852, top: 568, width: 306, height: 43, radii: [18, 18, 6, 18] }, kind: 'bubble' };
const home: LiquidSpec = { from: { x: 1124, y: 430, edge: true }, to: { left: 852, top: 109, width: 306, height: 43, radii: [18, 18, 6, 18] }, kind: 'bubble', bar: { dx: 0, dy: 280 } };
const tall: LiquidSpec = { from: { x: 1124, y: 683, edge: true }, to: { left: 550, top: 400, width: 608, height: 226, radii: [18, 18, 6, 18] }, kind: 'bubble' };
const row: LiquidSpec = { from: { x: 1124, y: 683, edge: true }, to: { left: 404, top: 649, width: 748, height: 28, radii: [9, 9, 9, 9] }, kind: 'row' };
const free: LiquidSpec = { from: { x: 1110, y: 663, edge: false }, to: idle.to, kind: 'bubble' };

describe('the words gather', () => {
  it('as one piece toward the corner, gone before the drop comes out: the bar is empty for a moment', () => {
    expect(collapseAt(0)).toEqual({ sx: 1, sy: 1, o: 1 });
    let prev = { sx: 1, sy: 1 };
    for (let u = 0.05; u <= 1; u += 0.05) {
      const c = collapseAt(u);
      expect(c.sy).toBeLessThan(prev.sy);
      // Their width leads their height: they draw into a stream at the corner.
      expect(c.sx).toBeLessThanOrEqual(c.sy);
      prev = c;
    }
    // Gone (nothing shows) before the drop starts under the edge.
    let gone = 0;
    while (collapseAt(gone / COLLAPSE).o > 0.001) gone += 2;
    expect(gone).toBeLessThan(BORN - 10);
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
  it('comes out, parts, lands, hands over and ends in order, the words read within about 400 ms', () => {
    for (const spec of [idle, home, tall, row, free]) {
      const p = planLiquid(spec);
      expect(p.born).toBeLessThanOrEqual(p.launch);
      expect(p.launch).toBeLessThanOrEqual(p.snap);
      expect(p.snap).toBeLessThan(p.land);
      expect(p.land).toBeLessThan(p.hand);
      expect(p.hand).toBeLessThan(p.end);
      let t = p.land;
      while (revealAt(p, t).o < 0.95) t += 2;
      // The first message has further to go.
      expect(t).toBeLessThanOrEqual(spec === home ? 400 : 340);
      // The card's own surface has taken over by about 600 ms.
      expect(p.hand + HAND).toBeLessThanOrEqual(spec === home ? 600 : 540);
    }
    // A longer trip takes a little longer, never much.
    const far = planLiquid(home);
    const near = planLiquid(idle);
    expect(far.land - far.born).toBeGreaterThan(near.land - near.born);
    expect(far.land - far.born).toBeLessThanOrEqual(240);
  });

  it('nothing shows before the drop is born; it is tied to the edge until the thread parts, then free', () => {
    const p = planLiquid(idle);
    expect(liquidAt(p, BORN - 5).drop).toBeUndefined();
    // Under the edge at first: its skin does not reach the edge, so the swell starts from nothing.
    const first = liquidAt(p, BORN);
    expect(first.drop!.y - first.drop!.r).toBeGreaterThan(idle.from.y + first.edge!.k * 0.2);
    // Clear of the edge and tied to it by a thread whose waist thins.
    const a = liquidAt(p, p.launch + 4);
    const b = liquidAt(p, p.snap - 2);
    expect(a.foot && a.tail && b.foot && b.tail).toBeTruthy();
    expect(b.foot!.rb).toBeLessThan(a.foot!.rb);
    expect(b.foot!.rb).toBeLessThan(1.5);
    // The two pieces meet at the waist.
    expect(a.foot!.bx).toBeCloseTo(a.tail!.bx, 6);
    expect(a.foot!.by).toBeCloseTo(a.tail!.by, 6);
    // Parted: both ends recoil, the tail up into the drop, the foot back into the edge.
    const c = liquidAt(p, p.snap + 2);
    const d = liquidAt(p, p.snap + 30);
    const len = (t: { ax: number; ay: number; bx: number; by: number }) => Math.hypot(t.bx - t.ax, t.by - t.ay);
    expect(len(d.foot!)).toBeLessThan(len(c.foot!) * 0.2);
    expect(len(d.tail!)).toBeLessThan(len(c.tail!) * 0.2);
    // The edge bobs once, a pixel or two, and is the bar's alone again.
    let bob = 0;
    for (let t = p.snap; t < p.snap + 100; t += 4) bob = Math.max(bob, liquidAt(p, t).edge?.bob ?? 0);
    expect(bob).toBeGreaterThan(0.5);
    expect(bob).toBeLessThan(3);
    expect(liquidAt(p, p.snap + 120).edge).toBeUndefined();
  });

  it('draws nothing under the bar it is tied to (but its hairline under the meniscus)', () => {
    const p = planLiquid(idle);
    for (const t of [p.born + 20, p.launch, p.snap - 4, p.snap + 20]) {
      const b = frameBounds(liquidAt(p, t))!;
      expect(b.y1).toBeLessThanOrEqual(idle.from.y + 2);
    }
  });

  it('a drop with no edge swells where the words went and leaves from there', () => {
    const p = planLiquid(free);
    const f = liquidAt(p, p.born + 20);
    expect(f.edge).toBeUndefined();
    expect(f.foot).toBeUndefined();
    expect(Math.abs(f.drop!.x - free.from.x)).toBeLessThan(3);
    expect(f.drop!.r).toBeLessThan(p.r);
    expect(liquidAt(p, p.born + 80).drop!.r).toBeCloseTo(p.r, 1);
  });
});

describe('liquid motion', () => {
  it('is one motion: the speed never steps, from under the edge to the landing', () => {
    for (const spec of [idle, home, tall, free, row]) {
      const p = planLiquid(spec);
      let prev = liquidAt(p, p.born).drop!;
      let v0 = 0;
      let peak = 0;
      for (let t = p.born + 2; t < p.land; t += 2) {
        const d = liquidAt(p, t).drop!;
        const v = Math.hypot(d.x - prev.x, d.y - prev.y) / 2;
        // No jump in place (it is fast: up to ~3 px/ms on the long trip), and none in speed: it
        // changes by a small share of its peak from one step to the next, through the launch and
        // the parting of the thread alike.
        expect(v).toBeLessThan(3.4);
        expect(Math.abs(v - v0)).toBeLessThan(spec === home ? 0.34 : 0.2);
        peak = Math.max(peak, v);
        v0 = v;
        prev = d;
      }
      // It starts from rest and is still moving when it lands (slower than at its peak, unless it hops).
      const first = liquidAt(p, p.born + 2).drop!;
      const start = liquidAt(p, p.born).drop!;
      expect(Math.hypot(first.x - start.x, first.y - start.y)).toBeLessThan(0.1);
      const arrive = Math.hypot(p.arrive.vx, p.arrive.vy);
      expect(arrive).toBeGreaterThan(0.3);
      if (!p.arc) expect(arrive).toBeLessThan(peak * 0.7);
    }
  });

  it('leaves the bar straight up, then bends to its place', () => {
    const p = planLiquid({ ...idle, to: { ...idle.to, left: 500 } });
    const a = liquidAt(p, p.born + 10).drop!;
    const b = liquidAt(p, p.born + 30).drop!;
    expect(Math.abs(b.x - a.x)).toBeLessThan(Math.abs(b.y - a.y) * 0.4);
  });

  it('hops into a queue row: up over the row, then down into it, landing as it falls', () => {
    const p = planLiquid(row);
    expect(p.arc).toBeGreaterThan(0);
    expect(planLiquid(idle).arc).toBe(0);
    let top = Infinity;
    for (let t = p.launch; t < p.land; t += 2) top = Math.min(top, liquidAt(p, t).drop!.y);
    // The top of the arc clears the row's top edge by more than the drop's radius.
    expect(top).toBeLessThan(row.to.top - p.r);
    // Falling (down the page) as it touches down.
    expect(p.arrive.vy).toBeGreaterThan(0.4);
    // The spread takes the fall, but never spills past the row's bottom (the bar is right under it).
    for (let t = p.land; t <= p.hand; t += 4) expect(sheetAt(p, t).bottom).toBeLessThan(row.to.top + row.to.height + 1.01);
  });

  it('touches down where it spreads from: the sheet starts as the drop, its edges at the drop\'s speed', () => {
    for (const spec of [idle, home, row]) {
      const p = planLiquid(spec);
      const d = liquidAt(p, p.land - 0.01).drop!;
      const s = sheetAt(p, p.land);
      expect(Math.abs((s.left + s.right) / 2 - d.x)).toBeLessThan(1.5);
      expect(Math.abs((s.top + s.bottom) / 2 - d.y)).toBeLessThan(1.5);
      expect(s.right - s.left).toBeLessThan(p.r * 2.6);
      // The top edge goes on at (a share of) the drop's own speed: no stop at the landing.
      const top = (sheetAt(p, p.land + 2).top - s.top) / 2;
      if (p.arrive.vy < 0) expect(top).toBeLessThan(p.arrive.vy * 0.5);
    }
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

  it('settles a pixel or two past its place, never more', () => {
    for (const spec of [idle, tall, home]) {
      const p = planLiquid(spec);
      let left = Infinity;
      let top = Infinity;
      for (let t = p.land; t <= p.hand; t += 2) {
        const s = sheetAt(p, t);
        left = Math.min(left, s.left);
        top = Math.min(top, s.top);
      }
      expect(spec.to.left - left).toBeGreaterThan(0.3);
      expect(spec.to.left - left).toBeLessThan(3);
      expect(spec.to.top - top).toBeLessThan(3.5);
    }
    // The spring itself: let go at rest it ends on its place, and its damping follows the overshoot asked for.
    expect(springFrom(0, 10, 0, 100, 0.05, 0.8)).toBeCloseTo(10, 6);
    expect(springFrom(400, 10, 0, 100, 0.05, 0.8)).toBeCloseTo(100, 3);
    expect(dampFor(300, 1.5)).toBeGreaterThan(dampFor(300, 6));
  });

  it('is glass in the air and the card\'s own quiet surface at the handover', () => {
    const p = planLiquid(idle);
    // The bar's own ink while it is in the bar, lit as it lifts away.
    expect(liquidAt(p, p.born + 4).light).toBe(0);
    const air = liquidAt(p, p.snap + 20);
    expect(air.light).toBe(1);
    expect(air.lens).toBe(p.r);
    const mid = liquidAt(p, (p.land + p.hand) / 2);
    expect(mid.light).toBeGreaterThan(0);
    expect(mid.light).toBeLessThan(1);
    expect(mid.lens).toBeLessThan(p.r);
    const end = liquidAt(p, p.hand);
    expect(end.light).toBeCloseTo(0, 3);
    expect(end.lens).toBeCloseTo(1, 3);
  });

  it('lets go as the card\'s surface comes in, the two covering as much as the card alone', () => {
    expect(handAlpha(0)).toBe(1);
    expect(handAlpha(1)).toBe(0);
    for (let u = 0.1; u < 1; u += 0.1) {
      // The surface at opacity u over the sheet at handAlpha(u): what gets through both.
      const through = (1 - INK.a * handAlpha(u)) * (1 - INK.a * u);
      expect(through).toBeCloseTo(1 - INK.a, 6);
    }
    const p = planLiquid(idle);
    expect(liquidAt(p, p.hand + HAND / 2).alpha).toBeCloseTo(handAlpha(0.5), 6);
  });
});

describe('the bar that leaves under a first message', () => {
  it('glides on the spring the home card flies on, read between its samples', () => {
    expect(glideUnit(0)).toBe(0);
    expect(glideUnit(-20)).toBe(0);
    // The same stepping as handoff.ts: semi-implicit Euler, 4 ms steps.
    let x = 0;
    let v = 0;
    const h = GLIDE.step / 1000;
    for (let i = 0; i < 8; i++) {
      v += (GLIDE.stiff * (1 - x) - GLIDE.damp * v) * h;
      x += v * h;
    }
    expect(glideUnit(32)).toBeCloseTo(x, 6);
    expect(glideUnit(2000)).toBe(1);
    let prev = 0;
    for (let t = 8; t < 600; t += 8) {
      expect(glideUnit(t)).toBeGreaterThanOrEqual(prev);
      prev = glideUnit(t);
    }
  });

  it('takes the edge, the meniscus and the thread\'s foot with it', () => {
    const p = planLiquid(home);
    expect(footAt(home, BAR_LEAVES)).toEqual({ x: 1124, y: 430 });
    const later = footAt(home, BAR_LEAVES + 48);
    expect(later.y).toBeGreaterThan(440);
    const f = liquidAt(p, BAR_LEAVES + 8);
    expect(f.edge!.y).toBeCloseTo(footAt(home, BAR_LEAVES + 8).y, 6);
    if (f.foot) expect(f.foot.ay).toBeCloseTo(f.edge!.y, 6);
    // The drop is out of the edge before the bar goes.
    expect(p.launch).toBeLessThan(BAR_LEAVES);
    // A bar that stays has its edge where it was.
    expect(footAt(idle, 400)).toEqual(idle.from);
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
  it('bend the flight toward the moved landing and move the sheet by the difference, eased in', () => {
    const p0 = planLiquid(idle);
    const p = planLiquid(idle, [{ at: 200, dx: -12, dy: 30, dur: 60 }]);
    expect(shiftAt(p, 200)).toEqual({ x: 0, y: 0 });
    const end = shiftAt(p, 260);
    expect(end.x).toBeCloseTo(-12, 6);
    expect(end.y).toBeCloseTo(30, 6);
    // The drop lands on the moved place.
    const d = liquidAt(p, p.land - 0.01).drop!;
    const d0 = liquidAt(p0, p0.land - 0.01).drop!;
    expect(d.x - d0.x).toBeCloseTo(-12, 1);
    expect(d.y - d0.y).toBeCloseTo(30, 1);
    // Past the shift's end, before the end of the drawing.
    const plain = sheetAt(p, 400);
    const drawn = liquidAt(p, 400).sheet!;
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
      // Every frame's own region lies inside it.
      for (let t = p.born; t < p.end; t += 6) {
        const fb = frameBounds(liquidAt(p, t));
        if (!fb) continue;
        expect(fb.x0).toBeGreaterThanOrEqual(b.left);
        expect(fb.x1).toBeLessThanOrEqual(b.left + b.width);
        expect(fb.y0).toBeGreaterThanOrEqual(b.top);
        expect(fb.y1).toBeLessThanOrEqual(b.top + b.height);
      }
    }
  });

  it('fits the canvases the worker holds (liquid.ts): no flight is drawn on the main thread for its size', () => {
    const fits = (spec: LiquidSpec, w: number, h: number) => {
      const b = liquidBounds(planLiquid(spec), 0);
      return b.width <= w && b.height + 68 <= h;
    };
    expect(fits(idle, 700, 300)).toBe(true);
    expect(fits(home, 700, 900)).toBe(true);
    expect(fits(row, 820, 180)).toBe(true);
  });
});
