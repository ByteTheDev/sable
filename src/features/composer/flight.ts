import { EASE_OUT, play, reducedMotion, uiZoom } from '@/lib/motion';

/**
 * The sent words travel. On send the text lifts out of the field as a clone (a fixed layer over
 * everything) and the field is empty and live at once; the clone heads for where the message
 * will sit (guessed from the geometry while the bridge answers), then an eased arc of about half
 * a second carries it onto the element the message becomes (the bubble in the conversation, or
 * the row in the queue tray), the bubble forms under it in the last part, and the two swap.
 *
 * - One clone per message, transform and opacity only. Its target is read once per frame from
 *   the landing element (the conversation is gliding to its end meanwhile), on a clean layout.
 * - Wrapped words take the bubble's measure as they lift and the landing's type when it is
 *   known, so they arrive pixel for pixel and hand over in one frame. Words that still differ
 *   (more than four lines, a one-line row) crossfade into the real text over the last stretch.
 * - A send glides with the vertical leading (it rises, then settles right); a steer leans into
 *   the turn first (sideways leading) and cools to the waiting tone it lands in.
 * - Nothing waits for the motion: the message is already sent when the clone appears. A clone
 *   that finds no landing within a moment fades where it is.
 * Under reduced motion there are no clones: the items fade in as before.
 */

export type FlightDest = 'timeline' | 'tray';

interface Flight {
  el: HTMLDivElement;
  key: string;
  dest: FlightDest;
  steer: boolean;
  born: number;
  last: number;
  raf: number;
  start: { left: number; top: number };
  size: number;
  x: number;
  y: number;
  /** Where the words were when their landing became known, and how long the trip takes (ms). */
  x0: number;
  y0: number;
  dur: number;
  target: HTMLElement | null;
  /** Scale at the landing (the target's type size over the field's). */
  scale: number;
  dist0: number;
  claimedAt: number;
  /** The first message of a new session: where it will sit, guessed from the stage, so the words
   *  are on their way before the session exists (offset from the start). */
  guess: { x: number; y: number } | null;
  cut: boolean;
  fading: boolean;
  ending: boolean;
  onLand?: () => void;
}

const pending: Flight[] = [];
/** Messages that mounted in the conversation with no clone in the air yet (a tray row may still leave). */
const unclaimed: { key: string; root: HTMLElement; at: number }[] = [];

const norm = (t: string) => t.trim().replace(/\s+/g, ' ').slice(0, 160);
const matches = (flightKey: string, text: string) => {
  const k = norm(text);
  return !!flightKey && (k === flightKey || k.startsWith(flightKey) || flightKey.startsWith(k));
};

/** Lines a long message flies with; the rest is already in the bubble when it lands. */
const MAX_LINES = 4;
const NO_CLAIM_MS = 1400;
const GUESS_MS = 640;

let measure: CanvasRenderingContext2D | null = null;

/**
 * Where a message will sit, guessed from the geometry before it exists, so the words are on their
 * way at once (the real place corrects the aim when it appears): its right edge at the card's
 * right padding in the column (timeline.css `.user-card`), and its top just above the dock once
 * the conversation has followed it, or right under the last row when the conversation is short.
 * The first message of a new session sits near the top of the stage.
 */
function guessLanding(clone: HTMLElement, left: number, top: number, from: HTMLElement, first: boolean): { x: number; y: number } | null {
  const z = uiZoom();
  const root = getComputedStyle(document.documentElement);
  const gutter = parseFloat(root.getPropertyValue('--gutter')) || 24;
  const content = first ? null : document.querySelector('.tl-content');
  let colRight: number;
  let y: number;
  if (content) {
    const c = content.getBoundingClientRect();
    colRight = c.right / z;
    const card = from.closest('.cmp-card')?.getBoundingClientRect();
    const last = [...content.children].reverse().find((n) => !n.classList.contains('tail'));
    const after = last ? last.getBoundingClientRect().bottom / z + 36 : c.top / z + 16;
    y = Math.min(card ? card.top / z - 72 - clone.offsetHeight : after, after);
  } else {
    const sb = document.querySelector('.stage-body');
    if (!sb) return null;
    const r = sb.getBoundingClientRect();
    const col = parseFloat(root.getPropertyValue('--column')) || 760;
    const w0 = r.width / z;
    const width = Math.min(col, w0 - 48);
    colRight = r.left / z + (w0 + width) / 2;
    y = r.top / z + 70;
  }
  measure ??= document.createElement('canvas').getContext('2d');
  const cs = clone.style;
  let textW = clone.getBoundingClientRect().width / z;
  if (measure) {
    measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = measure;
    textW = Math.min(textW, Math.max(...(clone.textContent ?? '').split(/\n/).map((l) => m.measureText(l).width)));
  }
  return { x: colRight - gutter - 15 - textW - left, y: y - top };
}

interface Source {
  el: HTMLElement;
  /** The words, as shown in `el` (its text box: padding excluded, scroll applied). */
  text: string;
  oneLine?: boolean;
}

function makeClone({ el, text, oneLine }: Source): { clone: HTMLDivElement; left: number; top: number; size: number } | null {
  const cs = getComputedStyle(el);
  const z = uiZoom();
  const r = el.getBoundingClientRect();
  if (!r.width) return null;
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const left = r.left / z + padL;
  const top = r.top / z + padT - el.scrollTop;
  const width = r.width / z - padL - padR;
  const size = parseFloat(cs.fontSize) || 14;
  const clone = document.createElement('div');
  clone.className = 'send-flight';
  clone.setAttribute('aria-hidden', 'true');
  if (!oneLine) clone.style.setProperty('--lines', String(MAX_LINES));
  clone.style.cssText += `left:${left}px;top:${top}px;width:${width}px;font-size:${cs.fontSize};line-height:${cs.lineHeight};font-family:${cs.fontFamily};font-weight:${cs.fontWeight};letter-spacing:${cs.letterSpacing};`;
  if (oneLine) clone.setAttribute('data-one-line', '');
  clone.textContent = text;
  return { clone, left, top, size };
}

/**
 * The widest a message's text runs in the conversation (timeline.css: `.user-card` is at most 78 %
 * of the column, with 14 px padding and a hairline each side), from the conversation when one is
 * open, or the stage's geometry before the session exists.
 */
function bubbleTextWidth(): number | null {
  const z = uiZoom();
  const root = getComputedStyle(document.documentElement);
  const gutter = parseFloat(root.getPropertyValue('--gutter')) || 24;
  const content = document.querySelector('.tl-content');
  let col: number;
  if (content) col = content.getBoundingClientRect().width / z;
  else {
    const sb = document.querySelector('.stage-body');
    if (!sb) return null;
    const w0 = sb.getBoundingClientRect().width / z;
    col = Math.min(parseFloat(root.getPropertyValue('--column')) || 760, w0 - 48);
  }
  return Math.floor((col - gutter * 2) * 0.78 - 30);
}

/**
 * Lifts `text` out of `source` (the composer's field, or a queue row's text) and keeps it in the
 * air until something with the same text claims it. Call before the field is cleared.
 */
export function launchFlight(source: Source, opts: { dest: FlightDest; steer?: boolean; first?: boolean }) {
  if (reducedMotion() || !source.text.trim()) return;
  const made = makeClone(source);
  if (!made) return;
  const { clone, left, top, size } = made;
  document.body.appendChild(clone);
  // Words that wrap take the bubble's measure as they lift, so they travel in the shape they land
  // in (one reflow of the clone, at the start, softened by a short fade) instead of overhanging
  // the bubble and rewrapping on arrival.
  if (opts.dest === 'timeline' && !source.oneLine) {
    const lh = parseFloat(clone.style.lineHeight) || 22;
    const bw = bubbleTextWidth();
    if (bw && clone.offsetHeight > lh * 1.5 && bw < clone.offsetWidth) {
      clone.style.width = `${bw}px`;
      play(clone, [{ opacity: 0.35 }, { opacity: 1 }], { duration: 140, easing: 'linear' });
    }
  }
  const now = performance.now();
  const steer = !!opts.steer;
  const f: Flight = {
    el: clone,
    key: norm(source.text),
    dest: opts.dest,
    steer,
    born: now,
    last: now,
    raf: 0,
    start: { left, top },
    size,
    x: 0,
    y: 0,
    x0: 0,
    y0: 0,
    dur: 0,
    target: null,
    scale: 1,
    dist0: 1,
    claimedAt: 0,
    guess: opts.dest === 'timeline' && !source.oneLine ? guessLanding(clone, left, top, source.el, !!opts.first) : null,
    cut: false,
    fading: false,
    ending: false,
  };
  pending.push(f);
  f.raf = requestAnimationFrame((t) => step(f, t));
  // A conversation row that mounted first (the bridge answered before this row left the tray).
  if (opts.dest === 'timeline') {
    const i = unclaimed.findIndex((u) => now - u.at < 400 && u.root.isConnected && matches(f.key, u.key));
    if (i >= 0) {
      const u = unclaimed.splice(i, 1)[0];
      landInTimeline(u.root, u.key, { steer, late: true });
    }
  }
}

/** A cubic-bezier easing (x1, y1, x2, y2), solved by a few Newton steps. */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  return (p: number) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let t = p;
    for (let i = 0; i < 6; i++) {
      const x = ((ax * t + bx) * t + cx) * t - p;
      const d = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(x) < 1e-4 || !d) break;
      t -= x / d;
    }
    return ((ay * t + by) * t + cy) * t;
  };
}

/** The axis that leads gets there early and softly; the other follows: the path is an arc. */
const LEAD = bezier(0.22, 0.6, 0.12, 1);
const FOLLOW = bezier(0.5, 0, 0.12, 1);

function step(f: Flight, now: number) {
  f.raf = 0;
  if (f.ending) return;
  if (!f.target) {
    if (now - f.born > NO_CLAIM_MS) return abort(f);
    if (f.guess) {
      // Toward where the message will sit; the real place corrects the aim when it exists.
      const p = Math.min(1, (now - f.born) / GUESS_MS);
      f.x = f.guess.x * FOLLOW(p);
      f.y = f.guess.y * LEAD(p);
    } else {
      // Before a landing is known the words drift up, out of the field.
      f.y = -12 * (1 - Math.exp(-(now - f.born) / 70));
    }
    f.el.style.transform = `translate3d(${f.x.toFixed(2)}px, ${f.y.toFixed(2)}px, 0)`;
    f.raf = requestAnimationFrame((t) => step(f, t));
    return;
  }
  if (!f.target.isConnected) return abort(f);
  const z = uiZoom();
  const r = f.target.getBoundingClientRect();
  const tx = r.left / z - f.start.left;
  const ty = r.top / z - f.start.top;
  const p = Math.min(1, (now - f.claimedAt) / f.dur);
  const ex = f.steer ? LEAD(p) : FOLLOW(p);
  const ey = f.steer ? FOLLOW(p) : LEAD(p);
  const x = f.x0 + (tx - f.x0) * ex;
  const y = f.y0 + (ty - f.y0) * ey;
  const s = 1 + (f.scale - 1) * ey;
  f.x = x;
  f.y = y;
  // Wrapped text: the real lines take over in the last stretch, so the rewrap is a dissolve.
  if (!f.cut && !f.fading && p > 0.7) crossfade(f);
  f.el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)${s !== 1 ? ` scale(${s.toFixed(4)})` : ''}`;
  if (p >= 1) return land(f);
  f.raf = requestAnimationFrame((t) => step(f, t));
}

function crossfade(f: Flight) {
  f.fading = true;
  const t = f.target;
  if (t) {
    t.style.opacity = '';
    play(t, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'linear' });
  }
  play(f.el, [{ opacity: 0 }], { duration: 150, easing: 'linear', fill: 'forwards' });
}

function land(f: Flight) {
  if (f.ending) return;
  f.ending = true;
  cancelAnimationFrame(f.raf);
  if (f.target) f.target.style.opacity = '';
  // Same line, same type: the real words are exactly under the clone, so the swap is one frame.
  if (f.fading) {
    const done = () => f.el.remove();
    const a = f.el.getAnimations().at(-1);
    if (a) a.finished.then(done, done);
    else done();
  } else f.el.remove();
  f.onLand?.();
  drop(f);
}

function abort(f: Flight) {
  if (f.ending) return;
  f.ending = true;
  cancelAnimationFrame(f.raf);
  if (f.target) f.target.style.opacity = '';
  const done = () => f.el.remove();
  const a = play(f.el, [{ opacity: 0 }], { duration: 140, easing: 'linear', fill: 'forwards' });
  if (a) a.finished.then(done, done);
  else done();
  drop(f);
}

function drop(f: Flight) {
  const i = pending.indexOf(f);
  if (i >= 0) pending.splice(i, 1);
}

function claim(dest: FlightDest, text: string): Flight | null {
  const i = pending.findIndex((f) => f.dest === dest && !f.target && matches(f.key, text));
  return i >= 0 ? pending[i] : null;
}

function aim(f: Flight, target: HTMLElement, oneLineTarget: boolean) {
  const z = uiZoom();
  const r = target.getBoundingClientRect();
  const cs = getComputedStyle(target);
  f.target = target;
  f.claimedAt = performance.now();
  // The words take the landing's type now, early in the trip (a queue row is 13 px, a message 14):
  // set, not scaled, so they arrive pixel for pixel on the real ones and the swap can be a cut.
  if (cs.fontSize !== f.el.style.fontSize || cs.lineHeight !== f.el.style.lineHeight) {
    f.el.style.fontSize = cs.fontSize;
    f.el.style.lineHeight = cs.lineHeight;
    f.el.style.letterSpacing = cs.letterSpacing;
    f.size = parseFloat(cs.fontSize) || f.size;
  }
  f.scale = 1;
  f.dist0 = Math.max(1, Math.hypot(r.left / z - f.start.left - f.x, r.top / z - f.start.top - f.y));
  f.x0 = f.x;
  f.y0 = f.y;
  // Send: the rise leads and the slide follows (up and over). Steer: it leans into the turn first.
  // Longer trips take a little longer, never past about 0.6 s.
  f.dur = f.guess ? Math.max(200, GUESS_MS - (f.claimedAt - f.born) + Math.min(160, f.dist0)) : Math.min(620, Math.max(440, 380 + f.dist0 * 0.35));
  const lh = parseFloat(cs.lineHeight) || 22;
  const lines = Math.round(r.height / z / lh);
  const cloneLines = Math.round(f.el.offsetHeight / (parseFloat(getComputedStyle(f.el).lineHeight) || 22));
  // The same lines at the same measure (a one-line message, or wrapped words that took the
  // bubble's measure and fit whole): the swap is a cut. Anything else dissolves on arrival.
  const sameScale = Math.abs(f.scale - 1) < 0.02;
  const whole = f.el.scrollHeight <= f.el.offsetHeight + 1;
  const oneLine = cloneLines <= 1 && (lines <= 1 || oneLineTarget);
  const sameWrap = !oneLineTarget && whole && cloneLines === lines && Math.abs(r.width / z - f.el.offsetWidth) < 1.5;
  f.cut = sameScale && (oneLine || sameWrap);
  target.style.opacity = '0';
  if (!f.raf) f.raf = requestAnimationFrame((t) => step(f, t));
}

/**
 * A message mounted in the conversation (`root` is its `.user` element). When its words are in
 * the air, they land here: the row skips its own entrance, the bubble forms under the arriving
 * text, and the clone swaps in. Returns true when a clone took it.
 */
export function landInTimeline(root: HTMLElement, text: string, opts: { steer?: boolean; late?: boolean } = {}): boolean {
  if (reducedMotion()) return false;
  const f = claim('timeline', text);
  if (!f) {
    if (!opts.late) {
      unclaimed.push({ key: text, root, at: performance.now() });
      if (unclaimed.length > 4) unclaimed.shift();
    }
    return false;
  }
  const textEl = root.querySelector<HTMLElement>('.user-text');
  const card = root.querySelector<HTMLElement>('.user-card');
  if (!textEl || !card) return false;
  root.setAttribute('data-flight', '');
  for (const a of root.getAnimations()) a.cancel();
  aim(f, textEl, false);
  // The bubble forms around the words as they arrive: from a smaller, clear card on its right edge.
  const lead = opts.late ? 0 : Math.round(f.dur * 0.38);
  card.style.transformOrigin = '100% 50%';
  play(card, [{ opacity: 0, transform: 'scale(0.9, 0.82)', offset: 0 }], { duration: Math.round(f.dur * 0.62) + 40, delay: lead, easing: EASE_OUT, fill: 'backwards' });
  const mark = root.querySelector('.user-mark');
  if (mark) play(mark, [{ opacity: 0, transform: 'translateX(8px)', offset: 0 }], { duration: 300, delay: lead + 120, easing: EASE_OUT, fill: 'backwards' });
  if (f.steer || opts.steer) {
    // Into the running turn: the words cool to the waiting tone on the way in.
    play(f.el, [{ opacity: 1 }, { opacity: 0.6 }], { duration: 420, easing: 'linear', fill: 'forwards' });
  }
  return true;
}

/** A queued message's row appeared in the tray: the words from the field land on it. */
export function landInTray(textEl: HTMLElement, text: string): boolean {
  if (reducedMotion()) return false;
  const f = claim('tray', text);
  if (!f) return false;
  aim(f, textEl, true);
  return true;
}

/** A queued message left the tray for the conversation: its row's words fly up to where it lands. */
export function launchFromTray(textEl: HTMLElement, text: string) {
  if (reducedMotion()) return;
  launchFlight({ el: textEl, text, oneLine: true }, { dest: 'timeline' });
  const f = pending[pending.length - 1];
  // The row shows one truncated line: the clone carries exactly that line.
  if (f && !f.target) f.el.textContent = textEl.textContent ?? text;
}

/** For tests and the dev console: clones in the air. */
export const flightsInAir = () => pending.length;
