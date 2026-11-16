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
 * Under reduced motion there is no ghost: the views crossfade.
 */

type Phase = 'idle' | 'flying';

interface Flight {
  ghost: HTMLElement;
  source: HTMLElement;
  /** Current offset from the start (zoomed px), velocity, and width. */
  x: number;
  y: number;
  w: number;
  vx: number;
  vy: number;
  vw: number;
  start: { left: number; top: number; width: number; height: number };
  target: { left: number; top: number; width: number };
  dock: HTMLElement | null;
  raf: number;
  last: number;
  born: number;
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
  ghost.style.cssText = `position:fixed;left:${start.left}px;top:${start.top}px;width:${start.width}px;z-index:30;pointer-events:none;will-change:transform;`;
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

  flight = { ghost, source: card, x: 0, y: 0, w: start.width, vx: 0, vy: 0, vw: 0, start, target, dock: null, raf: 0, last: performance.now(), born: performance.now(), ending: false };
  set('flying');
  flight.raf = requestAnimationFrame(step);
}

function step(now: number) {
  const f = flight;
  if (!f) return;
  // Wall-clock time (a slow frame must not stretch the motion), integrated in small sub-steps.
  const dt = Math.min(0.1, Math.max(0, (now - f.last) / 1000));
  f.last = now;
  // The docked card can still move as the session view settles (fonts, the timeline's first items).
  if (f.dock?.isConnected) {
    const z = uiZoom();
    const r = f.dock.getBoundingClientRect();
    if (r.width) f.target = { left: r.left / z, top: r.top / z, width: r.width / z };
  }
  const tx = f.target.left - f.start.left;
  const ty = f.target.top - f.start.top;
  const tw = f.target.width;
  // Semi-implicit Euler in sub-steps of at most 6 ms: stable at these stiffnesses.
  const n = Math.max(1, Math.ceil(dt / 0.006));
  for (let i = 0; i < n; i++) {
    const h = dt / n;
    f.vx += (STIFF * (tx - f.x) - DAMP * f.vx) * h;
    f.vy += (STIFF * (ty - f.y) - DAMP * f.vy) * h;
    f.vw += (STIFF * (tw - f.w) - DAMP * f.vw) * h;
    f.x += f.vx * h;
    f.y += f.vy * h;
    f.w += f.vw * h;
  }
  f.ghost.style.transform = `translate3d(${f.x.toFixed(2)}px, ${f.y.toFixed(2)}px, 0)`;
  f.ghost.style.width = `${f.w.toFixed(2)}px`;
  const settled = Math.abs(tx - f.x) < 0.4 && Math.abs(ty - f.y) < 0.4 && Math.abs(tw - f.w) < 0.4 && Math.abs(f.vx) + Math.abs(f.vy) < 8;
  if (settled && f.dock) return land();
  // No session after a long wait (the bridge is slow or the send failed silently): give up quietly.
  if (now - f.born > 8000) return cancelHandoff();
  f.raf = requestAnimationFrame(step);
}

/** The docked composer replaces the ghost. */
function land() {
  const f = flight;
  if (!f || f.ending) return;
  f.ending = true;
  cancelAnimationFrame(f.raf);
  if (f.dock) f.dock.style.opacity = '';
  const g = f.ghost;
  const fade = g.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: 'linear', fill: 'forwards' });
  const done = () => g.remove();
  if (fade) fade.finished.then(done, done);
  else done();
  flight = null;
  set('idle');
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
  if (!f || f.dock) return false;
  f.dock = card;
  card.style.opacity = '0';
  const z = uiZoom();
  const r = card.getBoundingClientRect();
  f.target = { left: r.left / z, top: r.top / z, width: r.width / z };
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
  cancelAnimationFrame(f.raf);
  f.source.style.opacity = '';
  if (f.dock) f.dock.style.opacity = '';
  const g = f.ghost;
  const fade = g.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'linear', fill: 'forwards' });
  const done = () => g.remove();
  if (fade) fade.finished.then(done, done);
  else done();
  flight = null;
  set('idle');
}
