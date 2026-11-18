import { EASE_OUT, play, reducedMotion, uiZoom } from '@/lib/motion';
import { holdSend } from './settle';

/**
 * A sent message leaves the composer as what it is about to be: its bubble. On send the words are
 * copied into a fixed layer exactly where they stood in the field, already set as the message card
 * (the conversation's own `.user-card`, scaled to the field's type), and the field is empty and
 * live at once. The card's surface forms around the words while the key gives (`RELEASE` ms), then
 * the bubble is thrown: one spring per axis, the leading one a little stiffer, so the path is a
 * shallow arc that brakes onto the landing with the smallest settle. It is in place in about
 * 350 ms.
 *
 * - Where it lands is known before the row exists (guessed from the stage's geometry, the same
 *   numbers timeline.css lays the row out with), so the bubble is on its way in the first frame.
 *   When the real row mounts it stays hidden, the bubble becomes a copy of its card (same width,
 *   same lines, marks and attachments) and the spring is re-aimed at where the row will rest once
 *   the conversation has followed it, keeping its speed.
 * - The landing is a cut: the copy sits pixel for pixel on the real card and the two swap in one
 *   frame. A row that is still moving then (the view catching up, a line arriving above it) takes
 *   the small remainder itself and settles.
 * - The first message from home flies to the top of the column and waits there as the finished
 *   bubble until the session's own row takes over under it.
 * - A message queued while a turn runs is not a bubble: its words fly into the tray row as text.
 * - When its row is late (a loaded machine, a slow bridge), the bubble rests where it arrived and
 *   says so: it steps back to the waiting tone and a hairline fills slowly along its lower edge,
 *   both on the compositor, so they move while the main thread is busy mounting. It holds until
 *   the row is there (or the bridge refuses the message: then it flies back into the field with
 *   its words), and the line finishes on the row as they swap.
 * - The whole path is stepped ahead of time and handed to the compositor as one transform
 *   animation, so a busy main thread (a session mounting, a turn starting) cannot make it stutter.
 * Under reduced motion there are no clones: the items fade in as before.
 */

export type FlightDest = 'timeline' | 'tray';

/** The beat the key, the bubble and the backdrop share: ms from the press to the release. */
export const RELEASE = 40;

/** A point on the path: ms since the launch, offset from the start (px), speed (px/s). */
export interface Sample {
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
  /** Ms after the launch at which it leaves the field (it gathers until then). */
  release: number;
  /** The path it is on (compositor animation) and its samples. */
  anim: Animation | null;
  path: Sample[];
  /** The path has been flown and nothing has taken the bubble yet (it waits where it landed). */
  resting: boolean;
  timer: number;
  /** Where the clone's box starts (its untransformed place) and the scale it starts at. */
  start: { left: number; top: number };
  s0: number;
  /** The sideways axis leads (a steer, the first message from home); otherwise the rise does. */
  sideways: boolean;
  /** What it lands on: the message's card in the conversation, or the tray row's text. */
  target: HTMLElement | null;
  /** A bubble flying to a guessed landing: its path is never replaced, the inner layer corrects it. */
  guessed: boolean;
  fix: { x: number; y: number };
  fixing: boolean;
  /** The conversation row that is hidden until the bubble lands on it. */
  row: HTMLElement | null;
  ending: boolean;
  /** Runs as the real message takes over (the steer's wire). */
  onLand?: () => void;
  /** Lands the send for `settle.ts` (the chrome waiting on it goes on). */
  done: () => void;
  /** The waiting state (the tone and the hairline), set to start once the path has been flown. */
  wait: Animation[];
  line: HTMLElement | null;
  /** When it left, and the bridge's answer about the message (see bubbleHold). */
  t0: number;
  answer: HoldAnswer;
  answeredAt: number;
}

/** What the composer keeps of a launch: the bridge's answer decides how the wait ends. */
export interface FlightHandle {
  /**
   * The bridge took the message (`true`: its row has a little while left to appear, then the bubble
   * lets go) or refused it (`false`: the bubble flies back into the field; resolves once it is there,
   * for the words to be put back).
   */
  settle(ok: boolean): Promise<void>;
}

const pending: Flight[] = [];
/** Messages that mounted in the conversation with no clone in the air yet (a tray row may still leave). */
const unclaimed: { key: string; root: HTMLElement; at: number }[] = [];

const norm = (t: string) => t.trim().replace(/\s+/g, ' ').slice(0, 160);
const matches = (flightKey: string, text: string) => {
  const k = norm(text);
  return !!flightKey && (k === flightKey || k.startsWith(flightKey) || flightKey.startsWith(k));
};

/** Lines the words for the tray fly with. */
const MAX_LINES = 4;
/** Words for the tray that nothing has claimed fade after this long; none outlives the last. */
const NO_CLAIM_MS = 1400;
const MAX_LIFE_MS = 6000;
/**
 * A bubble holds for its row: at most this long while the bridge has not answered (a new session
 * may still be starting on a loaded machine), and this long once it has taken the message (its row
 * is in the store by then; one that does not show is in a view no longer on screen).
 */
export const HOLD_MS = 15000;
export const ACKED_MS = 3000;

/** What the bridge has said about a sent message so far. */
export type HoldAnswer = 'pending' | 'taken' | 'refused';

/**
 * What a bubble in the air does about its row, decided again whenever something changes. It never
 * fades for being late: it lands once its row is there, flies back into the field when the bridge
 * refused the message, and lets go only when the row has not shown `ACKED_MS` after the bridge took
 * the message (it is in a view no longer on screen) or after `HOLD_MS` without any answer. Pure, so
 * the hold can be tested.
 */
export function bubbleHold(s: { row: boolean; answer: HoldAnswer; sinceLaunch: number; sinceAnswer: number }): 'land' | 'hold' | 'back' | 'release' {
  if (s.row) return 'land';
  if (s.answer === 'refused') return 'back';
  if (s.answer === 'taken' && s.sinceAnswer >= ACKED_MS) return 'release';
  if (s.sinceLaunch >= HOLD_MS) return 'release';
  return 'hold';
}

/** When the waiting state begins, in ms after the key, for a path flown in `pathEnd` ms. */
export const waitStart = (pathEnd: number) => Math.max(WAIT_MIN, pathEnd + WAIT_AFTER);
/** The waiting state starts this long after the path has been flown, and never before `WAIT_MIN` after the key. */
const WAIT_AFTER = 120;
const WAIT_MIN = 380;
/** The waiting tone (a queued or steered message's, timeline.css `.user[data-queued] .user-card`). */
const WAIT_TONE = 0.6;
/** The hairline's slow fill: quick at first, then ever slower, never quite to the end on its own. */
const WAIT_FILL = 9000;
const WAIT_REACH = 0.94;
/** Where a queued message's row will be, from the field's text: the tray's last row, just above the card. */
const TRAY_GUESS = { x: 21, y: -46 };

/** A message card's type and padding (timeline.css `.user-card`). */
const CARD_FONT = 15;
const CARD_LINE = CARD_FONT * 1.55;
const TEXT_INSET = 15;
const CARD_PAD_TOP = 9;
/** The widest a card grows: this share of the reading column. */
const CARD_SHARE = 0.8;
/** The first message's card sits this far under the top of the stage (the conversation's top padding). */
const FIRST_TOP = 56;
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

/**
 * Where the first message's card sits in a new session, from the stage alone (before the session
 * exists): its right edge on the reading column's, its top under the conversation's top padding.
 */
export function firstLanding(stage: { left: number; top: number; width: number }, column: number, card: { width: number }): { left: number; top: number } {
  return { left: columnEdges(stage.left, stage.width, column).right - card.width, top: stage.top + FIRST_TOP };
}

/**
 * Where the card will sit, guessed before its row exists (as an offset from the clone's start).
 * In an open conversation: just under the last row, or just above the dock once the view has
 * followed it. The real row corrects the aim a few ms later.
 */
function guessLanding(f: Flight, from: HTMLElement, first: boolean): { x: number; y: number } | null {
  const z = uiZoom();
  const column = columnToken();
  const w = f.el.offsetWidth;
  const h = f.el.offsetHeight;
  if (first) {
    const sb = document.querySelector('.stage-body')?.getBoundingClientRect();
    if (!sb) return null;
    const to = firstLanding({ left: sb.left / z, top: sb.top / z, width: sb.width / z }, column, { width: w });
    return { x: to.left - f.start.left, y: to.top - f.start.top };
  }
  const contents = document.querySelectorAll<HTMLElement>('.tl-content');
  // Two conversations on stage (a session switch is fading one out): the bubble waits for the real row.
  if (contents.length !== 1) return null;
  const content = contents[0];
  const c = content.getBoundingClientRect();
  const right = columnEdges(c.left / z, c.width / z, column).right;
  const card = from.closest('.cmp-card')?.getBoundingClientRect();
  const last = [...content.children].reverse().find((n) => !n.classList.contains('tail'));
  const after = last ? last.getBoundingClientRect().bottom / z + 26 : c.top / z + FIRST_TOP;
  const y = Math.min(card ? card.top / z - 64 - h : after, after);
  const sc = content.parentElement?.getBoundingClientRect();
  if (sc && !(y >= sc.top / z && y + h <= (card ? card.top : sc.bottom) / z + 1)) return null;
  return { x: right - w - f.start.left, y: y - f.start.top };
}

interface Source {
  el: HTMLElement;
  /** The words, as shown in `el` (its text box: padding excluded, scroll applied). */
  text: string;
  oneLine?: boolean;
}

/** Where the words stand in their source, and their type. */
function measure(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const z = uiZoom();
  const r = el.getBoundingClientRect();
  if (!r.width) return null;
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const size = parseFloat(cs.fontSize) || 14;
  return { cs, left: r.left / z + padL, top: r.top / z + padT - el.scrollTop, width: r.width / z - padL - padR, size, line: parseFloat(cs.lineHeight) || size * 1.5 };
}

const LAYER = 'position:fixed;z-index:60;margin:0;pointer-events:none;transform-origin:0 0;will-change:transform;';

/** The words as plain text, for the tray. */
function makeWords({ el, text }: Source): { clone: HTMLDivElement; left: number; top: number; s0: number } | null {
  const m = measure(el);
  if (!m) return null;
  const clone = document.createElement('div');
  clone.className = 'send-flight';
  clone.setAttribute('aria-hidden', 'true');
  clone.style.setProperty('--lines', String(MAX_LINES));
  clone.style.cssText += `left:${m.left}px;top:${m.top}px;width:${m.width}px;font-size:${m.cs.fontSize};line-height:${m.cs.lineHeight};font-family:${m.cs.fontFamily};font-weight:${m.cs.fontWeight};letter-spacing:${m.cs.letterSpacing};`;
  clone.textContent = text;
  return { clone, left: m.left, top: m.top, s0: 1 };
}

/**
 * The words as their bubble: the conversation's own card, placed and scaled so its text stands
 * exactly on the words in the source (the field is 14 px, a message 15).
 */
function makeBubble({ el, text }: Source): { clone: HTMLDivElement; left: number; top: number; s0: number } | null {
  const m = measure(el);
  if (!m) return null;
  const s0 = Math.min(1, m.size / CARD_FONT);
  const left = m.left - TEXT_INSET * s0;
  const top = m.top - CARD_PAD_TOP * s0 + (m.line - CARD_LINE * s0) / 2;
  const z = uiZoom();
  const stage = document.querySelector('.stage-body')?.getBoundingClientRect();
  const max = stage ? Math.floor(columnEdges(0, stage.width / z, columnToken()).width * CARD_SHARE) : 600;
  const clone = document.createElement('div');
  clone.className = 'send-bubble';
  clone.setAttribute('aria-hidden', 'true');
  clone.style.cssText = `${LAYER}left:${left}px;top:${top}px;width:max-content;max-width:${max}px;display:flex;transform:scale(${s0});`;
  // The inner layer takes the correction when the real landing differs from the guess.
  const inner = document.createElement('div');
  inner.style.cssText = 'display:flex;flex:1 1 auto;min-width:0;will-change:transform;';
  const card = document.createElement('div');
  card.className = 'user-card';
  card.style.cssText = 'flex:1 1 auto;max-width:none;';
  const words = document.createElement('div');
  words.className = 'user-text';
  // A long message is clipped in the conversation too (timeline.css `.user-text[data-clipped]`).
  words.style.cssText = 'max-height:232px;overflow:hidden;';
  words.textContent = text;
  card.appendChild(words);
  inner.appendChild(card);
  clone.appendChild(inner);
  return { clone, left, top, s0 };
}

/**
 * Lifts `text` out of `source` (the composer's field, or a queue row's text) and keeps it in the
 * air until something with the same text claims it. Call before the field is cleared.
 */
export function launchFlight(source: Source, opts: { dest: FlightDest; steer?: boolean; first?: boolean }): FlightHandle | null {
  if (reducedMotion() || !source.text.trim()) return null;
  const bubble = opts.dest === 'timeline';
  const made = bubble ? makeBubble(source) : makeWords(source);
  if (!made) return null;
  const { clone, left, top, s0 } = made;
  document.body.appendChild(clone);
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
    resting: false,
    timer: 0,
    start: { left, top },
    s0,
    sideways: steer || !!opts.first,
    target: null,
    guessed: false,
    fix: { x: 0, y: 0 },
    fixing: false,
    row: null,
    ending: false,
    done: holdSend(),
    wait: [],
    line: null,
    t0: now,
    answer: 'pending',
    answeredAt: 0,
  };
  pending.push(f);
  // The card's surface forms around the words while the key gives.
  if (bubble) clone.querySelector('.user-card')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 80, easing: 'linear', pseudoElement: '::before' });
  // On its way at once: toward the guess, or a short lift until the landing is known.
  // A queued message leaves the field for the tray just above the card, before its row exists.
  const guess = opts.dest === 'tray' ? TRAY_GUESS : guessLanding(f, source.el, !!opts.first);
  f.guessed = bubble && !!guess;
  const path = fly(f, { t: 0, x: 0, y: 0, vx: 0, vy: 0 }, guess?.x ?? 0, guess?.y ?? -18);
  run(f, path, () => rest(f));
  // The waiting state is set now, to begin once the path has been flown: on the compositor, it
  // shows on time even while the main thread is busy mounting the row it waits for.
  if (bubble) waitFrom(f, waitStart(path[path.length - 1].t));
  if (bubble) review(f);
  else f.timer = window.setTimeout(() => !f.target && abort(f), NO_CLAIM_MS);
  // Whatever happens on the way, no clone outlives this: the real message always shows.
  window.setTimeout(() => abort(f), bubble ? HOLD_MS + 2000 : MAX_LIFE_MS);
  // A conversation row that mounted first (the bridge answered before this row left the tray).
  if (opts.dest === 'timeline') {
    const i = unclaimed.findIndex((u) => now - u.at < 400 && u.root.isConnected && matches(f.key, u.key));
    if (i >= 0) {
      const u = unclaimed.splice(i, 1)[0];
      landInTimeline(u.root, u.key, { steer, late: true });
    }
  }
  return { settle: (ok) => settle(f, ok) };
}

/** The waiting state, from `at` ms after the launch: the bubble at the waiting tone, a hairline filling along its lower edge. */
function waitFrom(f: Flight, at: number) {
  const inner = f.el.firstElementChild as HTMLElement | null;
  if (!inner) return;
  inner.style.position = 'relative';
  const line = document.createElement('i');
  line.className = 'send-wait';
  line.setAttribute('aria-hidden', 'true');
  inner.appendChild(line);
  f.line = line;
  const tone = inner.animate([{ opacity: 1 }, { opacity: WAIT_TONE }], { duration: 260, delay: at, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'forwards' });
  const fill = line.animate(
    [
      { transform: 'scaleX(0)', opacity: 0 },
      { transform: `scaleX(${(WAIT_REACH * 0.03).toFixed(3)})`, opacity: 1, offset: 0.015 },
      { transform: `scaleX(${WAIT_REACH})`, opacity: 1 },
    ],
    { duration: WAIT_FILL, delay: at, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' },
  );
  f.wait = [tone, fill];
}

/** Whether the waiting state has begun (its animations are past their delay). */
const waiting = (f: Flight) => f.wait.length > 0 && f.wait[0].effect?.getComputedTiming().progress != null;

function endWait(f: Flight) {
  for (const a of f.wait) a.cancel();
  f.wait = [];
}

/**
 * The swap after a wait: the row takes the bubble's tone and steps up to its own, and the hairline
 * runs to the end along the row's edge and fades, so the wait visibly completes as the message lands.
 */
function finishWait(f: Flight, card: HTMLElement) {
  const inner = f.el.firstElementChild as HTMLElement | null;
  const tone = inner ? parseFloat(getComputedStyle(inner).opacity) || WAIT_TONE : WAIT_TONE;
  const scale = f.line ? new DOMMatrixReadOnly(getComputedStyle(f.line).transform).a : 0;
  play(card, [{ opacity: tone }, { opacity: 1 }], { duration: 200, easing: EASE_OUT });
  const line = document.createElement('i');
  line.className = 'send-wait';
  line.setAttribute('aria-hidden', 'true');
  card.appendChild(line);
  // It runs to the end (the first half), then lets go (the second).
  const run = play(
    line,
    [
      { transform: `scaleX(${scale.toFixed(4)})`, opacity: 1, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' },
      { transform: 'scaleX(1)', opacity: 1, offset: 0.5, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
      { transform: 'scaleX(1)', opacity: 0 },
    ],
    { duration: 380, easing: 'linear', fill: 'forwards' },
  );
  const gone = () => line.remove();
  if (run) run.finished.then(gone, gone);
  else gone();
}

/** A bubble's hold, decided now and again when it could next change (see bubbleHold). */
function review(f: Flight) {
  window.clearTimeout(f.timer);
  if (f.ending || f.target) return;
  const now = performance.now();
  const sinceLaunch = now - f.t0;
  const sinceAnswer = f.answer === 'pending' ? 0 : now - f.answeredAt;
  const next = bubbleHold({ row: false, answer: f.answer, sinceLaunch, sinceAnswer });
  if (next === 'release') return abort(f);
  if (next === 'back') return void goBack(f);
  const wait = f.answer === 'taken' ? Math.min(ACKED_MS - sinceAnswer, HOLD_MS - sinceLaunch) : HOLD_MS - sinceLaunch;
  f.timer = window.setTimeout(() => review(f), Math.max(16, wait));
}

/** The bridge's answer (see FlightHandle). */
function settle(f: Flight, ok: boolean): Promise<void> {
  if (f.ending) return Promise.resolve();
  if (!ok) {
    f.answer = 'refused';
    return goBack(f);
  }
  f.answer = 'taken';
  f.answeredAt = performance.now();
  if (f.dest === 'timeline') review(f);
  return Promise.resolve();
}

/**
 * Refused: the bubble flies back to where its words stood in the field, shrinking to the field's
 * type while its surface dissolves, and is gone as the words are put back (the caller does that
 * when this resolves).
 */
function goBack(f: Flight): Promise<void> {
  f.ending = true;
  window.clearTimeout(f.timer);
  drop(f);
  const shown = f.row ?? f.target;
  if (shown) shown.style.opacity = '';
  const from = whereNow(f);
  const inner = f.el.firstElementChild as HTMLElement | null;
  const tone = inner ? parseFloat(getComputedStyle(inner).opacity) || 1 : 1;
  endWait(f);
  f.line?.remove();
  const fix = f.fix;
  f.fix = { x: 0, y: 0 };
  for (const a of inner?.getAnimations() ?? []) a.cancel();
  // The inner layer's correction is folded into the path back.
  const path = springPath({ ...from, x: from.x + fix.x, y: from.y + fix.y, t: 0 }, 0, 0, { sideways: f.sideways });
  const end = path[path.length - 1].t || 1;
  const frames: Keyframe[] = path.map((p) => {
    const u = p.t / end;
    return { offset: Math.min(1, u), transform: `translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, 0) scale(${(1 + (f.s0 - 1) * Math.min(1, u * 1.4)).toFixed(4)})` };
  });
  frames[frames.length - 1].offset = 1;
  f.anim?.cancel();
  const back = play(f.el, frames, { duration: end, easing: 'linear', fill: 'forwards' });
  if (inner && tone < 1) play(inner, [{ opacity: tone }, { opacity: 1 }], { duration: 160, easing: EASE_OUT, fill: 'forwards' });
  // The surface goes as the words settle back into the field.
  play(f.el.querySelector('.user-card'), [{ opacity: 1 }, { opacity: 0 }], { duration: Math.min(end, 220), delay: Math.max(0, end - 220), easing: 'linear', pseudoElement: '::before', fill: 'forwards' });
  return new Promise((resolve) => {
    const gone = () => {
      f.el.remove();
      f.done();
      resolve();
    };
    if (back) back.finished.then(gone, gone);
    else gone();
  });
}

/** The springs (stiffness, damping): the axis that leads and the one that follows. Both settle with the smallest overshoot. */
const LEAD = { k: 520, c: 40 };
const FOLLOW = { k: 460, c: 38 };
/** The throw: each axis leaves at this share of its trip per second, so the first frames cover ground. */
const THROW = 4;
const THROW_FOLLOW = 1.5;
/** How far it sinks while the key gives (px). */
const DIP = 2;
/** The bubble grows from the field's type to the message's over this long (ms after the release). */
const GROW = 150;

/**
 * The path from `from` to a landing at (gx, gy), stepped ahead of time (semi-implicit Euler, 4 ms
 * steps, a sample every 16 ms): the gather (it sinks a touch while the key gives), the throw at
 * the release, then one spring per axis until it rests exactly on the landing. Pure, so the
 * landing can be tested.
 */
export function springPath(from: Sample, gx: number, gy: number, opts: { release?: number; sideways?: boolean } = {}): Sample[] {
  const release = opts.release ?? 0;
  const out = [from];
  let { t, x, y, vx, vy } = from;
  // A path that starts after the release (a re-aim) is already thrown.
  let thrown = t > release;
  const sx = opts.sideways ? LEAD : FOLLOW;
  const sy = opts.sideways ? FOLLOW : LEAD;
  const h = 0.004;
  for (let i = 1; i < 400; i++) {
    t += 4;
    let done = false;
    if (t <= release) y = DIP * Math.sin((t / release) * Math.PI * 0.5);
    else {
      if (!thrown) {
        thrown = true;
        vx = (opts.sideways ? THROW : THROW_FOLLOW) * (gx - x);
        vy = (opts.sideways ? THROW_FOLLOW : THROW) * (gy - y);
      }
      vx += (sx.k * (gx - x) - sx.c * vx) * h;
      vy += (sy.k * (gy - y) - sy.c * vy) * h;
      x += vx * h;
      y += vy * h;
      done = Math.hypot(gx - x, gy - y) < 0.4 && Math.hypot(vx, vy) < 12;
    }
    if (done) {
      out.push({ t, x: gx, y: gy, vx: 0, vy: 0 });
      break;
    }
    if (i % 4 === 0) out.push({ t, x, y, vx, vy });
  }
  return out;
}

const fly = (f: Flight, from: Sample, gx: number, gy: number) => springPath(from, gx, gy, { release: f.release, sideways: f.sideways });

/** The clone's scale at `t` ms after the launch: the field's type growing into the message's. */
function scaleAt(f: Flight, t: number): number {
  if (f.s0 >= 1) return 1;
  const u = Math.min(1, Math.max(0, (t - f.release) / GROW));
  return f.s0 + (1 - f.s0) * (1 - (1 - u) * (1 - u));
}

/** Plays a path on the clone (replacing the one it was on); `then` runs when it has been flown. */
function run(f: Flight, path: Sample[], then?: () => void) {
  const t0 = path[0].t;
  const dur = Math.max(1, path[path.length - 1].t - t0);
  const frames: Keyframe[] = path.map((p) => ({
    offset: Math.min(1, (p.t - t0) / dur),
    transform: `translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, 0) scale(${scaleAt(f, p.t).toFixed(4)})`,
  }));
  if (frames.length < 2) frames.push({ ...frames[0], offset: 1 });
  frames[frames.length - 1].offset = 1;
  const old = f.anim;
  f.path = path;
  f.resting = false;
  const a = (f.anim = f.el.animate(frames, { duration: dur, easing: 'linear', fill: 'forwards' }));
  old?.cancel();
  if (then) a.finished.then(() => f.anim === a && !f.ending && then(), () => {});
}

/** Where the clone is right now on its path (read from the animation's own clock). */
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
  // The path is flown: it rests at its end.
  const e = p[p.length - 1];
  return { t: Math.max(t, e.t), x: e.x, y: e.y, vx: 0, vy: 0 };
}

/** The target's place as an offset from the clone's start: where it is now and where it will rest. */
function targetAt(f: Flight): { x: number; y: number; restY: number } | null {
  const t = f.target;
  if (!t?.isConnected) return null;
  const z = uiZoom();
  const r = t.getBoundingClientRect();
  if (!r.width) return null;
  const x = r.left / z - f.start.left;
  const y = r.top / z - f.start.top;
  // The conversation follows a sent message to its end: the row rests that much higher.
  const sc = f.dest === 'timeline' ? t.closest<HTMLElement>('.tl-content')?.parentElement : null;
  const gap = sc ? Math.max(0, sc.scrollHeight - sc.clientHeight - sc.scrollTop) : 0;
  return { x, y, restY: y - gap };
}

/** The path has been flown. With a target the real thing takes over; without one the bubble waits. */
function rest(f: Flight) {
  f.resting = true;
  if (!f.target || f.fixing) return;
  if (f.dest === 'tray') still(f);
  else land(f);
}

/**
 * The tray opens under the words (its height animates), so its row is still moving when they
 * arrive: they hover where the row will be until it has come to rest, then the two swap. A few
 * frames of polling, once.
 */
function still(f: Flight) {
  let last: { x: number; y: number } | null = null;
  let tries = 0;
  const tick = () => {
    if (f.ending) return;
    const to = targetAt(f);
    if (!to) return abort(f);
    if ((last && Math.abs(to.x - last.x) < 0.3 && Math.abs(to.y - last.y) < 0.3) || ++tries > 45) return land(f);
    last = to;
    requestAnimationFrame(tick);
  };
  tick();
}

/**
 * The swap. The clone sits on the real card: one goes, the other shows, in one frame. A row that
 * is not quite there (the view is still catching up, a line arrived above it) takes the remainder
 * itself and settles onto its place.
 */
function land(f: Flight) {
  if (f.ending) return;
  const to = targetAt(f);
  const end = f.path[f.path.length - 1];
  f.ending = true;
  window.clearTimeout(f.timer);
  const shown = f.row ?? f.target;
  if (shown) shown.style.opacity = '';
  if (f.dest === 'timeline' && f.target && waiting(f)) finishWait(f, f.target);
  endWait(f);
  if (to && shown) {
    const dx = end.x + f.fix.x - to.x;
    const dy = end.y + f.fix.y - to.y;
    if (Math.abs(dx) > 0.6 || Math.abs(dy) > 0.6) {
      // The row paints outside its own box while it settles (rows are paint-contained at rest).
      const item = shown.closest<HTMLElement>('.tl-item');
      if (item) {
        item.style.contentVisibility = 'visible';
        window.setTimeout(() => (item.style.contentVisibility = ''), 260);
      }
      play(shown, [{ translate: `${dx.toFixed(2)}px ${dy.toFixed(2)}px` }, { translate: '0px 0px' }], { duration: 200, easing: EASE_OUT });
    }
  }
  f.onLand?.();
  f.el.remove();
  drop(f);
  f.done();
}

function abort(f: Flight) {
  if (f.ending) return;
  f.ending = true;
  window.clearTimeout(f.timer);
  const shown = f.row ?? f.target;
  if (shown) shown.style.opacity = '';
  const done = () => f.el.remove();
  const a = play(f.el, [{ opacity: 0 }], { duration: 140, easing: 'linear', fill: 'forwards' });
  if (a) a.finished.then(done, done);
  else done();
  drop(f);
  f.done();
}

function drop(f: Flight) {
  const i = pending.indexOf(f);
  if (i >= 0) pending.splice(i, 1);
}

function claim(dest: FlightDest, text: string): Flight | null {
  const i = pending.findIndex((f) => f.dest === dest && !f.target && !f.ending && matches(f.key, text));
  return i >= 0 ? pending[i] : null;
}

/** Whether `target` (a message's card in the conversation) is a place the bubble may fly to. */
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

/**
 * The real landing takes over from the guess. A bubble on its way to a guessed place keeps its
 * path untouched (replacing a compositor animation while the main thread is busy mounting the row
 * would hold it still for a moment): the difference is eased in on the inner layer over what is
 * left of the trip, so the sum lands exactly. Anything else is re-aimed from where it is, at its speed.
 */
function aim(f: Flight) {
  const to = targetAt(f);
  if (!to) return abort(f);
  if (f.guessed) {
    const end = f.path[f.path.length - 1];
    const dx = to.x - end.x;
    const dy = to.restY - end.y;
    f.fix = { x: dx, y: dy };
    if (Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6) {
      f.fix = { x: 0, y: 0 };
      if (f.resting) land(f);
      return;
    }
    const left = f.resting ? 0 : end.t - whereNow(f).t;
    const inner = f.el.firstElementChild;
    const a = inner?.animate([{ transform: 'translate3d(0px, 0px, 0)' }, { transform: `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0)` }], {
      duration: Math.max(180, left),
      easing: 'cubic-bezier(0.3, 0, 0.2, 1)',
      fill: 'forwards',
    });
    if (!a) return land(f);
    f.fixing = true;
    const done = () => {
      f.fixing = false;
      if (f.resting) land(f);
    };
    a.finished.then(done, done);
    return;
  }
  // Words on their way to the tray keep their path too: the row they land on is still moving.
  if (f.dest === 'tray') {
    if (f.resting) still(f);
    return;
  }
  run(f, fly(f, whereNow(f), to.x, to.restY), () => rest(f));
}

/**
 * A message mounted in the conversation (`root` is its `.user` element). When its bubble is in
 * the air, it lands here: the row skips its own entrance and stays clear until the bubble sits on
 * it, then the two swap. Returns true when a clone took it.
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
  const card = root.querySelector<HTMLElement>('.user-card');
  if (!card) return false;
  // A row that is not where a message belongs (off the column, out of reach, not laid out): the
  // bubble fades where it is and the row makes its own entrance.
  if (!certainTarget(card)) {
    abort(f);
    return false;
  }
  root.setAttribute('data-flight', '');
  for (const a of root.getAnimations()) a.cancel();
  // The bubble becomes this card: the same width and lines, its marks and attachments.
  const z = uiZoom();
  const r = card.getBoundingClientRect();
  const copy = card.cloneNode(true) as HTMLElement;
  copy.style.cssText = `flex:none;max-width:none;width:100%;transition:none;opacity:${getComputedStyle(card).opacity};`;
  f.el.style.width = `${(r.width / z).toFixed(2)}px`;
  f.el.style.maxWidth = 'none';
  (f.el.firstElementChild ?? f.el).replaceChildren(copy);
  // The waiting hairline stays on its edge (its fill goes on where it was).
  if (f.line) f.el.firstElementChild?.appendChild(f.line);
  f.target = card;
  f.row = root;
  root.style.opacity = '0';
  const steer = f.steer || !!opts.steer;
  f.onLand = () => {
    // The wire of a steer draws itself down into the turn (timeline.css `.user-wire[data-draw]`).
    if (steer) root.querySelector('.user-wire')?.setAttribute('data-draw', '');
  };
  aim(f);
  return true;
}

/** A queued message's row appeared in the tray: the words from the field land on it. */
export function landInTray(textEl: HTMLElement, text: string): boolean {
  if (reducedMotion()) return false;
  const f = claim('tray', text);
  if (!f) return false;
  // The words take the row's type early in the trip (a queue row is 13 px), so the swap is a cut.
  const cs = getComputedStyle(textEl);
  f.el.style.fontSize = cs.fontSize;
  f.el.style.lineHeight = cs.lineHeight;
  f.el.style.letterSpacing = cs.letterSpacing;
  f.el.style.setProperty('--lines', '1');
  f.target = textEl;
  textEl.style.opacity = '0';
  aim(f);
  return true;
}

/** A queued message left the tray for the conversation: it lifts out of its row as the bubble. */
export function launchFromTray(textEl: HTMLElement, text: string) {
  if (reducedMotion()) return;
  launchFlight({ el: textEl, text, oneLine: true }, { dest: 'timeline' });
}

/** For tests and the dev console: clones in the air. */
export const flightsInAir = () => pending.length;
