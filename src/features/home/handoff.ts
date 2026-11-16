import { reducedMotion, uiZoom } from '@/lib/motion';

/**
 * The home-to-session hand-off: sending the first message from the home screen is one motion.
 *
 * On send, the home composer card is copied into a fixed layer above the stage (the "ghost") and
 * the real card hides. The ghost glides on a spring (about 450 ms) from the centre of the home
 * screen to where the session's docked composer will sit, predicted from the stage's geometry, so
 * it moves at once even though the session does not exist yet. When the session view mounts, its
 * composer claims the flight: the spring is re-aimed at the real card (keeping its velocity), the
 * real card stays hidden until the ghost lands on it, and then the two swap in one frame.
 * Meanwhile the headline dissolves upward and the home view (with its backdrop) fades out while the
 * session's quiet band fades in (App reads `handoffActive()` for those exits).
 *
 * The spring is stepped ahead of time and handed over as animations (like the sent words in
 * `composer/flight.ts`): the glide is one compositor transform, so the session view mounting under
 * it cannot make it stutter; the small change of width rides along as a declarative animation of
 * the ghost alone. The main thread only acts at the send, the claim and the landing.
 *
 * Under reduced motion there is no ghost: the views crossfade.
 */

type Phase = 'idle' | 'flying';

/** A point on the glide: ms since the send, offset from the start and width (px), and their speeds. */
interface Sample {
  t: number;
  x: number;
  y: number;
  w: number;
  vx: number;
  vy: number;
  vw: number;
}

interface Flight {
  ghost: HTMLElement;
  source: HTMLElement;
  start: { left: number; top: number; width: number; height: number };
  dock: HTMLElement | null;
  /** The path the ghost is on and its two animations (transform on the compositor, width beside it). */
  path: Sample[];
  move: Animation | null;
  size: Animation | null;
  /** Corrections run after the claim (the docked card can still move as the session settles). */
  fixes: number;
  timer: number;
  ending: boolean;
}

let flight: Flight | null = null;
let still = false;
let phase: Phase = 'idle';
const subs = new Set<() => void>();

const set = (p: Phase) => {
  if (phase === p) return;
  phase = p;
  subs.forEach((f) => f());
};

export const handoffPhase = () => phase;
export const subscribeHandoff = (fn: () => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};
/** True from the send until the docked composer has taken over (App picks its view transitions by it). */
export const handoffActive = () => phase === 'flying';

const STIFF = 260;
const DAMP = 30;
const LINE = 32;
/** No session after this long (the bridge is slow or the send failed silently): give up quietly. */
const GIVE_UP = 8000;

/** Where the docked composer will be, from the stage's geometry (see session.css `.dock`). */
function predictDock(height: number): { left: number; top: number; width: number } | null {
  const sb = document.querySelector('.stage-body');
  if (!sb) return null;
  const z = uiZoom();
  const r = sb.getBoundingClientRect();
  const left0 = r.left / z;
  const w0 = r.width / z;
  const col = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--column')) || 760;
  const width = Math.min(col, w0 - 48);
  return { left: left0 + (w0 - width) / 2, top: r.bottom / z - 18 - height, width };
}

function strip(el: Element) {
  el.removeAttribute('id');
  el.removeAttribute('aria-controls');
  el.removeAttribute('aria-labelledby');
  el.removeAttribute('data-spot');
  el.removeAttribute('data-spot-on');
  if (el.classList.contains('spot-ring')) el.remove();
  for (const c of [...el.children]) strip(c);
}

/** The spring from `from` to (tx, ty, tw), semi-implicit Euler in 4 ms steps, sampled every 16 ms. */
function glide(from: Sample, tx: number, ty: number, tw: number): Sample[] {
  const out = [from];
  let { t, x, y, w, vx, vy, vw } = from;
  const h = 0.004;
  for (let i = 1; i < 600; i++) {
    t += 4;
    vx += (STIFF * (tx - x) - DAMP * vx) * h;
    vy += (STIFF * (ty - y) - DAMP * vy) * h;
    vw += (STIFF * (tw - w) - DAMP * vw) * h;
    x += vx * h;
    y += vy * h;
    w += vw * h;
    const done = Math.abs(tx - x) < 0.4 && Math.abs(ty - y) < 0.4 && Math.abs(tw - w) < 0.4 && Math.abs(vx) + Math.abs(vy) < 8;
    if (done) {
      out.push({ t, x: tx, y: ty, w: tw, vx: 0, vy: 0, vw: 0 });
      break;
    }
    if (i % 4 === 0) out.push({ t, x, y, w, vx, vy, vw });
  }
  return out;
}

/** Plays a path on the ghost, replacing the one it was on; `then` runs when it has been flown. */
function run(f: Flight, path: Sample[], then: () => void) {
  const t0 = path[0].t;
  const dur = Math.max(1, path[path.length - 1].t - t0);
  const at = (p: Sample) => Math.min(1, (p.t - t0) / dur);
  const moves: Keyframe[] = path.map((p) => ({ offset: at(p), transform: `translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, 0)` }));
  const sizes: Keyframe[] = path.map((p) => ({ offset: at(p), width: `${p.w.toFixed(2)}px` }));
  if (moves.length < 2) {
    moves.push({ ...moves[0] });
    sizes.push({ ...sizes[0] });
  }
  moves[moves.length - 1].offset = 1;
  sizes[sizes.length - 1].offset = 1;
  const opts: KeyframeAnimationOptions = { duration: dur, easing: 'linear', fill: 'forwards' };
  const oldMove = f.move;
  const oldSize = f.size;
  f.path = path;
  const move = (f.move = f.ghost.animate(moves, opts));
  f.size = f.ghost.animate(sizes, opts);
  oldMove?.cancel();
  oldSize?.cancel();
  move.finished.then(() => f.move === move && !f.ending && then(), () => {});
}

/** Where the ghost is right now on its path (read from the animation's own clock). */
function whereNow(f: Flight): Sample {
  const p = f.path;
  const t = p[0].t + (Number(f.move?.currentTime) || 0);
  for (let i = 1; i < p.length; i++) {
    if (p[i].t < t) continue;
    const a = p[i - 1];
    const b = p[i];
    const u = (t - a.t) / Math.max(1, b.t - a.t);
    const mix = (k: keyof Sample) => a[k] + (b[k] - a[k]) * u;
    return { t, x: mix('x'), y: mix('y'), w: mix('w'), vx: mix('vx'), vy: mix('vy'), vw: mix('vw') };
  }
  const e = p[p.length - 1];
  return { ...e, t: Math.max(t, e.t), vx: 0, vy: 0, vw: 0 };
}

/** The docked card's place as an offset from the start. */
function dockTarget(f: Flight): { x: number; y: number; w: number } | null {
  const d = f.dock;
  if (!d?.isConnected) return null;
  const z = uiZoom();
  const r = d.getBoundingClientRect();
  if (!r.width) return null;
  return { x: r.left / z - f.start.left, y: r.top / z - f.start.top, w: r.width / z };
}

/** The path has been flown: land on the docked card, or glide on to where it is now. */
function arrived(f: Flight) {
  if (!f.dock) return; // waiting at the predicted place for the session to mount
  const to = dockTarget(f);
  if (!to) return cancelHandoff();
  const end = f.path[f.path.length - 1];
  if (Math.abs(to.x - end.x) < 0.5 && Math.abs(to.y - end.y) < 0.5 && Math.abs(to.w - end.w) < 0.5) return land();
  if (++f.fixes > 4) return land();
  run(f, glide(whereNow(f), to.x, to.y, to.w), () => arrived(f));
}

/** Starts the flight from the home composer card. Safe to call when one is already running. */
export function beginHandoff(card: HTMLElement | null) {
  if (!card || flight || phase === 'flying') return;
  if (reducedMotion()) {
    still = true;
    set('flying');
    return;
  }
  const z = uiZoom();
  const b = card.getBoundingClientRect();
  const start = { left: b.left / z, top: b.top / z, width: b.width / z, height: b.height / z };
  const ta = card.querySelector<HTMLTextAreaElement>('textarea.cmp-input:not(.cmp-mirror)');
  const taH = ta ? ta.offsetHeight : LINE;
  const landH = start.height - Math.max(0, taH - LINE);
  const target = predictDock(landH) ?? { left: start.left, top: start.top, width: start.width };

  const ghost = document.createElement('div');
  ghost.className = 'composer handoff-ghost';
  ghost.dataset.variant = 'session';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.style.cssText = `position:fixed;left:${start.left}px;top:${start.top}px;width:${start.width}px;z-index:30;pointer-events:none;will-change:transform;contain:layout style;`;
  const copy = card.cloneNode(true) as HTMLElement;
  strip(copy);
  copy.removeAttribute('data-rolling');
  ghost.appendChild(copy);
  const field = copy.querySelector<HTMLTextAreaElement>('textarea.cmp-input:not(.cmp-mirror)');
  if (field) {
    field.value = '';
    // Blank on the way down: the message just left, and the docked card brings its own placeholder.
    field.placeholder = '';
    field.style.transition = 'height 260ms cubic-bezier(0.16, 1, 0.3, 1)';
  }
  copy.querySelector('.cmp-roll')?.remove();
  document.body.appendChild(ghost);
  // The send key answers on the way: its arrow launches up out of the disc, and the disc goes
  // quiet (the docked card brings its own key).
  const key = copy.querySelector<HTMLElement>('.cmp-send');
  const arrow = key?.querySelector('.sk-glyph');
  if (key && arrow) {
    key.style.overflow = 'hidden';
    arrow.animate([{ transform: 'translateY(0px)', opacity: 1 }, { transform: 'translateY(-20px)', opacity: 0.2 }], { duration: 180, delay: 56, easing: 'cubic-bezier(0.55, 0, 0.8, 0.3)', fill: 'forwards' });
    key.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.9)', offset: 0.3 }, { transform: 'scale(1)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)', opacity: 0 }], { duration: 420, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'forwards' });
  }
  // The field settles to one line on the way down (the docked composer's resting height).
  requestAnimationFrame(() => field && (field.style.height = `${LINE}px`));
  // Opacity, not visibility: the field keeps the keyboard, so words typed during the glide are kept
  // (the docked composer takes them over when it claims the flight).
  card.style.opacity = '0';

  const f: Flight = { ghost, source: card, start, dock: null, path: [], move: null, size: null, fixes: 0, timer: 0, ending: false };
  flight = f;
  set('flying');
  run(f, glide({ t: 0, x: 0, y: 0, w: start.width, vx: 0, vy: 0, vw: 0 }, target.left - start.left, target.top - start.top, target.width), () => arrived(f));
  f.timer = window.setTimeout(() => flight === f && !f.dock && cancelHandoff(), GIVE_UP);
}

/** The docked composer replaces the ghost. */
function land() {
  const f = flight;
  if (!f || f.ending) return;
  f.ending = true;
  window.clearTimeout(f.timer);
  if (f.dock) f.dock.style.opacity = '';
  fadeOut(f, 90);
  flight = null;
  set('idle');
}

function fadeOut(f: Flight, duration: number) {
  const g = f.ghost;
  const fade = g.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration, easing: 'linear', fill: 'forwards' });
  const done = () => g.remove();
  if (fade) fade.finished.then(done, done);
  else done();
}

/**
 * Called by the session composer when it mounts. When a flight is on its way, the card hides until
 * the ghost lands on it and the spring is re-aimed at its real place. Returns true when claimed.
 */
export function claimHandoff(card: HTMLElement | null): boolean {
  if (!card) return false;
  if (still) {
    still = false;
    set('idle');
    return false;
  }
  const f = flight;
  if (!f || f.dock || f.ending) return false;
  f.dock = card;
  card.style.opacity = '0';
  const to = dockTarget(f);
  if (to) run(f, glide(whereNow(f), to.x, to.y, to.w), () => arrived(f));
  return true;
}

/** The send did not start a session: the ghost fades and the home card comes back. */
export function cancelHandoff() {
  if (still) {
    still = false;
    set('idle');
    return;
  }
  const f = flight;
  if (!f) return;
  f.ending = true;
  window.clearTimeout(f.timer);
  f.move?.pause();
  f.size?.pause();
  f.source.style.opacity = '';
  if (f.dock) f.dock.style.opacity = '';
  fadeOut(f, 140);
  flight = null;
  set('idle');
}
