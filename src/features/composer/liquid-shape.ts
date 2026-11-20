/**
 * A sent message as liquid: the geometry over time, pure. The worker that draws it
 * (liquid.worker.ts, with liquid-gl.ts), the main thread that moves the words with it (flight.ts)
 * and the tests all read the same numbers, so the silhouette and the words agree in every frame
 * without talking.
 *
 * The beats (ms after the key's first frame):
 * - collapse (0 to COLLAPSE): the words gather into the bar's top-right corner as one piece and
 *   fade, while the field closes to one line on the same curve. The bar is empty and at rest.
 * - bead (BORN to SWELL): a bead of ink rises out of the bar's top edge there, joined to it by a
 *   meniscus (a smooth union of the edge and the bead, so the two read as one liquid);
 * - pinch (SWELL to SNAP): the bead lifts, the meniscus draws into a neck that thins and parts;
 *   what is left on the edge sinks back into it;
 * - rise (SNAP to land): the drop flies to the bottom-right of where the message will sit,
 *   stretched along its speed, leaving fast and arriving still moving;
 * - spread (land to hand): it touches down and spreads into the card's shape, each edge on its own
 *   spring (the top one carries the drop's momentum a little past, the far edge races out and
 *   settles), the corners easing from round to the card's, the tail corner last. The words are
 *   revealed in place by the spreading ink (never scaled);
 * - hand (hand to end): the conversation's own card takes over (a bubble), or the sheet melts into
 *   the queue row it landed on (a row).
 *
 * A bead with no edge (words leaving a queue row) simply swells where the words gathered.
 * Geometry is in the page's CSS px (viewport, already divided by the interface zoom).
 */

export type Radii = [number, number, number, number];

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Top-left, top-right, bottom-right, bottom-left. */
  radii: Radii;
}

export interface LiquidSpec {
  /** Where the bead forms: a point on the bar's top edge (`edge`), or a free point. */
  from: { x: number; y: number; edge: boolean };
  /** The shape it ends as. */
  to: Box;
  /** A bubble becomes the message card; a row melts into a queue row. */
  kind: 'bubble' | 'row';
}

/** A late correction of the landing: everything after the snap moves by (dx, dy), eased in from `at` over `dur` ms. */
export interface Shift {
  at: number;
  dx: number;
  dy: number;
  dur: number;
}

export interface LiquidPlan {
  spec: LiquidSpec;
  /** The bead's radius. */
  r: number;
  /** The bead starts to rise out of the edge (or to swell in place). */
  born: number;
  /** The bead is whole, still joined. */
  swell: number;
  /** The neck has parted; the drop leaves. */
  snap: number;
  /** The drop touches its place and spreads. */
  land: number;
  /** The card takes over (bubble), or the sheet starts to melt (row). */
  hand: number;
  /** Nothing is left to draw. */
  end: number;
  /** Where the drop leaves from (its centre at the snap) and where it lands (its centre). */
  leave: { x: number; y: number };
  impact: { x: number; y: number };
  /** The drop's stretch when it lands (it still moves). */
  arrive: { sx: number; sy: number; vx: number; vy: number };
  /** A hop (into a queue row): how far the drop's path bows up over the straight line at its top, px (0: a straight flight). */
  arc: number;
  shifts: Shift[];
}

/** The words gather into the corner and the field closes, in this long. */
export const COLLAPSE = 180;
/** The bar's own beats: the bead starts under the edge as the words go, is whole, and parts. */
export const BORN = 158;
export const SWELL = 206;
export const SNAP = 252;
/** A bead with no edge to part from (a queue row's words) swells and leaves sooner. */
const FREE = { born: 96, swell: 176, snap: 196 };
/** From touching down to the handover (a thin queue row fills sooner), and the handover itself. */
const SPREAD = 160;
const SPREAD_ROW = 136;
export const HAND = 90;
const BEAD = 11;
/** How far over the edge the drop's centre is when it leaves (its radius plus a gap the neck has crossed). */
const LIFT_GAP = 8;
/** The drop's flight: the leaving and arriving speeds as shares of the mean (a cubic's handles). */
const LEAVE = 0.6;
const ARRIVE = 0.86;

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
export const smooth = (a: number, b: number, v: number) => {
  const u = clamp((v - a) / (b - a || 1), 0, 1);
  return u * u * (3 - 2 * u);
};
/** The bead's way out of the edge: fast out, slower while the neck holds, leaving with speed (a cubic). */
const bead = (u: number) => 3 * u * (1 - u) * (1 - u) * 0.62 + 3 * u * u * (1 - u) * 0.58 + u * u * u;
/** Out with a small overshoot (about 4 %): a bead that plops out and settles. */
const backOut = (u: number) => {
  const c = 1.25;
  const v = u - 1;
  return 1 + (c + 1) * v * v * v + c * v * v;
};

/**
 * The collapse's progress (0..1 over COLLAPSE): a critically damped spring, so the words answer the
 * key in its first frame and the bar settles softly. The field's height closes on the same curve
 * (composer.css, `linearEasing(collapseEase)`), so the words never stand outside the bar.
 */
const COLLAPSE_K = 6.2;
export const collapseEase = (u: number) => {
  const v = clamp(u, 0, 1) * COLLAPSE_K;
  return (1 - (1 + v) * Math.exp(-v)) / (1 - (1 + COLLAPSE_K) * Math.exp(-COLLAPSE_K));
};

/** The words while they gather: one uniform scale toward the corner, and how much of them shows. */
export function collapseAt(u: number): { s: number; o: number } {
  const e = collapseEase(u);
  return { s: lerp(1, 0.03, e), o: 1 - smooth(0.08, 0.62, u) };
}

/** The ease a shift comes in with (shared with the words' WAAPI correction through `linearEasing`). */
export const shiftEase = (u: number) => {
  const v = clamp(u, 0, 1);
  return v * v * v * (v * (6 * v - 15) + 10);
};

/** A JS ease as a CSS `linear()` easing, so a compositor animation follows the same curve. */
export function linearEasing(ease: (u: number) => number, n = 24): string {
  const stops: string[] = [];
  for (let i = 0; i <= n; i++) stops.push(String(Math.round(ease(i / n) * 10000) / 10000));
  return `linear(${stops.join(', ')})`;
}

/** The rise's progress (a cubic with handles LEAVE and ARRIVE: it leaves fast and arrives still moving) and its derivative. */
const riseAt = (u: number) => 3 * u * (1 - u) * (1 - u) * LEAVE + 3 * u * u * (1 - u) * ARRIVE + u * u * u;
const riseSpeed = (u: number) => 3 * LEAVE * (1 - u) * (1 - 3 * u) + 3 * ARRIVE * u * (2 - 3 * u) + 3 * u * u;

/** How long the drop flies for a trip of `dist` px: as a thrown drop, with the root of the distance (above the dock ~80 ms, from home ~130). */
export const riseMs = (dist: number) => clamp(30 + 5.5 * Math.sqrt(dist), 48, 172);

/**
 * A queued message's drop has almost no way to go (the tray's new row sits right over the bar it
 * rises from), so it hops: thrown up out of the parting neck, over the top of a small arc, and
 * down into the row, which it hits still falling (the spread takes that fall). Constant gravity:
 * the path is a parabola in time, as a thrown drop's is.
 */
export const HOP = { height: 26, ms: 120 };

/** How far the drop is stretched along its speed (px/ms): longer and thinner, about the same area. */
function stretch(v: number): { along: number; across: number } {
  const q = clamp(v * 0.17, 0, 0.42);
  return { along: 1 + q, across: 1 / Math.sqrt(1 + q) };
}

export function planLiquid(spec: LiquidSpec, shifts: Shift[] = []): LiquidPlan {
  const r = spec.kind === 'row' ? BEAD * 0.82 : BEAD;
  const beats = spec.from.edge ? { born: BORN, swell: SWELL, snap: SNAP } : FREE;
  const leave = spec.from.edge ? { x: spec.from.x, y: spec.from.y - r - LIFT_GAP } : { x: spec.from.x, y: spec.from.y };
  const { to } = spec;
  // It lands in the card's bottom-right (the tail corner: where it came from), as round as the card allows.
  const c = Math.min(to.height, to.width, 42) / 2;
  const impact = { x: to.left + to.width - c, y: to.top + to.height - c };
  const dx = impact.x - leave.x;
  const dy = impact.y - leave.y;
  const dist = Math.hypot(dx, dy);
  const arc = spec.kind === 'row' && spec.from.edge ? HOP.height : 0;
  const rise = arc ? HOP.ms : riseMs(dist);
  // Its speed as it touches down (px/ms): along the line, or down out of the hop's arc.
  const vx = arc ? dx / rise : dist > 0.01 ? (dx / dist) * ((dist * riseSpeed(1)) / rise) : 0;
  const vy = arc ? (dy + 4 * arc) / rise : dist > 0.01 ? (dy / dist) * ((dist * riseSpeed(1)) / rise) : 0;
  const v = Math.hypot(vx, vy);
  const s = stretch(v);
  const k = v > 0.0001 ? 1 / v : 0;
  const land = beats.snap + rise;
  const hand = land + (spec.kind === 'row' ? SPREAD_ROW : SPREAD);
  return {
    spec,
    r,
    ...beats,
    land,
    hand,
    end: hand + (spec.kind === 'row' ? HAND * 1.5 : HAND) + 16,
    leave,
    impact,
    // Vertical flights stretch tall; the stretch is kept per axis for the spread's start.
    arrive: { sx: lerp(s.across, s.along, Math.abs(vx) * k), sy: lerp(s.across, s.along, Math.abs(vy) * k), vx: vx || 0, vy: vy || 0 },
    arc,
    shifts,
  };
}

/** The sum of the late corrections at `t`. */
export function shiftAt(plan: LiquidPlan, t: number): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const s of plan.shifts) {
    const u = shiftEase((t - s.at) / Math.max(1, s.dur));
    x += s.dx * u;
    y += s.dy * u;
  }
  return { x, y };
}

/**
 * A spring's step response over a fixed span, as progress 0..1 for u in 0..1: `zw` (decay) and
 * `wd` (ring) in units of the span, nudged so it is exactly 1 at u = 1 (the card takes over then).
 */
export function springUnit(u: number, zw: number, wd: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const at = (v: number) => 1 - Math.exp(-zw * v) * (Math.cos(wd * v) + (zw / wd) * Math.sin(wd * v));
  return at(u) + (1 - at(1)) * u * u * u;
}

/** A push that dies out (the drop's own speed carried into an edge): px for `t` ms after leaving at `v0` px/ms. */
const momentum = (t: number, v0: number) => v0 * t * Math.exp(-t / 22);

/**
 * The spread's edges: the far one races out and goes a little past (about 3 %), the top rings
 * once with the drop's momentum, the near ones settle without fuss. All of them are exactly on
 * the card's box at the handover.
 */
const FAR = { zw: 4.6, wd: 4.3 };
const TOP = { zw: 4.2, wd: 5.6 };
const NEAR = { zw: 5.6, wd: 3.2 };

export interface Sheet {
  left: number;
  top: number;
  right: number;
  bottom: number;
  radii: Radii;
}

/** The spreading sheet at `t` (from the landing on), without the late corrections. */
export function sheetAt(plan: LiquidPlan, t: number): Sheet {
  const { to } = plan.spec;
  const { impact: I, arrive: A, r } = plan;
  const T = Math.max(0, t - plan.land);
  const u = Math.min(1, T / (plan.hand - plan.land));
  const hx = r * A.sx;
  const hy = r * A.sy;
  const right = to.left + to.width;
  const bottom = to.top + to.height;
  const go = (from: number, target: number, k: { zw: number; wd: number }, v0: number) => from + (target - from) * springUnit(u, k.zw, k.wd) + momentum(T, v0) * (1 - u);
  const L = go(I.x - hx, to.left, FAR, A.vx * 0.5);
  const R = go(I.x + hx, right, NEAR, A.vx * 0.5);
  const Tp = go(I.y - hy, to.top, TOP, A.vy);
  const B = go(I.y + hy, bottom, NEAR, A.vy * 0.35);
  const w = Math.max(0.5, R - L);
  const h = Math.max(0.5, B - Tp);
  // Round as the drop at first, the card's corners as it fills its place.
  const w0 = hx * 2;
  const p = smooth(0, 1, (w - w0) / Math.max(1, to.width - w0));
  const round = Math.min(hx, hy);
  const cap = Math.min(w, h) / 2;
  const radii = to.radii.map((rr) => Math.min(cap, lerp(round, rr, u >= 1 ? 1 : p))) as Radii;
  return { left: L, top: Tp, right: L + w, bottom: Tp + h, radii };
}

/** What to draw at `t`. All of it is one ink; `alpha` fades it as the card or row takes over. */
export interface LiquidFrame {
  /**
   * The bar's top edge while the bead is joined to it (and a moment after, while what is left on it
   * sinks back): only what stands above it is drawn, and the bead flows into it with a smooth
   * union of radius `k`.
   */
  edge?: { y: number; k: number };
  /** The bead or the drop: centre, radius, its stretch along `ang` (`sx`) and across it (`sy`). */
  drop?: { x: number; y: number; r: number; sx: number; sy: number; ang: number };
  sheet?: Sheet;
  /** The light on the ink's rim: full in the drop, the card's own quiet hairline at 0. */
  light: number;
  alpha: number;
  done: boolean;
}

const UP = -Math.PI / 2;

export function liquidAt(plan: LiquidPlan, t: number): LiquidFrame {
  const { spec, r } = plan;
  const { from } = spec;
  if (t >= plan.end) return { alpha: 0, light: 0, done: true };
  const f: LiquidFrame = { alpha: 1, light: 1, done: false };
  if (t < plan.born) return f;
  if (t < plan.snap) {
    const u = clamp((t - plan.born) / (plan.swell - plan.born), 0, 1);
    if (from.edge) {
      // Rising out of the edge in one motion (under it at first: only what is above shows): quick
      // out, held back a moment by the neck as it thins, and leaving at the speed the rise takes
      // over with. Round as soon as it is out; the meniscus narrows until it parts.
      const w = clamp((t - plan.born) / (plan.snap - plan.born), 0, 1);
      const rr = r * lerp(0.4, 1, backOut(u));
      const y = lerp(from.y + r * 0.9, plan.leave.y, bead(w));
      const along = 1 + 0.12 * smooth(0.45, 1, w);
      f.edge = { y: from.y, k: r * lerp(1.15, 0.62, smooth(0.2, 1, w)) };
      // The bar's own ink while it is part of the bar; it takes the light as it lifts away.
      f.light = smooth(plan.born + 30, plan.snap, t);
      f.drop = { x: from.x, y, r: rr, sx: along, sy: 1 / Math.sqrt(along), ang: UP };
    } else {
      // Swelling in place.
      f.drop = { x: from.x, y: from.y, r: r * lerp(0.12, 1, backOut(u)), sx: 1, sy: 1, ang: UP };
    }
    return f;
  }
  const sh = shiftAt(plan, t);
  // What is left on the edge sinks back as the drop leaves (the smooth union lets go by itself).
  if (from.edge && t < plan.snap + 60) f.edge = { y: from.y, k: r * 0.7 * (1 - smooth(plan.snap, plan.snap + 60, t)) };
  if (t < plan.land) {
    const span = plan.land - plan.snap;
    const u = (t - plan.snap) / span;
    const L = plan.leave;
    const I = plan.impact;
    const dx = I.x + sh.x - L.x;
    const dy = I.y + sh.y - L.y;
    if (plan.arc) {
      // The hop: level speed across, constant gravity down (up over the top of the arc, then falling in).
      const vx = dx / span;
      const vy = (dy - 4 * plan.arc * (1 - 2 * u)) / span;
      const s = stretch(Math.hypot(vx, vy));
      f.drop = { x: L.x + dx * u, y: L.y + dy * u - 4 * plan.arc * u * (1 - u), r, sx: s.along, sy: s.across, ang: Math.atan2(vy, vx) };
      return f;
    }
    const e = riseAt(u);
    const dist = Math.hypot(dx, dy) || 1;
    const v = (dist * riseSpeed(u)) / span;
    const s = stretch(v);
    f.drop = { x: L.x + dx * e, y: L.y + dy * e, r, sx: s.along, sy: s.across, ang: Math.atan2(dy, dx) };
    return f;
  }
  const s = sheetAt(plan, t);
  f.sheet = { left: s.left + sh.x, right: s.right + sh.x, top: s.top + sh.y, bottom: s.bottom + sh.y, radii: s.radii };
  // The drop's light thins out over the growing sheet and is the card's own at the handover.
  f.light = 1 - smooth(plan.land, plan.hand, t);
  if (spec.kind === 'row') f.alpha = 1 - smooth(plan.hand, plan.hand + HAND * 1.5, t);
  return f;
}

/**
 * The window the spreading ink reveals the words through, as a box relative to the card's place
 * (`to`): offset (x, y) and scale (sx, sy) of a clip laid over the card; the words themselves stay
 * where they will be (the clip's child is counter-scaled). `o` is how much of them shows.
 */
export function revealAt(plan: LiquidPlan, t: number): { x: number; y: number; sx: number; sy: number; o: number } {
  const { to } = plan.spec;
  if (t >= plan.hand) return { x: 0, y: 0, sx: 1, sy: 1, o: 1 };
  const s = t < plan.land ? sheetAt(plan, plan.land) : sheetAt(plan, t);
  const sx = clamp((s.right - s.left) / to.width, 0.02, 1.2);
  const sy = clamp((s.bottom - s.top) / to.height, 0.02, 1.2);
  const o = t < plan.land ? 0 : smooth(0.22, 0.8, Math.min(sx, sy));
  return { x: s.left - to.left, y: s.top - to.top, sx, sy, o };
}

/** The region the liquid can draw in (the edge, the flight, the landing, its overshoot and its shadow), with room for corrections. */
export function liquidBounds(plan: LiquidPlan, room = 90): { left: number; top: number; width: number; height: number } {
  const { from, to } = plan.spec;
  const r = plan.r * 2;
  const left = Math.min(from.x - r * 2, plan.leave.x - r, to.left - 24) - 8;
  const right = Math.max(from.x + r * 2, plan.leave.x + r, to.left + to.width + 12) + 8;
  // A hop's arc tops out about its height (plus the drop) over the higher of its two ends.
  const top = Math.min(plan.leave.y - r * 2, to.top - 24, from.y - r * 2, Math.min(plan.leave.y, plan.impact.y) - (plan.arc ?? 0) - r * 2) - room;
  const bottom = Math.max(from.y + 4, to.top + to.height + SHADOW.reach) + room;
  return { left: Math.floor(left), top: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
}

/**
 * The look of the ink: the message card's fill (`.user-card::before`) and its inner hairline, the
 * hairline lit from above while the ink is a drop (`lit`), and one soft shadow under it.
 */
export const INK = {
  fill: [20, 20, 23] as [number, number, number],
  a: 0.88,
  /** The drop's ink is a step lighter than the card's: it reads on the dark stage, and settles. */
  lift: [27, 27, 31] as [number, number, number],
  /** The hairline: the card's, and its top while lit. */
  rim: 0.08,
  lit: 0.3,
};

export const SHADOW = { y: 7, blur: 16, a: 0.5, reach: 26 };

/** The page px a frame covers, with room for its shadow and smoothing (null: nothing). */
export function frameBounds(f: LiquidFrame): { x0: number; y0: number; x1: number; y1: number } | null {
  if (f.done || f.alpha <= 0.001) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (a: number, b: number, c: number, d: number) => {
    x0 = Math.min(x0, a);
    y0 = Math.min(y0, b);
    x1 = Math.max(x1, c);
    y1 = Math.max(y1, d);
  };
  const d = f.drop;
  if (d) {
    const reach = d.r * Math.max(d.sx, d.sy) + 2;
    add(d.x - reach, d.y - reach, d.x + reach, d.y + reach);
    if (f.edge) add(d.x - d.r - f.edge.k * 1.5, d.y - reach, d.x + d.r + f.edge.k * 1.5, f.edge.y);
  }
  if (f.sheet) add(f.sheet.left, f.sheet.top, f.sheet.right, f.sheet.bottom);
  if (x0 === Infinity) return null;
  const pad = SHADOW.blur;
  const b = { x0: x0 - pad, y0: y0 - pad * 0.6, x1: x1 + pad, y1: y1 + SHADOW.reach };
  // Nothing under a bar the bead is joined to.
  if (f.edge) b.y1 = Math.min(b.y1, f.edge.y + 2);
  return b;
}
