// The send's liquid geometry, a copy of the desktop's src/features/composer/liquid-shape.ts as committed with
// "Send as liquid" (the desktop has since moved to a renderer of its own); the phone keeps this one.

/**
 * A sent message as liquid: the geometry over time, pure. The worker that draws it
 * (liquid.worker.ts), the main thread that moves the words with it (flight.ts) and the tests all
 * read the same numbers, so the silhouette and the words agree in every frame without talking.
 *
 * The beats (ms after the key):
 * - swell (0 to SWELL): the words pour into the bar's top-right corner and a bead of the bar's
 *   own ink swells out of its top edge there, joined to it by a wide meniscus;
 * - pinch (SWELL to SNAP): the bead lifts, the meniscus draws into a neck that thins and breaks;
 *   a short tail on the bead and a stub on the edge pull back in;
 * - rise (SNAP to land): the drop flies to the bottom-right of where the message will sit,
 *   stretched along its speed, leaving fast and arriving still moving;
 * - spread (land to hand): it touches down and spreads into the card's shape, each edge on its own
 *   spring (the top one carries the drop's momentum a little past, the far edge races out and
 *   settles), the corners easing from round to the card's, the tail corner last;
 * - hand (hand to end): the conversation's own card takes over (a bubble), or the sheet melts into
 *   the queue row it landed on (a row).
 *
 * A bead with no edge (words leaving a queue row) simply grows where the words gathered.
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
  /** The neck breaks; the drop leaves. */
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
  shifts: Shift[];
}

export const SWELL = 118;
export const SNAP = 172;
/** A bead with no edge to break from leaves sooner. */
const FREE_SNAP = 115;
/** From touching down to the handover, and the handover itself. */
const SPREAD = 150;
export const HAND = 90;
const BEAD = 9.5;
/** The drop's flight: the leaving and arriving speeds as shares of the mean (a cubic's handles). */
const LEAVE = 0.6;
const ARRIVE = 0.86;

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
export const smooth = (a: number, b: number, v: number) => {
  const u = clamp((v - a) / (b - a || 1), 0, 1);
  return u * u * (3 - 2 * u);
};
const easeOut3 = (u: number) => 1 - (1 - u) ** 3;
const easeIn2 = (u: number) => u * u;

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

/** How long the drop flies for a trip of `dist` px: as a thrown drop, with the root of the distance (a hop into the tray ~55 ms, above the dock ~80, from home ~130). */
export const riseMs = (dist: number) => clamp(30 + 5.5 * Math.sqrt(dist), 48, 172);

/** How far the drop is stretched along its speed (px/ms): longer and thinner, about the same area. */
function stretch(v: number): { along: number; across: number } {
  const q = clamp(v * 0.17, 0, 0.42);
  return { along: 1 + q, across: 1 / Math.sqrt(1 + q) };
}

export function planLiquid(spec: LiquidSpec, shifts: Shift[] = []): LiquidPlan {
  const r = spec.kind === 'row' ? BEAD * 0.86 : BEAD;
  const snap = spec.from.edge ? SNAP : FREE_SNAP;
  const leave = spec.from.edge ? { x: spec.from.x, y: spec.from.y - r - 6 } : { x: spec.from.x, y: spec.from.y };
  const { to } = spec;
  // It lands in the card's bottom-right (the tail corner: where it came from), as round as the card allows.
  const c = Math.min(to.height, to.width, 42) / 2;
  const impact = { x: to.left + to.width - c, y: to.top + to.height - c };
  const dx = impact.x - leave.x;
  const dy = impact.y - leave.y;
  const dist = Math.hypot(dx, dy);
  const rise = riseMs(dist);
  const v = (dist * riseSpeed(1)) / rise;
  const s = stretch(v);
  const k = dist > 0.01 ? 1 / dist : 0;
  const land = snap + rise;
  const hand = land + SPREAD;
  return {
    spec,
    r,
    snap,
    land,
    hand,
    end: hand + (spec.kind === 'row' ? HAND * 1.5 : HAND) + 16,
    leave,
    impact,
    // Vertical flights stretch tall; the stretch is kept per axis for the spread's start.
    arrive: { sx: lerp(s.across, s.along, Math.abs(dx) * k), sy: lerp(s.across, s.along, Math.abs(dy) * k), vx: (dx * k * v) || 0, vy: (dy * k * v) || 0 },
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
  /** The bar's edge under a bead that is still joined to it. */
  edge?: { y: number; clip: boolean };
  /** The bead (joined) or the drop (free): centre, radius and stretch; `tail` the pointed end it trails while the break pulls back. */
  drop?: { x: number; y: number; r: number; sx: number; sy: number; tail: number; tx: number; ty: number };
  /** The neck to the edge: 0..1, wide meniscus to broken. */
  neck?: number;
  /** The stub left on the edge after the break, settling back: its height and half width. */
  stub?: { x: number; y: number; h: number; w: number; round: number };
  sheet?: Sheet;
  /** The words' light in the ink: full in the drop, diluted as it spreads over the card. */
  glow: number;
  alpha: number;
  done: boolean;
}

export function liquidAt(plan: LiquidPlan, t: number): LiquidFrame {
  const { spec, r } = plan;
  const { from } = spec;
  if (t >= plan.end) return { alpha: 0, glow: 0, done: true };
  const f: LiquidFrame = { alpha: 1, glow: 1, done: false };
  if (t < plan.snap) {
    if (from.edge) {
      // Swelling out of the edge as the words pour in, then lifting on a neck that thins.
      const e = smooth(0, 1, clamp(t / SWELL, 0, 1) ** 0.75);
      const rr = r * lerp(0.3, 1, e);
      const u = clamp((t - SWELL) / (plan.snap - SWELL), 0, 1);
      const lift = t < SWELL ? lerp(0.55 * r, -0.3 * r, e) : lerp(-0.3 * r, plan.leave.y - from.y, easeIn2(u));
      f.edge = { y: from.y, clip: true };
      f.glow = smooth(0, SWELL, t);
      f.drop = { x: from.x, y: from.y + lift, r: rr, sx: 1, sy: 1 + 0.08 * u, tail: 0, tx: 0, ty: 1 };
      f.neck = 1 - u ** 1.25;
    } else {
      // Gathering in place.
      const e = easeOut3(clamp(t / (plan.snap - 10), 0, 1));
      f.drop = { x: from.x, y: from.y, r: r * lerp(0.15, 1, e), sx: 1, sy: 1, tail: 0, tx: 0, ty: 1 };
    }
    return f;
  }
  const sh = shiftAt(plan, t);
  if (from.edge && t < plan.snap + 110) {
    // The stub pulls back into the edge: pointed at first, rounding off as it sinks.
    const u = (t - plan.snap) / 110;
    f.stub = { x: from.x, y: from.y, h: r * 0.62 * (1 - easeOut3(u)), w: r * lerp(0.75, 1.1, u), round: smooth(0, 0.6, u) };
  }
  if (t < plan.land) {
    const u = (t - plan.snap) / (plan.land - plan.snap);
    const e = riseAt(u);
    const L = plan.leave;
    const I = plan.impact;
    const dx = I.x + sh.x - L.x;
    const dy = I.y + sh.y - L.y;
    const dist = Math.hypot(dx, dy) || 1;
    const v = (dist * riseSpeed(u)) / (plan.land - plan.snap);
    const s = stretch(v);
    const ax = Math.abs(dx) / dist;
    const ay = Math.abs(dy) / dist;
    // The broken neck trails as a pointed tail for a moment, pulled back into the round.
    const tail = from.edge ? r * 0.95 * (1 - smooth(0, 1, (t - plan.snap) / 75)) : 0;
    f.drop = { x: L.x + dx * e, y: L.y + dy * e, r, sx: lerp(s.across, s.along, ax), sy: lerp(s.across, s.along, ay), tail, tx: -dx / dist, ty: -dy / dist };
    return f;
  }
  const s = sheetAt(plan, t);
  f.sheet = { left: s.left + sh.x, right: s.right + sh.x, top: s.top + sh.y, bottom: s.bottom + sh.y, radii: s.radii };
  // The same light over a growing area: it thins out as the sheet spreads, and is gone as the
  // sheet reaches the card's size (a gentle curve, so the spread itself stays visible).
  const drop = Math.PI * plan.r * plan.r * plan.arrive.sx * plan.arrive.sy;
  const area = Math.max(drop, (s.right - s.left) * (s.bottom - s.top));
  const full = Math.max(drop, spec.to.width * spec.to.height);
  const k = (a: number) => (drop / a) ** 0.32;
  f.glow = clamp((k(area) - k(full)) / Math.max(0.01, 1 - k(full)), 0, 1);
  if (spec.kind === 'row') f.alpha = 1 - smooth(plan.hand, plan.hand + HAND * 1.5, t);
  return f;
}

/**
 * Where the words sit inside the sheet at `t` (the card's content, laid out at `to`): one uniform
 * scale that fits the sheet, centred in it, and how much they show. For the words' keyframes.
 */
export function wordsAt(plan: LiquidPlan, t: number): { x: number; y: number; s: number; o: number } {
  const { to } = plan.spec;
  if (t < plan.land) return { x: plan.impact.x - to.left - 1, y: plan.impact.y - to.top - 1, s: 0.02, o: 0 };
  const sh = sheetAt(plan, t);
  const s = clamp(Math.min((sh.right - sh.left) / to.width, (sh.bottom - sh.top) / to.height), 0.02, 1);
  const cx = (sh.left + sh.right) / 2;
  const cy = (sh.top + sh.bottom) / 2;
  return { x: cx - (to.width * s) / 2 - to.left, y: cy - (to.height * s) / 2 - to.top, s, o: smooth(0.32, 0.8, s) };
}

/** The region the liquid can draw in (the edge, the flight, the landing and its overshoot), with room for corrections. */
export function liquidBounds(plan: LiquidPlan, room = 90): { left: number; top: number; width: number; height: number } {
  const { from, to } = plan.spec;
  const r = plan.r * 2;
  const left = Math.min(from.x - r * 2, plan.leave.x - r, to.left - 24) - 8;
  const right = Math.max(from.x + r * 2, plan.leave.x + r, to.left + to.width + 12) + 8;
  const top = Math.min(plan.leave.y - r * 2, to.top - 24, from.y - r * 2) - room;
  const bottom = Math.max(from.y + 4, to.top + to.height + 16) + room;
  return { left: Math.floor(left), top: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
}

/**
 * The look of the ink: the message card's fill and inner hairline (`base`), lifted toward the
 * words' ivory by the frame's glow (`lit`), so the drop that carries them reads on a dark stage
 * and the sheet ends as the card's own ink.
 */
export interface Ink {
  base: { rgb: [number, number, number]; a: number; rim: number };
  lit: { rgb: [number, number, number]; a: number; rim: number };
}

export const INK: Ink = {
  base: { rgb: [18, 18, 21], a: 0.94, rim: 0.08 },
  lit: { rgb: [52, 51, 52], a: 0.97, rim: 0.34 },
};

function inkAt(ink: Ink, g: number): { fill: string; rim: string } {
  const c = ink.base.rgb.map((v, i) => Math.round(lerp(v, ink.lit.rgb[i], g)));
  return { fill: `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${lerp(ink.base.a, ink.lit.a, g).toFixed(3)})`, rim: `rgba(242, 241, 238, ${lerp(ink.base.rim, ink.lit.rim, g).toFixed(3)})` };
}

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** The joined bead: the meniscus from the edge rising into a neck that holds the round bead. */
function neckPath(p: Path2D, x: number, e: number, d: NonNullable<LiquidFrame['drop']>, s: number) {
  const r = d.r;
  const rx = r * d.sx;
  const ry = r * d.sy;
  // Where the neck meets the bead (an angle up from its bottom) and how wide it stands on the edge.
  const th = lerp(0.3, 1.38, s);
  const a = r * lerp(0.22, 1.35, s);
  const p1x = x - rx * Math.sin(th);
  const p1y = d.y + ry * Math.cos(th);
  const p2x = x + rx * Math.sin(th);
  const h = Math.max(0, e - p1y);
  // The meniscus leaves the edge flat, then curls up into the bead's side along its tangent.
  const c1 = Math.min(a * 0.62, h * 0.9 + 1);
  const c2 = h * 0.42 + r * 0.12;
  const tx = Math.cos(th);
  const ty = Math.sin(th);
  p.moveTo(x - a - 1, e + 1.5);
  p.lineTo(x - a, e);
  p.bezierCurveTo(x - a + c1, e, p1x + tx * c2, p1y + ty * c2, p1x, p1y);
  p.ellipse(x, d.y, rx, ry, 0, Math.PI / 2 + th, Math.PI * 2.5 - th);
  p.bezierCurveTo(p2x - tx * c2, p1y + ty * c2, x + a - c1, e, x + a, e);
  p.lineTo(x + a + 1, e + 1.5);
  p.closePath();
}

/** A free drop: an ellipse along its flight, trailing a pointed tail while the break pulls back. */
function dropPath(p: Path2D, d: NonNullable<LiquidFrame['drop']>) {
  const rx = d.r * d.sx;
  const ry = d.r * d.sy;
  if (d.tail < 0.3) {
    p.ellipse(d.x, d.y, rx, ry, 0, 0, Math.PI * 2);
    return;
  }
  // The tail points back along the flight (straight down for a rise): the round's lower half
  // draws into a point.
  const ang = Math.atan2(d.ty, d.tx);
  const tip = { x: d.x + d.tx * (ry + d.tail), y: d.y + d.ty * (ry + d.tail) };
  const side = ang + Math.PI / 2;
  const sx = Math.cos(side);
  const sy = Math.sin(side);
  const k = 0.62;
  p.moveTo(d.x + sx * rx, d.y + sy * ry);
  p.ellipse(d.x, d.y, rx, ry, 0, side, side + Math.PI);
  p.bezierCurveTo(d.x - sx * rx + d.tx * ry * k, d.y - sy * ry + d.ty * ry * k, tip.x - sx * rx * 0.18, tip.y - sy * ry * 0.18, tip.x, tip.y);
  p.bezierCurveTo(tip.x + sx * rx * 0.18, tip.y + sy * ry * 0.18, d.x + sx * rx + d.tx * ry * k, d.y + sy * ry + d.ty * ry * k, d.x + sx * rx, d.y + sy * ry);
  p.closePath();
}

/** The stub on the edge: a small dome with a pointed top that rounds off as it sinks back. */
function stubPath(p: Path2D, st: NonNullable<LiquidFrame['stub']>) {
  if (st.h < 0.25) return;
  const { x, y, h, w, round } = st;
  const k = lerp(0.06, 0.42, round);
  p.moveTo(x - w - 1, y + 1.5);
  p.lineTo(x - w, y);
  p.bezierCurveTo(x - w * 0.5, y, x - w * k, y - h * lerp(0.75, 1, round), x, y - h);
  p.bezierCurveTo(x + w * k, y - h * lerp(0.75, 1, round), x + w * 0.5, y, x + w, y);
  p.lineTo(x + w + 1, y + 1.5);
  p.closePath();
}

/**
 * Draws one frame into `ctx` (already cleared and set to page coordinates by the caller). The
 * ink is filled once per frame as one path, so the overlapping parts never double up, and its
 * hairline is drawn inside the shape only (clipped), like the card's inset edge.
 */
export function drawLiquid(ctx: Ctx2D, f: LiquidFrame, ink: Ink = INK) {
  if (f.done || f.alpha <= 0.001) return;
  const p = new Path2D();
  if (f.drop && f.neck != null && f.edge) neckPath(p, f.drop.x, f.edge.y, f.drop, f.neck);
  else if (f.drop) dropPath(p, f.drop);
  if (f.stub) stubPath(p, f.stub);
  if (f.sheet) {
    const s = f.sheet;
    p.roundRect(s.left, s.top, s.right - s.left, s.bottom - s.top, s.radii);
  }
  ctx.save();
  ctx.globalAlpha = f.alpha;
  if (f.edge?.clip) {
    // Joined to the bar: only what stands above its edge shows (the bar itself is the composer).
    ctx.beginPath();
    ctx.rect(-1e5, -1e5, 2e5, 1e5 + f.edge.y + 0.5);
    ctx.clip();
  }
  const look = inkAt(ink, f.glow);
  ctx.fillStyle = look.fill;
  ctx.fill(p);
  ctx.clip(p);
  ctx.lineWidth = 2;
  ctx.strokeStyle = look.rim;
  ctx.stroke(p);
  ctx.restore();
}
