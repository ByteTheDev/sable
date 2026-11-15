import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '@/state/store';
import { FieldEngine, fieldLayout, QUALITY_CELL, RAMP, type DitherTexture, type Look, type Metrics } from './field';
import type { FieldMessage, FieldReply } from './field.worker';
import './art.css';

export type { DitherPalette, DitherTexture, DitherVariant } from './field';

/**
 * A field of light behind a surface (see `field.ts` for how it is drawn). It renders in a
 * shared Web Worker on an OffscreenCanvas, so the main thread only measures, forwards the
 * pointer and says when the field may run; where that is unavailable, the same engine runs
 * here. It stops while hidden, scrolled away, covered by a dialog or the window is not focused,
 * and is a single still frame with `still`.
 *
 * One canvas lives as long as the component: texture, cell size, image, motion and look all
 * reach the engine as messages (a canvas handed to a worker cannot be taken back anyway).
 *
 * Adaptive quality: each engine steps itself down when the machine is busy (see FieldEngine in
 * field.ts). The main thread's share of that judgement comes from here: one shared observer of
 * long animation frames (long tasks where unsupported), summed per second and sent to every
 * running field as "pressure"; its 1 s timer runs only while some field is animating. When a
 * field reports a new level, the stage is re-sized with coarser cells (QUALITY_CELL) and the
 * level is mirrored on <html data-quality> so CSS can shed costly effects too.
 */

// ── the shared worker ──

/** How long an unused worker lingers, so moving between screens does not restart it. */
const WORKER_LINGER = 10_000;

let worker: Worker | null = null;
let workerBroken = false;
let users = 0;
let lingerTimer = 0;
let nextId = 0;
const replies = new Map<number, (r: FieldReply) => void>();
const onBroken = new Set<() => void>();

function acquireWorker(): Worker | null {
  if (workerBroken || typeof Worker !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./field.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      workerBroken = true;
      return null;
    }
    worker.onmessage = (e: MessageEvent<FieldReply>) => replies.get(e.data.id)?.(e.data);
    worker.onerror = () => {
      // Every field falls back to drawing on the main thread.
      workerBroken = true;
      worker?.terminate();
      worker = null;
      users = 0;
      replies.clear();
      for (const f of [...onBroken]) f();
    };
  }
  clearTimeout(lingerTimer);
  users++;
  return worker;
}

function releaseWorker() {
  if (--users > 0) return;
  users = 0;
  clearTimeout(lingerTimer);
  lingerTimer = window.setTimeout(() => {
    if (users > 0 || !worker) return;
    worker.terminate();
    worker = null;
  }, WORKER_LINGER);
}

// ── main-thread load, shared by every animating field ──

const loadListeners = new Set<(ms: number) => void>();
let loadObserver: PerformanceObserver | null = null;
/** Slow input events: presentation back-pressure shows up here, not as long animation frames. */
let eventObserver: PerformanceObserver | null = null;
let loadTimer = 0;
let loadMs = 0;
let loadSent = 0;

function watchLoad(fn: (ms: number) => void) {
  loadListeners.add(fn);
  if (loadListeners.size === 1) {
    const types = typeof PerformanceObserver === 'function' ? (PerformanceObserver.supportedEntryTypes ?? []) : [];
    const type = types.includes('long-animation-frame') ? 'long-animation-frame' : types.includes('longtask') ? 'longtask' : '';
    if (type) {
      loadObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) loadMs += e.duration;
      });
      try {
        loadObserver.observe({ type, buffered: false });
      } catch {
        loadObserver = null;
      }
    }
    if (types.includes('event')) {
      eventObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) loadMs += e.duration;
      });
      try {
        eventObserver.observe({ type: 'event', durationThreshold: 104, buffered: false } as PerformanceObserverInit);
      } catch {
        eventObserver = null;
      }
    }
    loadTimer = window.setInterval(() => {
      const ms = Math.round(loadMs);
      loadMs = 0;
      probeFrames();
      // A quiet second is sent once, then nothing until there is load again.
      if (ms === 0 && loadSent === 0) return;
      loadSent = ms;
      for (const l of loadListeners) l(ms);
    }, 1000);
  }
  return () => {
    loadListeners.delete(fn);
    if (loadListeners.size) return;
    loadObserver?.disconnect();
    loadObserver = null;
    eventObserver?.disconnect();
    eventObserver = null;
    clearInterval(loadTimer);
    loadMs = loadSent = 0;
  };
}

/**
 * A late compositor (a busy GPU, or a page that takes long to draw) does not show up as long
 * animation frames, so once a second a few frames are timed with rAF: every gap well past a
 * frame counts as load. Eight frames a second, nothing in between.
 */
let probing = false;
function probeFrames() {
  if (probing || document.hidden) return;
  probing = true;
  let last = 0;
  let n = 0;
  const step = (t: number) => {
    if (last && t - last > 50) loadMs += t - last - 16.7;
    last = t;
    if (++n < 8 && loadListeners.size) requestAnimationFrame(step);
    else probing = false;
  };
  requestAnimationFrame(step);
}

/** The lowest quality any field is at, on <html data-quality> (absent at full quality). */
const levels = new Map<number, number>();
function publishQuality(id: number, level: number | null) {
  if (level == null || level === 0) levels.delete(id);
  else levels.set(id, level);
  const worst = Math.max(0, ...levels.values());
  if (worst) document.documentElement.dataset.quality = String(worst);
  else delete document.documentElement.dataset.quality;
}

// ── glyph atlas (needs the page's fonts, so it is drawn here and handed to the engine) ──

const atlases = new Map<string, Promise<ImageBitmap | HTMLCanvasElement>>();

/** White glyphs on transparent, one device-pixel cell each, side by side. */
function glyphAtlas(gw: number, gh: number, dpr: number, font: number) {
  const key = `${gw}x${gh}@${dpr}/${font}`;
  let p = atlases.get(key);
  if (!p) {
    const family = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace';
    p = (document.fonts?.load(`${font}px ${family}`) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        const c = document.createElement('canvas');
        c.width = gw * RAMP.length;
        c.height = gh;
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#fff';
          ctx.font = `${font * dpr}px ${family}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          for (let i = 1; i < RAMP.length; i++) ctx.fillText(RAMP[i], i * gw + gw / 2, gh / 2 + dpr * 0.5);
        }
        return typeof createImageBitmap === 'function' ? createImageBitmap(c).catch(() => c) : c;
      });
    atlases.set(key, p);
  }
  return p;
}

// ── component ──

interface Port {
  resize(m: Metrics, atlas?: ImageBitmap | HTMLCanvasElement): void;
  look(look: Look): void;
  pointer(p: [number, number] | null): void;
  pulse(x: number, y: number, strength: number): void;
  state(animate: boolean, running: boolean): void;
  pressure(ms: number): void;
  texture(t: DitherTexture): void;
  image(b: ImageBitmap | null): void;
  dispose(): void;
}

interface Props extends Partial<Omit<Look, 'pointer'>> {
  /** Cell size in CSS pixels (dither texture); large stages may use coarser cells. */
  cell?: number;
  /** Draw hairline gaps between cells (dither texture). */
  grid?: boolean;
  /** How the field is drawn (default dither). */
  texture?: DitherTexture;
  /** Let the vanishing point lean a few percent toward the pointer (animated fields only). */
  pointer?: boolean;
  /** One frame, then nothing until the size or look changes. */
  still?: boolean;
  /** Swell with `sable:pulse` (animated fields only; default on). */
  react?: boolean;
  /** An image drawn in place of the pattern. */
  image?: ImageBitmap | null;
  opacity?: number;
  className?: string;
}

/** A window that has lost focus for this long stops drawing until it is back (a short grace, so a
 * focus hop into the panel browser or a native dialog does not flicker the field). */
const PARK_AFTER_BLUR = 400;
let fieldIds = 0;
/** Pointer updates sent to the field at most this often (ms); the field eases toward them anyway. */
const POINTER_MS = 40;

export function DitherField({
  variant = 'bloom',
  palette = 'ember',
  cell = 6,
  focus = [0.74, 0.68],
  gain = 1,
  speed = 1,
  seed = 3.7,
  full = false,
  grid = true,
  texture = 'dither',
  pointer = false,
  still = false,
  react = true,
  image = null,
  opacity = 1,
  className,
  spot,
  angle,
  hue,
  sat,
  imageColour,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  // A dialog over the app hides (and blurs) the page's fields: they hold still underneath it.
  const covered = useStore((s) => !!(s.ui.settings || s.ui.paletteOpen || s.ui.historyOpen || s.ui.projectPicker));
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const syncRef = useRef<() => void>(() => {});
  const port = useRef<Port | null>(null);
  const tex = texture;
  const [ready, setReady] = useState(false);
  // Bumped when the worker fails, so every field rebuilds on the main thread.
  const [gen, setGen] = useState(0);
  const look: Look = { variant, palette, focus, gain, speed, seed, full, spot, angle, hue, sat, imageColour };
  const live = useRef(look);
  live.current = look;
  // What the running effect reads when it (re)lays out or decides whether to move.
  const cellRef = useRef(cell);
  cellRef.current = cell;
  const texRef = useRef(tex);
  texRef.current = tex;
  const imageRef = useRef(image);
  imageRef.current = image;
  const animate = !still;
  const animRef = useRef(animate);
  animRef.current = animate;
  const pointerRef = useRef(pointer);
  pointerRef.current = pointer;
  const reactRef = useRef(react);
  reactRef.current = react;
  const relayout = useRef<() => void>(() => {});
  /** What the engine was last given, so a message goes out only when it changes. */
  const sent = useRef<{ tex: DitherTexture; image: ImageBitmap | null }>({ tex, image });

  useEffect(() => {
    const bump = () => setGen((g) => g + 1);
    onBroken.add(bump);
    return () => {
      onBroken.delete(bump);
    };
  }, []);

  useEffect(() => {
    const host = wrap.current;
    if (!host) return;
    // A canvas handed to a worker cannot be taken back, so each run (mount, or the worker failing) starts with a fresh one.
    const el = document.createElement('canvas');
    host.appendChild(el);
    let disposed = false;
    const fid = ++fieldIds;
    let quality = 0;
    const onQuality = (level: number) => {
      if (disposed || level === quality) return;
      quality = level;
      host.dataset.quality = String(level);
      publishQuality(fid, level);
      resize();
    };
    const onFrame = (first: boolean, ms: number | null) => {
      if (disposed) return;
      if (first) setReady(true);
      // Frame cost, for tuning: document.querySelector('.dither').dataset.ms
      if (import.meta.env.DEV && ms != null) host.dataset.ms = ms.toFixed(2);
    };

    const forceMain = import.meta.env.DEV && !!(window as unknown as { __sableFieldMainThread?: boolean }).__sableFieldMainThread;
    const w = !forceMain && 'transferControlToOffscreen' in el ? acquireWorker() : null;
    let p: Port;
    if (w) {
      const id = ++nextId;
      const post = (m: FieldMessage, transfer?: Transferable[]) => w.postMessage(m, transfer ?? []);
      const off = el.transferControlToOffscreen();
      replies.set(id, (r) => (r.quality != null ? onQuality(r.quality) : onFrame(r.first, r.ms)));
      post({ type: 'init', id, canvas: off, texture: texRef.current, look: live.current }, [off]);
      if (imageRef.current) post({ type: 'image', id, image: imageRef.current });
      host.dataset.thread = 'worker';
      p = {
        resize: (metrics, atlas) => post({ type: 'resize', id, metrics, atlas: atlas as ImageBitmap | undefined }),
        look: (l) => post({ type: 'look', id, look: l }),
        pointer: (pt) => post({ type: 'pointer', id, pointer: pt }),
        pulse: (x, y, strength) => post({ type: 'pulse', id, x, y, strength }),
        state: (animate, running) => post({ type: 'state', id, animate, running }),
        pressure: (ms) => post({ type: 'pressure', id, ms }),
        texture: (t) => post({ type: 'texture', id, texture: t }),
        image: (b) => post({ type: 'image', id, image: b }),
        dispose: () => {
          post({ type: 'dispose', id });
          replies.delete(id);
          releaseWorker();
        },
      };
    } else {
      const engine = FieldEngine.create(el, texRef.current, live.current, { frame: onFrame, quality: onQuality });
      if (!engine) {
        el.remove();
        return;
      }
      if (imageRef.current) engine.setImage(imageRef.current);
      host.dataset.thread = 'main';
      p = {
        resize: (m, a) => engine.resize(m, a),
        look: (l) => engine.setLook(l),
        pointer: (pt) => engine.setPointer(pt),
        pulse: (x, y, strength) => engine.pulse(x, y, strength),
        state: (a, r) => engine.setState(a, r),
        pressure: (ms) => engine.setPressure(ms),
        texture: (t) => engine.setTexture(t),
        image: (b) => engine.setImage(b),
        dispose: () => engine.dispose(),
      };
    }
    port.current = p;
    sent.current = { tex: texRef.current, image: imageRef.current };

    // ── size: the canvas element is sized to whole cells, so the grid overlay lines up ──
    let rect = host.getBoundingClientRect();
    let metrics: Metrics = { width: 0, height: 0, dpr: 1, cell };
    let atlasKey = '';
    let layoutKey = '';
    // A declaration, so the quality handler above can call it.
    function resize() {
      if (!host) return;
      rect = host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      // Lower quality levels draw coarser cells.
      const c = Math.round(cellRef.current * QUALITY_CELL[quality]);
      const t = texRef.current;
      const img = imageRef.current != null;
      const key = `${t}/${img}`;
      if (key === layoutKey && rect.width === metrics.width && rect.height === metrics.height && dpr === metrics.dpr && c === metrics.cell) return;
      layoutKey = key;
      metrics = { width: rect.width, height: rect.height, dpr, cell: c };
      const L = fieldLayout(t, img, rect.width, rect.height, dpr, c);
      el.style.width = `${L.cssW}px`;
      el.style.height = `${L.cssH}px`;
      host.style.setProperty('--cell', `${L.cell}px`);
      p.resize(metrics);
      const A = L.atlas;
      if (!A) return;
      const k = `${A.gw}x${A.gh}@${A.dpr}/${A.font}`;
      if (k === atlasKey) return;
      atlasKey = k;
      void glyphAtlas(A.gw, A.gh, A.dpr, A.font).then((atlas) => {
        if (!disposed && atlasKey === k) p.resize(metrics, atlas);
      });
    }
    relayout.current = resize;
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // ── when it may run ──
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    // Fields inside a dialog are what it shows; only the page's own fields hold still under one.
    const inDialog = !!host.closest('[role="dialog"]');
    let visible = true;
    let parked = false;
    let parkTimer = 0;
    let running: boolean | null = null;
    let moving: boolean | null = null;
    let unwatch: (() => void) | null = null;
    const sync = () => {
      const next = visible && !document.hidden && !parked && !(!inDialog && coveredRef.current);
      const animate = animRef.current && !reduced.matches;
      if (next === running && animate === moving) return;
      running = next;
      moving = animate;
      p.state(animate, next);
      // Main-thread load only matters (and is only watched) while the field is moving.
      if (next && animate && !unwatch) unwatch = watchLoad((ms) => p.pressure(ms));
      else if (!(next && animate) && unwatch) {
        unwatch();
        unwatch = null;
      }
    };
    syncRef.current = sync;
    sync();

    const io = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
      sync();
    });
    io.observe(host);
    // Focus moving into the panel browser (a <webview>) blurs the page, but the app is still in use.
    const inApp = () => document.activeElement?.tagName === 'WEBVIEW';
    const onBlur = () => {
      clearTimeout(parkTimer);
      parkTimer = window.setTimeout(() => {
        if (inApp()) return;
        parked = true;
        sync();
      }, PARK_AFTER_BLUR);
    };
    const onFocus = () => {
      clearTimeout(parkTimer);
      parked = false;
      sync();
    };
    window.addEventListener('blur', onBlur);
    // Opened without focus (a background window): hold still until it is focused.
    if (!document.hasFocus()) onBlur();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', sync);

    // The vanishing point follows the pointer by a few percent (eased inside the field).
    let aim: [number, number] | null = null;
    let lastSent = 0;
    let pending = 0;
    const flush = () => {
      pending = 0;
      lastSent = performance.now();
      p.pointer(aim);
    };
    const onPointer = (e: PointerEvent) => {
      if (!pointerRef.current || !moving || !rect.width || !rect.height) return;
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      aim = [x < -0.5 ? -0.5 : x > 0.5 ? 0.5 : x, y < -0.5 ? -0.5 : y > 0.5 ? 0.5 : y];
      if (pending) return;
      const wait = POINTER_MS - (performance.now() - lastSent);
      if (wait <= 0) flush();
      else pending = window.setTimeout(flush, wait);
    };
    // Listening costs nothing until the pointer moves; the handler checks whether the field follows.
    window.addEventListener('pointermove', onPointer, { passive: true });

    // A pulse (sable:pulse, viewport coordinates): a swell of light travelling outward from that
    // point. Only a moving field that reacts answers, so still fields and reduced motion stay still.
    const onPulse = (e: Event) => {
      const d = (e as CustomEvent<{ x: number; y: number; strength?: number }>).detail;
      if (!d || !running || !moving || !reactRef.current) return;
      rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      p.pulse((d.x - rect.left) / rect.width, (d.y - rect.top) / rect.height, d.strength ?? 1);
    };
    window.addEventListener('sable:pulse', onPulse);

    return () => {
      disposed = true;
      unwatch?.();
      publishQuality(fid, null);
      p.dispose();
      port.current = null;
      syncRef.current = () => {};
      clearTimeout(parkTimer);
      clearTimeout(pending);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('sable:pulse', onPulse);
      relayout.current = () => {};
      el.remove();
    };
  }, [gen]);

  // Texture and image first, then the layout for them (effects run in this order).
  useEffect(() => {
    if (!port.current || sent.current.tex === tex) return;
    sent.current.tex = tex;
    port.current.texture(tex);
  }, [tex]);

  useEffect(() => {
    if (!port.current || sent.current.image === image) return;
    sent.current.image = image;
    port.current.image(image);
  }, [image]);

  useEffect(() => {
    relayout.current();
  }, [tex, cell, image != null]);

  useEffect(() => {
    syncRef.current();
  }, [animate]);

  useEffect(() => {
    if (!pointer) port.current?.pointer(null);
  }, [pointer]);

  useEffect(() => {
    port.current?.look(live.current);
  }, [variant, palette, focus[0], focus[1], gain, speed, seed, full, spot?.[0], spot?.[1], spot?.[2], angle, hue, sat, imageColour]);

  useEffect(() => {
    syncRef.current();
  }, [covered]);

  const style = { '--cell': `${cell}px`, '--dither-opacity': opacity } as CSSProperties;
  return <div ref={wrap} className={`dither ${grid && tex === 'dither' ? 'dither-grid' : ''} ${className ?? ''}`} data-texture={tex} data-ready={ready} style={style} aria-hidden />;
}
