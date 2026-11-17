import { play, reducedMotion, uiZoom } from '@/lib/motion';

/**
 * The sent words are thrown. On send the text lifts out of the field as a clone (a fixed layer
 * over everything) and the field is empty and live at once. The throw is one beat with the send
 * key and the backdrop (`RELEASE` ms after the press: the words sink a touch while the key gives,
 * then the arrow leaves the disc, the wave leaves the key and the words leave the field at full
 * speed). They fly on a spring toward where the message will sit (guessed from the geometry while
 * the bridge answers; the real place takes over without a break, the spring keeps its speed), and
 * the arrival draws the bubble: as the words come within reach, the card resolves out of the
 * ground in dither around them and the two settle as one body, then swap.
 *
 * - One clone per message, transform and opacity only. Its target is read once per frame from
 *   the landing element (the conversation is gliding to its end meanwhile), on a clean layout.
 * - Wrapped words take the bubble's measure as they lift and the landing's type when it is
 *   known, so they arrive pixel for pixel and hand over in one frame. Words that still differ
 *   (more than four lines, a one-line row) crossfade into the real text as the bubble forms.
 * - A send is thrown upward and sweeps right; a steer leans into the turn first (sideways
 *   leading) and cools to the waiting tone it lands in. The first message from home slides out
 *   from under the headline before it rises, so the two never cross.
 * - Nothing waits for the motion: the message is already sent when the clone appears. A clone
 *   that finds no landing within a moment fades where it is.
 * Under reduced motion there are no clones: the items fade in as before.
 */

export type FlightDest = 'timeline' | 'tray';

/** The beat the key, the words and the backdrop share: ms from the press to the release. */
export const RELEASE = 56;

/** A point on the words' path: ms since the launch, offset from the start (px), speed (px/s). */
interface Sample {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Flight {
  el: HTMLDivElement;
  key: string;
  dest: FlightDest;
  steer: boolean;
  /** Ms after the launch at which the words leave the field (they sink a touch until then). */
  release: number;
  /** The path the words are on (compositor animation) and its samples; the give-up timer. */
  anim: Animation | null;
  path: Sample[];
  timer: number;
  /** The first message of a new session (the view it lands in is still fading in). */
  first: boolean;
  start: { left: number; top: number };
  size: number;
  /** The sideways axis leads (a steer, the first message from home); otherwise the rise does. */
  sideways: boolean;
  /** The first message from home: how long the rise waits (ms after release) for the headline to go. */
  hold: number;
  target: HTMLElement | null;
  /** What rides home with the words over the last stretch (the message row), if anything. */
  rider: HTMLElement | null;
  /** The first message of a new session: where it will sit, guessed from the stage, so the words
   *  are on their way before the session exists (offset from the start). */
  guess: { x: number; y: number } | null;
  cut: boolean;
  fading: boolean;
  ending: boolean;
  /** Forms what the words land in (the bubble), as they come within reach. */
  onCatch?: () => void;
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
const MAX_LIFE_MS = 2600;

/**
 * Where a message will sit, guessed from the geometry before it exists, so the words are on their
 * way at once (the real place corrects the aim when it appears): its left edge at the text's
 * inset in the column (timeline.css `.user-card`), and its top just above the dock once
 * the conversation has followed it, or right under the last row when the conversation is short.
 * The first message of a new session sits near the top of the stage.
 */
function guessLanding(clone: HTMLElement, left: number, top: number, from: HTMLElement, first: boolean): { x: number; y: number } | null {
  const z = uiZoom();
  const column = columnToken();
  const contents = document.querySelectorAll<HTMLElement>('.tl-content');
  // Two conversations on stage (a session switch is fading one out): which one the message lands
  // in is not certain, so the words wait for the real row instead of flying toward a guess.
  if (contents.length > 1 || (!first && contents.length !== 1)) return null;
  const content = first ? null : contents[0];
  let colRight: number;
  let y: number;
  let lo = -Infinity;
  let hi = Infinity;
  if (content) {
    const c = content.getBoundingClientRect();
    // The message ends at the reading column's right edge (the row's side padding centres it).
    colRight = columnEdges(c.left / z, c.width / z, column).right;
    const card = from.closest('.cmp-card')?.getBoundingClientRect();
    const last = [...content.children].reverse().find((n) => !n.classList.contains('tail'));
    const after = last ? last.getBoundingClientRect().bottom / z + 36 : c.top / z + 16;
    y = Math.min(card ? card.top / z - 72 - clone.offsetHeight : after, after);
    const sc = content.parentElement?.getBoundingClientRect();
    if (sc) {
      lo = sc.top / z;
      hi = (card ? card.top : sc.bottom) / z;
    }
  } else {
    const sb = document.querySelector('.stage-body');
    if (!sb) return null;
    const r = sb.getBoundingClientRect();
    colRight = columnEdges(r.left / z, r.width / z, column).right;
    y = r.top / z + 56;
  }
  // Only a place inside the visible conversation is certain enough to fly to.
  if (!(y >= lo && y + clone.offsetHeight <= hi + 1)) return null;
  // The card sits on the right and fits its text: the words start one text-width in from its padding.
  const set = clone.style.width;
  clone.style.width = 'max-content';
  const natural = clone.offsetWidth;
  clone.style.width = set;
  const textWidth = Math.min(natural, bubbleTextWidth() ?? natural, clone.offsetWidth);
  return { x: colRight - TEXT_INSET - textWidth - left, y: y + CARD_PAD_TOP - top };
}

/** A message's text inset from its card's side and top (timeline.css `.user-card` padding). */
const TEXT_INSET = 15;
const CARD_PAD_TOP = 9;
/** The narrowest side padding of a conversation row (timeline.css `.tl-content --gutter`). */
const MIN_GUTTER = 24;

function columnToken(): number {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--column')) || 760;
}

/**
 * The reading column inside a conversation of the given left edge and width, the way timeline.css
 * lays it out (`--gutter: max(24px, (100% - var(--column)) / 2)` on each side of every row).
 */
export function columnEdges(left: number, width: number, column: number): { left: number; right: number; width: number } {
  const gutter = Math.max(MIN_GUTTER, (width - column) / 2);
  return { left: left + gutter, right: left + width - gutter, width: Math.max(0, width - gutter * 2) };
}

/**
 * Whether a landing box is certain enough to fly to: it has a size, it sits inside the reading
 * column (a pixel of slack), and it is within a viewport's reach of the visible conversation (it
 * may still be rising from behind the composer while the view follows it).
 */
export function landingCertain(
  box: { left: number; right: number; top: number; bottom: number; width: number; height: number },
  col: { left: number; right: number },
  view: { top: number; bottom: number },
): boolean {
  if (!(box.width > 0 && box.height > 0)) return false;
  if (box.left < col.left - 1 || box.right > col.right + 1) return false;
  const reach = view.bottom - view.top;
  return box.bottom > view.top - reach * 0.25 && box.top < view.bottom + reach;
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
  const contents = document.querySelectorAll('.tl-content');
  const box = contents.length === 1 ? contents[0] : contents.length ? null : document.querySelector('.stage-body');
  if (!box) return null;
  const col = columnEdges(0, box.getBoundingClientRect().width / z, columnToken()).width;
  return Math.floor(col * 0.8 - TEXT_INSET * 2);
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
    // A row leaving the tray has no key press to share a beat with: it goes at once.
    release: source.oneLine ? 0 : RELEASE,
    anim: null,
    path: [],
    timer: 0,
    first: !!opts.first,
    start: { left, top },
    size,
    sideways: steer || !!opts.first,
    hold: opts.first ? FIRST_HOLD : 0,
    target: null,
    rider: null,
    // A queued message leaves the field for the tray just above the card, before its row exists.
    guess: opts.dest === 'tray' ? { x: 4, y: -46 } : !source.oneLine ? guessLanding(clone, left, top, source.el, !!opts.first) : null,
    cut: false,
    fading: false,
    ending: false,
  };
  pending.push(f);
  // On its way at once: toward the guess, or a short lift until the landing is known.
  run(f, fly(f, { t: 0, x: 0, y: 0, vx: 0, vy: 0 }, f.guess?.x ?? 0, f.guess?.y ?? -14, 0));
  f.timer = window.setTimeout(() => !f.target && abort(f), NO_CLAIM_MS);
  // Whatever happens on the way, no clone outlives this: the real message always shows.
  window.setTimeout(() => abort(f), MAX_LIFE_MS);
  // A conversation row that mounted first (the bridge answered before this row left the tray).
  if (opts.dest === 'timeline') {
    const i = unclaimed.findIndex((u) => now - u.at < 400 && u.root.isConnected && matches(f.key, u.key));
    if (i >= 0) {
      const u = unclaimed.splice(i, 1)[0];
      landInTimeline(u.root, u.key, { steer, late: true });
    }
  }
}

/** Stiffness of the axis that leads and of the one that follows (both critically damped): the path is an arc. */
const K_LEAD = 300;
const K_FOLLOW = 240;
/** The rise of the first message from home, once the headline has gone. */
const K_RISE = 250;
/** The throw: the leading axis leaves at this share of its trip per second, so the first frames cover ground. */
const THROW = 7;
/** The following axis gets a little of it too, so the sweep is under way from the first frame. */
const THROW_FOLLOW = 2;
/** How far the words sink while the key gives (px). */
const DIP = 2.5;
/** The first message from home waits this long before it rises (the headline is dissolving above it). */
const FIRST_HOLD = 220;
/** The bubble forms when the words are this close: a share of the trip, never less than a few px. */
const REACH = 0.14;
const REACH_MIN = 26;
/** How long the bubble takes to form around the words (ms); a tray row has nothing to form. */
const FORM = 250;
const FORM_TRAY = 130;

/**
 * The path from `from` toward a landing at (gx, gy), stepped ahead of time: the gather (the words
 * sink while the key gives), the throw at the release, then two critically damped springs, one
 * per axis, the leading one stiffer. With a `reach` the path ends where the words come that close
 * (the bubble takes over there); without one it runs until they rest. The whole path is handed to
 * the compositor as one animation, so a busy main thread (a session mounting, a turn starting)
 * cannot make the words stutter: the main thread only acts at the launch, when the landing
 * becomes known, and at the reach.
 */
function fly(f: Flight, from: Sample, gx: number, gy: number, reach: number): Sample[] {
  const out = [from];
  let { t, x, y, vx, vy } = from;
  let thrown = t > f.release;
  const kx = f.sideways ? K_LEAD : K_FOLLOW;
  const ky = f.sideways ? (f.hold ? K_RISE : K_FOLLOW) : K_LEAD;
  const cx = 2 * Math.sqrt(kx);
  const cy = 2 * Math.sqrt(ky);
  const h = 0.004;
  for (let i = 1; i < 320; i++) {
    t += 4;
    const since = t - f.release;
    let done = false;
    if (since <= 0) y = DIP * Math.sin((t / f.release) * Math.PI * 0.5);
    else {
      if (!thrown) {
        thrown = true;
        vx = (f.sideways ? THROW : THROW_FOLLOW) * (gx - x);
        vy = (f.sideways ? THROW_FOLLOW : THROW) * (gy - y);
      }
      // Under the headline until it has gone: the rise waits, the slide does not.
      const holding = since < f.hold;
      const ty = holding ? Math.max(gy, -10) : gy;
      vx += (kx * (gx - x) - cx * vx) * h;
      vy += (ky * (ty - y) - cy * vy) * h;
      x += vx * h;
      y += vy * h;
      const rem = Math.hypot(gx - x, gy - y);
      done = !holding && (rem < reach || (rem < 0.3 && Math.hypot(vx, vy) < 4));
    }
    if (done || i % 4 === 0) out.push({ t, x, y, vx, vy });
    if (done) break;
  }
  return out;
}

/** Plays a path on the clone (replacing the one it was on); `then` runs when it has been flown. */
function run(f: Flight, path: Sample[], then?: () => void) {
  const t0 = path[0].t;
  const dur = Math.max(1, path[path.length - 1].t - t0);
  const frames: Keyframe[] = path.map((p) => ({ offset: Math.min(1, (p.t - t0) / dur), transform: `translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, 0)` }));
  if (frames.length < 2) frames.push({ ...frames[0], offset: 1 });
  frames[frames.length - 1].offset = 1;
  const old = f.anim;
  f.path = path;
  const a = (f.anim = f.el.animate(frames, { duration: dur, easing: 'linear', fill: 'forwards' }));
  old?.cancel();
  if (then) a.finished.then(() => f.anim === a && !f.ending && then(), () => {});
}

/** Where the words are right now on their path (read from the animation's own clock). */
function whereNow(f: Flight): Sample {
  const p = f.path;
  const t = p[0].t + (Number(f.anim?.currentTime) || 0);
  for (let i = 1; i < p.length; i++) {
    if (p[i].t < t) continue;
    const a = p[i - 1];
    const b = p[i];
    const u = (t - a.t) / Math.max(1, b.t - a.t);
    return { t, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, vx: a.vx + (b.vx - a.vx) * u, vy: a.vy + (b.vy - a.vy) * u };
  }
  // The path is flown: the words rest at its end.
  const e = p[p.length - 1];
  return { t: Math.max(t, e.t), x: e.x, y: e.y, vx: 0, vy: 0 };
}

/**
 * The last stretch. The words are within reach of their landing. Whatever they land in (the
 * message row with its forming bubble) takes the words' offset and the two ride home together on
 * one compositor animation that starts at the speed the spring had, so the bubble is pulled out
 * of the ground by the arriving words. Words that are the same lines as the real ones swap at
 * once and the real text rides (the conversation may still be gliding under them); others
 * dissolve into it on the way.
 */
function arrive(f: Flight) {
  const target = f.target;
  if (!target?.isConnected || (f.dest === 'timeline' && !certainTarget(target))) return abort(f);
  const end = f.path[f.path.length - 1];
  const z = uiZoom();
  const r = target.getBoundingClientRect();
  const gx = r.left / z - f.start.left;
  const gy = r.top / z - f.start.top;
  const ox = end.x - gx;
  const oy = end.y - gy;
  const rem = Math.max(1, Math.hypot(ox, oy));
  const dur = f.rider ? FORM : FORM_TRAY;
  // A curve that leaves at the spring's speed (its first slope), then brakes onto the landing.
  const slope = Math.min(3, Math.max(1, (Math.hypot(end.vx, end.vy) * (dur / 1000)) / rem));
  const ride: KeyframeAnimationOptions = { duration: dur, easing: `cubic-bezier(0.25, ${(0.25 * slope).toFixed(3)}, 0.3, 1)`, fill: 'backwards' };
  const frames: Keyframe[] = [{ translate: `${ox.toFixed(2)}px ${oy.toFixed(2)}px` }, { translate: '0px 0px' }];
  f.el.style.transform = `translate3d(${gx.toFixed(2)}px, ${gy.toFixed(2)}px, 0)`;
  const own = f.el.animate(frames, ride);
  f.anim?.cancel();
  f.anim = null;
  if (f.rider) {
    f.rider.animate(frames, ride);
    f.onCatch?.();
    f.onCatch = undefined;
    // Inside a view that is still fading in (the first message of a session) the clone stays on
    // top until the ride ends; nothing scrolls under it there.
    if (f.cut && !f.first) return land(f);
    if (!f.cut) crossfade(f);
  }
  const done = () => land(f);
  own.finished.then(done, done);
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
  window.clearTimeout(f.timer);
  if (f.target) f.target.style.opacity = '';
  f.el.remove();
  drop(f);
}

function abort(f: Flight) {
  if (f.ending) return;
  f.ending = true;
  window.clearTimeout(f.timer);
  if (f.target) f.target.style.opacity = '';
  // A bubble that was waiting for these words shows itself.
  f.onCatch?.();
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

/** Whether `target` (a message's text in the conversation) is a place the words may fly to. */
function certainTarget(target: HTMLElement): boolean {
  const content = target.closest<HTMLElement>('.tl-content');
  const scroller = content?.parentElement;
  if (!content || !scroller) return false;
  const z = uiZoom();
  const c = content.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  const col = columnEdges(c.left / z, c.width / z, columnToken());
  const box = { left: r.left / z, right: r.right / z, top: r.top / z, bottom: r.bottom / z, width: r.width / z, height: r.height / z };
  return landingCertain(box, col, { top: s.top / z, bottom: s.bottom / z });
}

function aim(f: Flight, target: HTMLElement, oneLineTarget: boolean) {
  const z = uiZoom();
  const r = target.getBoundingClientRect();
  const cs = getComputedStyle(target);
  f.target = target;
  // The words take the landing's type now, early in the trip (a queue row is 13 px, a message 14):
  // set, not scaled, so they arrive pixel for pixel on the real ones and the swap can be a cut.
  if (cs.fontSize !== f.el.style.fontSize || cs.lineHeight !== f.el.style.lineHeight) {
    f.el.style.fontSize = cs.fontSize;
    f.el.style.lineHeight = cs.lineHeight;
    f.el.style.letterSpacing = cs.letterSpacing;
    f.size = parseFloat(cs.fontSize) || f.size;
  }
  // Wrapped words take the landing's own measure and wrapping too, so their lines are the real
  // lines (one more reflow of the clone, early in the trip) and the swap can still be a cut.
  if (!oneLineTarget && f.el.offsetHeight > (parseFloat(cs.lineHeight) || 22) * 1.5) {
    f.el.style.setProperty('text-wrap', cs.getPropertyValue('text-wrap'));
    f.el.style.width = `${(r.width / z).toFixed(2)}px`;
  }
  const tx = r.left / z - f.start.left;
  const ty = r.top / z - f.start.top;
  const dist0 = Math.max(1, Math.hypot(tx, ty));
  const from = whereNow(f);
  // Words that were only lifting (no guess to fly toward) are thrown now that the landing is known.
  if (from.t > f.release && !f.guess) {
    from.vx += (f.sideways ? THROW : THROW_FOLLOW) * (tx - from.x);
    from.vy += (f.sideways ? THROW_FOLLOW : THROW) * (ty - from.y);
  }
  const lh = parseFloat(cs.lineHeight) || 22;
  const lines = Math.round(r.height / z / lh);
  const cloneLines = Math.round(f.el.offsetHeight / (parseFloat(getComputedStyle(f.el).lineHeight) || 22));
  // The same lines at the same measure (a one-line message, or wrapped words that took the
  // bubble's measure and fit whole): the swap is a cut. Anything else dissolves on arrival.
  const whole = f.el.scrollHeight <= f.el.offsetHeight + 1;
  const oneLine = cloneLines <= 1 && (lines <= 1 || oneLineTarget);
  const sameWrap = !oneLineTarget && whole && cloneLines === lines && Math.abs(r.width / z - f.el.offsetWidth) < 1.5;
  f.cut = oneLine || sameWrap;
  target.style.opacity = '0';
  // The real landing takes over from the guess: the path goes on from where the words are, at their speed.
  run(f, fly(f, from, tx, ty, Math.max(REACH_MIN, dist0 * REACH)), () => arrive(f));
}

/**
 * A message mounted in the conversation (`root` is its `.user` element). When its words are in
 * the air, they land here: the row skips its own entrance and stays clear until the words are
 * within reach, then it rides home with them while the bubble resolves out of the ground in
 * dither around them (its right edge where it will stay, a spring settling its size). Returns
 * true when a clone took it.
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
  // A row that is not where a message belongs (off the column, out of reach, not laid out): the
  // words fade where they are, near the composer, and the row makes its own entrance.
  if (!certainTarget(textEl)) {
    abort(f);
    return false;
  }
  root.setAttribute('data-flight', '');
  for (const a of root.getAnimations()) a.cancel();
  f.rider = root;
  const steer = f.steer || !!opts.steer;
  const side = [...root.querySelectorAll<HTMLElement>('.user-mark, .user-wire')];
  // The row paints outside its own box while it rides in (rows are paint-contained at rest).
  const row = root.closest<HTMLElement>('.tl-item');
  card.style.visibility = 'hidden';
  for (const el of side) el.style.visibility = 'hidden';
  f.onCatch = () => {
    card.style.visibility = '';
    if (row) {
      row.style.contentVisibility = 'visible';
      window.setTimeout(() => (row.style.contentVisibility = ''), FORM + 80);
    }
    // The words come to rest and the rule writes itself down their left edge: a short ivory
    // stroke that cools into the hairline (timeline.css `.user-card[data-draw]`).
    card.setAttribute('data-draw', '');
    window.setTimeout(() => card.removeAttribute('data-draw'), 700);
    for (const el of side) {
      el.style.visibility = '';
      // The mark follows the bubble; the wire of a steer draws itself (timeline.css).
      if (el.classList.contains('user-mark')) play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 110, easing: 'linear', fill: 'backwards' });
      else el.setAttribute('data-draw', '');
    }
    // Into the running turn: the words cool to the waiting tone as they are caught.
    if (steer) play(card, [{ opacity: 1 }, { opacity: 0.6 }], { duration: 220, easing: 'linear' });
  };
  aim(f, textEl, false);
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
