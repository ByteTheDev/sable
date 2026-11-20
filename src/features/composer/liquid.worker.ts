import { makeRenderer, type Backdrop, type LiquidRenderer } from './liquid-gl';
import { liquidAt, planLiquid, type LiquidFrame, type LiquidPlan, type LiquidSpec, type Shift } from './liquid-shape';

/**
 * Draws sent messages as liquid (liquid-shape.ts, liquid-gl.ts) off the main thread, on canvases
 * the page hands over once, while it is idle (liquid.ts). A canvas is never resized for a message:
 * one that is new or resized only shows once the page's main thread has caught up with it, and
 * right after a send that thread is busy for a while (a session mounting, a turn starting). So the
 * drop moves at the display's rate whatever the page is doing.
 *
 * Each message is timed from its start (the page's clock, carried over as an absolute time), the
 * clock its words animate on, so the two agree without talking. Idle between messages: no frame is
 * asked for when nothing is in the air, and the last frame drawn is a clear one.
 */

export type LiquidMessage =
  /** A canvas, once, with its size in device px and the device px per page px; drawn clear at once. */
  | { type: 'layer'; id: number; canvas: OffscreenCanvas; size: { w: number; h: number }; scale: number }
  | { type: 'drop'; layer: number }
  /** A message starts on canvas `layer`, which stands at `origin` (page px); `at` is the page's absolute time of its start. */
  | { type: 'start'; id: number; layer: number; origin: { x: number; y: number }; spec: LiquidSpec; shifts: Shift[]; at: number }
  | { type: 'retarget'; id: number; spec: LiquidSpec }
  /** The message's start, corrected (the page's absolute time). */
  | { type: 'retime'; id: number; at: number }
  /** A still of the field behind message `id` (drawn on canvas `layer`), for the glass to bend; it may come before or after the start. */
  | { type: 'backdrop'; id: number; layer: number; back: Backdrop }
  | { type: 'shift'; id: number; shift: Shift }
  | { type: 'cancel'; id: number }
  /** Dev: draws every message at a fixed time after its start (null: runs on). */
  | { type: 'freeze'; t: number | null };

/**
 * Done drawing a message (`frames`: when it drew, ms after its start, for the dev console); `free`:
 * a canvas has nothing left on it; `lost`: the GPU context is gone (the page draws from then on).
 */
export type LiquidReply = { type: 'done'; id: number; frames?: number[] } | { type: 'free'; layer: number } | { type: 'lost' };

interface Host {
  layer: number;
  origin: { x: number; y: number };
  plan: LiquidPlan;
  /** The start, on this worker's clock. */
  t0: number;
  /** Cancelled: fades from this time on. */
  fade: number;
  /** Its backdrop on its canvas's renderer (0: none). */
  back: number;
  drawn: number[];
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<LiquidMessage>) => void) | null;
  postMessage: (msg: LiquidReply) => void;
  requestAnimationFrame: (cb: (now: number) => void) => number;
};

interface Layer {
  r: LiquidRenderer;
  /** Something is on it (a clear frame is owed once nothing is in the air). */
  dirty: boolean;
}

const hosts = new Map<number, Host>();
/** Backdrops that came before their message started: message id to handle. */
const early = new Map<number, { layer: number; back: number }>();
const layers = new Map<number, Layer>();
let frozen: number | null = null;
let looping = false;
let lost = false;

const FADE_OUT = 120;

/**
 * The governor: when this worker's own frames come late (a loaded machine, a weak GPU), detail is
 * shed before frames are: the bend and the soft shadow go (`lite`), the shapes and their light
 * stay. Two late frames in a row shed it for the rest of what is in the air; it comes back with
 * the next message.
 */
const LATE_MS = 26;
let lastFrame = 0;
let late = 0;
let lite = false;

scope.onmessage = (e: MessageEvent<LiquidMessage>) => {
  const m = e.data;
  switch (m.type) {
    case 'layer': {
      // Sized by the page before it was handed over (the same size for its whole life). Drawn
      // clear now: its surface is in place before any message needs it.
      const r = makeRenderer(m.canvas, m.scale);
      if (!r) return;
      layers.set(m.id, { r, dirty: false });
      break;
    }
    case 'drop':
      // Replaced (a new scale): its memory goes now, not when it is collected.
      layers.get(m.layer)?.r.dispose();
      layers.delete(m.layer);
      break;
    case 'start':
      if (!layers.has(m.layer) || lost) return scope.postMessage({ type: 'done', id: m.id });
      hosts.set(m.id, { layer: m.layer, origin: m.origin, plan: planLiquid(m.spec, m.shifts), t0: m.at - performance.timeOrigin, fade: -1, back: early.get(m.id)?.back ?? 0, drawn: [] });
      early.delete(m.id);
      loop();
      break;
    case 'backdrop': {
      const l = layers.get(m.layer);
      if (!l || lost) return m.back.bitmap.close();
      const back = l.r.backdrop(m.back);
      const h = hosts.get(m.id);
      if (h) h.back = back;
      else if (back) {
        // Never started (given up before its first frame): let go of it after a while.
        early.set(m.id, { layer: m.layer, back });
        setTimeout(() => {
          const e = early.get(m.id);
          if (!e) return;
          early.delete(m.id);
          layers.get(e.layer)?.r.release(e.back);
        }, 4000);
      }
      break;
    }
    case 'retarget': {
      const h = hosts.get(m.id);
      if (h) h.plan = planLiquid(m.spec, h.plan.shifts);
      break;
    }
    case 'retime': {
      const h = hosts.get(m.id);
      if (h) h.t0 = m.at - performance.timeOrigin;
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
  if (looping) return;
  looping = true;
  scope.requestAnimationFrame(frame);
}

function frame(now: number) {
  looping = false;
  if (lastFrame && frozen == null) {
    late = now - lastFrame > LATE_MS ? late + 1 : 0;
    if (late >= 2) lite = true;
  }
  lastFrame = now;
  const drawn = new Map<number, { frames: { f: LiquidFrame; back?: number }[]; origin: { x: number; y: number } }>();
  for (const [id, h] of hosts) {
    const t = frozen ?? now - h.t0;
    const f = liquidAt(h.plan, t);
    if (h.fade >= 0) f.alpha *= Math.min(1, Math.max(0, 1 - (t - h.fade) / FADE_OUT));
    const over = f.done || (h.fade >= 0 && t - h.fade >= FADE_OUT);
    if (over && frozen == null) {
      hosts.delete(id);
      if (h.back) layers.get(h.layer)?.r.release(h.back);
      scope.postMessage({ type: 'done', id, frames: import.meta.env.DEV ? h.drawn : undefined });
      continue;
    }
    if (import.meta.env.DEV && h.drawn.length < 80) h.drawn.push(Math.round(t));
    const d = drawn.get(h.layer) ?? { frames: [], origin: h.origin };
    d.frames.push({ f, back: h.back || undefined });
    drawn.set(h.layer, d);
  }
  for (const [id, l] of layers) {
    const d = drawn.get(id);
    if (!l.r.ok()) {
      if (!lost) {
        lost = true;
        scope.postMessage({ type: 'lost' });
      }
      continue;
    }
    if (d) {
      l.r.draw(d.frames, d.origin, lite);
      l.dirty = true;
    } else if (l.dirty) {
      // One clear frame, then the canvas is free.
      l.r.clear();
      l.dirty = false;
      scope.postMessage({ type: 'free', layer: id });
    }
  }
  if (lost) {
    for (const [id] of hosts) scope.postMessage({ type: 'done', id });
    hosts.clear();
    return;
  }
  // A canvas with nothing left on it was cleared in this frame: the next is only for messages still in the air.
  if (hosts.size && frozen == null) loop();
  else {
    lastFrame = 0;
    late = 0;
    lite = false;
  }
}
