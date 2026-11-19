import { drawLiquid, liquidAt, planLiquid, type LiquidFrame, type LiquidPlan, type LiquidSpec, type Shift } from './liquid-shape';

/**
 * Draws sent messages as liquid (liquid-shape.ts) off the main thread, on canvases the page hands
 * over once, while it is idle (liquid.ts). A canvas is never resized for a message: one that is new
 * or resized only shows once the page's main thread has caught up with it, and right after a send
 * that thread is busy for a while (a session mounting, a turn starting). So the drop moves at the
 * display's rate whatever the page is doing.
 *
 * Each message is timed from its start (the page's clock, carried over as an absolute time), the
 * clock its words animate on, so the two agree without talking. Only what was drawn is cleared.
 * Idle between messages: no frame is asked for when nothing is in the air.
 */

export type LiquidMessage =
  /** A canvas, once, with its size in device px and the device px per page px; drawn clear at once. */
  | { type: 'layer'; id: number; canvas: OffscreenCanvas; size: { w: number; h: number }; scale: number }
  | { type: 'drop'; layer: number }
  /** A message starts on canvas `layer`, which stands at `origin` (page px); `at` is the page's absolute time of its start. */
  | { type: 'start'; id: number; layer: number; origin: { x: number; y: number }; spec: LiquidSpec; shifts: Shift[]; at: number }
  | { type: 'retarget'; id: number; spec: LiquidSpec }
  | { type: 'shift'; id: number; shift: Shift }
  | { type: 'cancel'; id: number }
  /** Dev: draws every message at a fixed time after its start (null: runs on). */
  | { type: 'freeze'; t: number | null };

/** Done drawing a message (`frames`: when it drew, ms after its start, for the dev console); `free`: a canvas has nothing left on it. */
export type LiquidReply = { type: 'done'; id: number; frames?: number[] } | { type: 'free'; layer: number };

interface Host {
  layer: number;
  origin: { x: number; y: number };
  plan: LiquidPlan;
  /** The start, on this worker's clock. */
  t0: number;
  /** Cancelled: fades from this time on. */
  fade: number;
  drawn: number[];
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<LiquidMessage>) => void) | null;
  postMessage: (msg: LiquidReply) => void;
  requestAnimationFrame: (cb: (now: number) => void) => number;
};
interface Layer {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  scale: number;
  /** What the last frame drew (canvas px), to be cleared on the next. */
  dirty: Rect | null;
}

const hosts = new Map<number, Host>();
const layers = new Map<number, Layer>();
let frozen: number | null = null;
let looping = false;

const FADE_OUT = 120;

scope.onmessage = (e: MessageEvent<LiquidMessage>) => {
  const m = e.data;
  switch (m.type) {
    case 'layer': {
      // Sized by the page before it was handed over (the same size for its whole life).
      const ctx = m.canvas.getContext('2d');
      if (!ctx) return;
      // A clear frame now: the canvas's surface is in place before any message needs it.
      ctx.clearRect(0, 0, m.size.w, m.size.h);
      layers.set(m.id, { canvas: m.canvas, ctx, scale: m.scale, dirty: null });
      break;
    }
    case 'drop':
      layers.delete(m.layer);
      break;
    case 'start':
      if (!layers.has(m.layer)) return scope.postMessage({ type: 'done', id: m.id });
      hosts.set(m.id, { layer: m.layer, origin: m.origin, plan: planLiquid(m.spec, m.shifts), t0: m.at - performance.timeOrigin, fade: -1, drawn: [] });
      loop();
      break;
    case 'retarget': {
      const h = hosts.get(m.id);
      if (h) h.plan = planLiquid(m.spec, h.plan.shifts);
      break;
    }
    case 'shift':
      hosts.get(m.id)?.plan.shifts.push(m.shift);
      break;
    case 'cancel': {
      const h = hosts.get(m.id);
      if (h && h.fade < 0) h.fade = performance.now() - h.t0;
      break;
    }
    case 'freeze':
      frozen = m.t;
      loop();
      break;
  }
};

function loop() {
  if (looping || !hosts.size) return;
  looping = true;
  scope.requestAnimationFrame(frame);
}

/** The page px a frame covers, with room for its hairline and smoothing. */
function bounds(f: LiquidFrame): Rect | null {
  const r: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    r.x0 = Math.min(r.x0, x0);
    r.y0 = Math.min(r.y0, y0);
    r.x1 = Math.max(r.x1, x1);
    r.y1 = Math.max(r.y1, y1);
  };
  const d = f.drop;
  if (d) {
    const reach = d.r * Math.max(d.sx, d.sy) * 1.5 + d.tail + 2;
    add(d.x - reach, d.y - reach, d.x + reach, d.y + reach);
    if (f.edge) add(d.x - d.r * 1.6, d.y, d.x + d.r * 1.6, f.edge.y + 2);
  }
  if (f.stub) add(f.stub.x - f.stub.w - 2, f.stub.y - f.stub.h - 2, f.stub.x + f.stub.w + 2, f.stub.y + 2);
  if (f.sheet) add(f.sheet.left, f.sheet.top, f.sheet.right, f.sheet.bottom);
  if (r.x0 === Infinity) return null;
  return { x0: r.x0 - 3, y0: r.y0 - 3, x1: r.x1 + 3, y1: r.y1 + 3 };
}

const union = (a: Rect | null, b: Rect | null): Rect | null => (!a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

function frame(now: number) {
  looping = false;
  const drawn = new Map<number, { frames: LiquidFrame[]; rect: Rect | null; origin: { x: number; y: number } }>();
  for (const [id, h] of hosts) {
    const t = frozen ?? now - h.t0;
    const f = liquidAt(h.plan, t);
    if (h.fade >= 0) f.alpha *= Math.max(0, 1 - (t - h.fade) / FADE_OUT);
    const over = f.done || (h.fade >= 0 && t - h.fade >= FADE_OUT);
    if (over && frozen == null) {
      hosts.delete(id);
      scope.postMessage({ type: 'done', id, frames: import.meta.env.DEV ? h.drawn : undefined });
      continue;
    }
    if (import.meta.env.DEV && h.drawn.length < 80) h.drawn.push(Math.round(t));
    const d = drawn.get(h.layer) ?? { frames: [], rect: null, origin: h.origin };
    d.frames.push(f);
    const b = bounds(f);
    d.rect = union(d.rect, b && { x0: b.x0 - h.origin.x, y0: b.y0 - h.origin.y, x1: b.x1 - h.origin.x, y1: b.y1 - h.origin.y });
    drawn.set(h.layer, d);
  }
  for (const [id, l] of layers) {
    const d = drawn.get(id);
    if (!d && !l.dirty) continue;
    // Clear what the last frame drew and what this one will, nothing more.
    const clear = union(l.dirty, d?.rect ?? null);
    l.ctx.setTransform(l.scale, 0, 0, l.scale, 0, 0);
    if (clear) l.ctx.clearRect(clear.x0, clear.y0, clear.x1 - clear.x0, clear.y1 - clear.y0);
    l.dirty = d?.rect ?? null;
    if (!d) {
      scope.postMessage({ type: 'free', layer: id });
      continue;
    }
    l.ctx.setTransform(l.scale, 0, 0, l.scale, -d.origin.x * l.scale, -d.origin.y * l.scale);
    for (const f of d.frames) drawLiquid(l.ctx, f);
  }
  if (hosts.size && frozen == null) loop();
  else if (!hosts.size) {
    // One more frame clears what the last one drew, then the canvases are free.
    for (const l of layers.values()) if (l.dirty) return loop2();
  }
}

/** A last frame for canvases that still show something once every message is done. */
function loop2() {
  if (looping) return;
  looping = true;
  scope.requestAnimationFrame(frame);
}
