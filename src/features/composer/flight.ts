import { EASE_OUT, play, reducedMotion, uiZoom } from '@/lib/motion';
import { CARD_FONT, CARD_LINE, CARD_PAD_TOP, CARD_PAD_X, isLongMessage } from '@/features/timeline/user-card';
import { holdSend } from './settle';
import { freezeLiquid, pour, prewarmLiquid, type Pour } from './liquid';
import { COLLAPSE, collapseAt, collapseEase, HAND, linearEasing, planLiquid, revealAt, shiftAt, shiftEase, type Box, type LiquidPlan, type LiquidSpec } from './liquid-shape';

/**
 * A sent message leaves the composer as liquid (liquid-shape.ts has the beats and the geometry):
 * the words gather into the bar's top-right corner as one piece while the field closes to one
 * line on the same curve; for a moment the bar is empty and at rest (it is live at once). Then a
 * bead of its ink rises out of the top edge there, lifts on a neck that thins and parts, flies to
 * the bottom-right of where the message will sit, stretched along its speed, and spreads there
 * into the card's shape, revealing the words in place as it covers them; the conversation's own
 * card then takes over in one cut.
 *
 * - Who draws what: the liquid is drawn by a worker on a canvas of its own (liquid.ts), the words
 *   are page layers animated on the compositor, both timed from the key on the same clock with
 *   keyframes taken from the same geometry. Nothing runs per frame on the main thread, so a
 *   session mounting or a turn starting cannot make it stutter.
 * - Where it lands is guessed before the row exists (from the stage's geometry, the numbers
 *   timeline.css lays the row out with). When the real row mounts it stays hidden until the card
 *   sits on it. A row known before the drop has left simply moves the landing; one known later
 *   shifts everything still to come (the drop, the sheet and the words alike) by the difference.
 * - The landing is a cut: the copy sits pixel for pixel on the real card and the two swap in one
 *   frame. A row that is still moving then takes the small remainder itself.
 * - The first message from home leaves the home composer the same way; the composer starts its
 *   glide to the dock as the drop breaks away (home/handoff.ts).
 * - A message queued while a turn runs lands in the queue tray's new row, melting into it.
 * - A queued message sent from its row gathers into a drop at the row's end and rises from there.
 * - When its row is late (a loaded machine, a slow bridge), the card waits where it landed and
 *   says so: it steps back to the waiting tone and a hairline fills slowly along its lower edge,
 *   on the compositor. It holds until the row is there (or the bridge refuses the message: then
 *   it goes back into the field with its words).
 * Under reduced motion there is none of this: the items fade in as before.
 */

export type FlightDest = 'timeline' | 'tray';

/** The beat the key and the backdrop share: ms from the press to the key's release. */
export const RELEASE = 40;

/** A point on a path: ms since the launch, offset from the start (px), speed (px/s). */
export interface Sample {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Flight {
  key: string;
  dest: FlightDest;
  steer: boolean;
  /**
   * Time zero of the message, on the page's clock: the first frame after the key (under load the
   * key's handler can hold that frame back; starting there means no beat is skipped). Every
   * animation of the message and the worker's drawing are timed from it.
   */
  t0: number;
  started: boolean;
  liquid: Pour | null;
  plan: LiquidPlan;
  /** The words gathering out of their source (gone once gathered). */
  pourEls: HTMLElement[];
  /** The landing layer (the message card, or the queue row's words) and its parts: the window the ink reveals the words through, and the words. */
  el: HTMLDivElement;
  inner: HTMLElement;
  clip: HTMLElement;
  unfold: HTMLElement;
  surface: HTMLElement | null;
  /** Where the layer stands untransformed: the planned landing. */
  box: Box;
  /** The reveal and the surface (made again when the landing moves before the drop leaves). */
  anims: Animation[];
  /** The late correction, played on `inner` (the same curve the worker follows). */
  fixAnim: Animation | null;
  fixEnd: number;
  /** Every animation of the message, for the dev freeze. */
  all: Animation[];
  /** The liquid has run its course: the card is complete (or the row's words are). */
  resting: boolean;
  target: HTMLElement | null;
  row: HTMLElement | null;
  ending: boolean;
  onLand?: () => void;
  done: () => void;
  wait: Animation[];
  line: HTMLElement | null;
  answer: HoldAnswer;
  answeredAt: number;
  timer: number;
  restTimer: number;
  /** Where the words stood in their source (a refused message goes back there). */
  home: { left: number; top: number; s0: number };
  /** The bar the bead forms on, while the bar holds still for it. */
  bar: HTMLElement | null;
  /** The field closing to one line (left to finish whatever happens to the message). */
  barAnim: Animation | null;
}

/** What the composer keeps of a launch: the bridge's answer decides how the wait ends. */
export interface FlightHandle {
  /**
   * The bridge took the message (`true`: its row has a little while left to appear, then the card
   * lets go) or refused it (`false`: the message goes back into the field; resolves once it has,
   * for the words to be put back).
   */
  settle(ok: boolean): Promise<void>;
}

const pending: Flight[] = [];
/**
 * Messages that mounted in the conversation with no message in the air yet (a tray row may still
 * leave): claimed within `UNCLAIMED_MS`, forgotten after (so no old conversation is held).
 */
const unclaimed: { key: string; root: HTMLElement; at: number }[] = [];
const UNCLAIMED_MS = 400;
const pruneUnclaimed = (now: number) => {
  for (let i = unclaimed.length - 1; i >= 0; i--) if (now - unclaimed[i].at >= UNCLAIMED_MS || !unclaimed[i].root.isConnected) unclaimed.splice(i, 1);
};

/** The bars a bead is joined to: each holds still (`data-pouring`) until the last of its messages has left it. */
const holding = new WeakMap<HTMLElement, number>();
function holdBar(bar: HTMLElement, ms: number) {
  holding.set(bar, (holding.get(bar) ?? 0) + 1);
  bar.setAttribute('data-pouring', '');
  window.setTimeout(() => {
    const n = (holding.get(bar) ?? 1) - 1;
    holding.set(bar, n);
    if (n <= 0) bar.removeAttribute('data-pouring');
  }, ms);
}

const norm = (t: string) => t.trim().replace(/\s+/g, ' ').slice(0, 160);
const matches = (flightKey: string, text: string) => {
  const k = norm(text);
  return !!flightKey && (k === flightKey || k.startsWith(flightKey) || flightKey.startsWith(k));
};

/** Words for the tray that nothing has claimed fade after this long; none outlives the last. */
const NO_CLAIM_MS = 1400;
const MAX_LIFE_MS = 6000;
/**
 * A message holds for its row: at most this long while the bridge has not answered (a new session
 * may still be starting on a loaded machine), and this long once it has taken the message (its row
 * is in the store by then; one that does not show is in a view no longer on screen).
 */
export const HOLD_MS = 15000;
export const ACKED_MS = 3000;

/** What the bridge has said about a sent message so far. */
export type HoldAnswer = 'pending' | 'taken' | 'refused';

/**
 * What a message in the air does about its row, decided again whenever something changes. It never
 * fades for being late: it lands once its row is there, goes back into the field when the bridge
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

/** When the waiting state begins, in ms after the key, for a message complete at `pathEnd` ms. */
export const waitStart = (pathEnd: number) => Math.max(WAIT_MIN, pathEnd + WAIT_AFTER);
/** The waiting state starts this long after the message is complete, and never before `WAIT_MIN` after the key. */
const WAIT_AFTER = 120;
const WAIT_MIN = 380;
/** The waiting tone (a queued or steered message's, timeline.css `.user[data-queued] .user-card`). */
const WAIT_TONE = 0.6;
/** The hairline's slow fill: quick at first, then ever slower, never quite to the end on its own. */
const WAIT_FILL = 9000;
const WAIT_REACH = 0.94;

/** The widest a card grows: this share of the reading column. */
const CARD_SHARE = 0.8;
/** The first message's card sits this far under the top of the stage (the conversation's top padding). */
const FIRST_TOP = 56;
/** The narrowest side padding of a conversation row (timeline.css `.tl-content --gutter`). */
const MIN_GUTTER = 24;
/** The bead forms this far in from the bar's right edge (clear of its corner's curve). */
const CORNER = 34;
/** A queue row (composer.css `.cq-list`, `.cq-row`): inset in the tray, its height, its corners, where its words start. */
const ROW = { inset: 6, gap: 6, height: 28, radius: 9, text: 35 };

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

/** The page around the send, read once before anything is written (one layout for all of it). */
interface Geometry {
  z: number;
  column: number;
  stage: DOMRect | null;
  card: DOMRect | null;
  /** The open conversation: its content box, its scroller and where its last row ends. */
  content: DOMRect | null;
  scroller: DOMRect | null;
  lastBottom: number | null;
  contents: number;
}

function readGeometry(cardEl: HTMLElement | null): Geometry {
  const contents = document.querySelectorAll<HTMLElement>('.tl-content');
  const content = contents.length === 1 ? contents[0] : null;
  const last = content ? [...content.children].reverse().find((n) => !n.classList.contains('tail')) : null;
  return {
    z: uiZoom(),
    column: columnToken(),
    stage: document.querySelector('.stage-body')?.getBoundingClientRect() ?? null,
    card: cardEl?.getBoundingClientRect() ?? null,
    content: content?.getBoundingClientRect() ?? null,
    scroller: content?.parentElement?.getBoundingClientRect() ?? null,
    lastBottom: last ? last.getBoundingClientRect().bottom : null,
    contents: contents.length,
  };
}

/**
 * Where the card will sit, guessed before its row exists. In an open conversation: just under the
 * last row, or just above the dock once the view has followed it. The real row corrects it.
 */
function guessLanding(g: Geometry, w: number, h: number, first: boolean): { left: number; top: number } | null {
  const z = g.z;
  if (first) {
    if (!g.stage) return null;
    return firstLanding({ left: g.stage.left / z, top: g.stage.top / z, width: g.stage.width / z }, g.column, { width: w });
  }
  // Two conversations on stage (a session switch is fading one out): the real row decides.
  if (g.contents !== 1 || !g.content) return null;
  const c = g.content;
  const right = columnEdges(c.left / z, c.width / z, g.column).right;
  const after = g.lastBottom != null ? g.lastBottom / z + 26 : c.top / z + FIRST_TOP;
  const y = Math.min(g.card ? g.card.top / z - 64 - h : after, after);
  const sc = g.scroller;
  if (sc && !(y >= sc.top / z && y + h <= (g.card ? g.card.top : sc.bottom) / z + 1)) return null;
  return { left: right - w, top: y };
}

interface Source {
  el: HTMLElement;
  /** The words, as shown in `el` (its text box: padding excluded, scroll applied). */
  text: string;
  oneLine?: boolean;
}

/** Where the words stand in their source, their type, and the part of them that shows. */
function measure(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const z = uiZoom();
  const r = el.getBoundingClientRect();
  if (!r.width) return null;
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  const size = parseFloat(cs.fontSize) || 14;
  const line = parseFloat(cs.lineHeight) || size * 1.5;
  return {
    cs,
    left: r.left / z + padL,
    top: r.top / z + padT - el.scrollTop,
    width: r.width / z - padL - padR,
    size,
    line,
    view: { top: r.top / z + padT, bottom: r.bottom / z - padB },
    box: { left: r.left / z, top: r.top / z, right: r.right / z, bottom: r.bottom / z },
  };
}
type Measured = NonNullable<ReturnType<typeof measure>>;

const fontOf = (cs: CSSStyleDeclaration) => `font-size:${cs.fontSize};line-height:${cs.lineHeight};font-family:${cs.fontFamily};font-weight:${cs.fontWeight};letter-spacing:${cs.letterSpacing};`;

/**
 * An animation timed from the message's start (`t0`, the page's clock), so it agrees with the
 * worker frame for frame. Before the start is known (the launch's first frame) it is left pending;
 * the start sets them all at once.
 */
function fromKey(f: Pick<Flight, 't0' | 'all' | 'started'>, el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): Animation | null {
  const a = play(el, frames, { easing: 'linear', fill: 'both', ...opts });
  if (!a) return null;
  if (f.started) a.startTime = f.t0;
  if (frozenAt != null) {
    a.pause();
    a.currentTime = frozenAt;
  }
  f.all.push(a);
  return a;
}

/**
 * The words gather out of their source into the corner the bead rises from: the visible text as
 * one layer (clipped to the field), scaled uniformly toward that point and faded on the way, so the
 * paragraph closes into it whole. Nothing of it is cut apart or re-wrapped.
 */
function gatherWords(f: Pick<Flight, 't0' | 'all' | 'started'>, src: Source, m: Measured, at: { x: number; y: number }): HTMLElement[] {
  const view = { top: m.view.top, height: Math.max(m.line, m.view.bottom - m.view.top) };
  const layer = document.createElement('div');
  layer.className = 'send-gather';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = `left:${m.left}px;top:${view.top}px;width:${m.width}px;height:${view.height}px;transform-origin:${(at.x - m.left).toFixed(1)}px ${(at.y - view.top).toFixed(1)}px;`;
  const words = document.createElement('div');
  words.style.cssText = `top:${(m.top - view.top).toFixed(2)}px;width:${m.width}px;${fontOf(m.cs)}color:${m.cs.color};`;
  if (src.oneLine) words.setAttribute('data-one-line', '');
  words.textContent = src.text.length > 4000 ? src.text.slice(0, 4000) : src.text;
  layer.appendChild(words);
  document.body.appendChild(layer);
  const frames: Keyframe[] = [];
  const n = 12;
  for (let k = 0; k <= n; k++) {
    const u = k / n;
    const c = collapseAt(u);
    frames.push({ offset: u, transform: `scale(${c.s.toFixed(4)})`, opacity: c.o.toFixed(3) });
  }
  fromKey(f, layer, frames, { duration: COLLAPSE });
  return [layer];
}

/**
 * The card the message becomes: the conversation's own `.user-card`, inside the window the ink
 * reveals it through; its surface a layer of its own beside that window (it forms last, with its
 * shadow, which the window would cut).
 */
function makeCard(text: string, steer: boolean, max: number) {
  const el = document.createElement('div');
  el.className = 'send-bubble';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = `left:0;top:0;width:max-content;max-width:${max}px;`;
  const inner = document.createElement('div');
  inner.className = 'send-in';
  const clip = document.createElement('div');
  clip.className = 'send-clip';
  const unfold = document.createElement('div');
  unfold.className = 'send-unfold';
  const surface = document.createElement('i');
  surface.className = 'send-surface';
  const card = document.createElement('div');
  card.className = 'user-card';
  card.style.maxWidth = 'none';
  // A steer lands not yet taken: at the waiting tone (timeline.css `.user[data-queued] .user-card`).
  if (steer) card.style.opacity = '0.6';
  const words = document.createElement('div');
  words.className = 'user-text';
  // A long message is clipped in the conversation too, at the same line (timeline.css `.user-text[data-clipped]`).
  if (isLongMessage(text)) words.setAttribute('data-clipped', '');
  words.textContent = text;
  card.appendChild(words);
  unfold.appendChild(card);
  clip.appendChild(unfold);
  inner.append(surface, clip);
  el.appendChild(inner);
  return { el, inner, clip, unfold, surface };
}

/** A queue row's words, as the tray will show them. */
function makeRowWords(text: string, cs: CSSStyleDeclaration | null) {
  const el = document.createElement('div');
  el.className = 'send-flight';
  el.setAttribute('aria-hidden', 'true');
  const inner = document.createElement('div');
  inner.className = 'send-in';
  const clip = document.createElement('div');
  clip.className = 'send-clip';
  const unfold = document.createElement('div');
  unfold.className = 'send-unfold';
  const words = document.createElement('div');
  words.className = 'send-row-text';
  if (cs) words.style.cssText = fontOf(cs);
  words.textContent = text.split('\n').find((l) => l.trim())?.trim() ?? text;
  unfold.appendChild(words);
  clip.appendChild(unfold);
  inner.appendChild(clip);
  el.appendChild(inner);
  return { el, inner, clip, unfold, surface: null };
}

/**
 * The words are revealed in place by the spreading ink (revealAt): a window over the card that
 * follows the sheet, its content counter-scaled so the words never move or change size; the card's
 * surface forms as the sheet hands over.
 */
function unfoldAnims(f: Flight) {
  for (const a of f.anims) a.cancel();
  f.anims = [];
  const p = f.plan;
  const win: Keyframe[] = [];
  const words: Keyframe[] = [];
  const span = p.hand - p.land;
  const n = Math.max(8, Math.round(span / 8));
  for (let i = 0; i <= n; i++) {
    const t = p.land + (span * i) / n;
    const r = revealAt(p, t);
    win.push({ offset: i / n, transform: `translate(${r.x.toFixed(2)}px, ${r.y.toFixed(2)}px) scale(${r.sx.toFixed(4)}, ${r.sy.toFixed(4)})` });
    words.push({ offset: i / n, transform: `scale(${(1 / r.sx).toFixed(4)}, ${(1 / r.sy).toFixed(4)}) translate(${(-r.x).toFixed(2)}px, ${(-r.y).toFixed(2)}px)`, opacity: r.o.toFixed(3) });
  }
  win[n] = { offset: 1, transform: 'translate(0px, 0px) scale(1, 1)' };
  words[n] = { offset: 1, transform: 'scale(1, 1) translate(0px, 0px)', opacity: 1 };
  const a = fromKey(f, f.clip, win, { duration: span, delay: p.land });
  const b = fromKey(f, f.unfold, words, { duration: span, delay: p.land });
  for (const x of [a, b]) if (x) f.anims.push(x);
  if (f.surface) {
    const s = fromKey(f, f.surface, [{ opacity: 0 }, { opacity: 1 }], { duration: HAND, delay: p.hand, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' });
    if (s) f.anims.push(s);
  }
}

/** Places the landing layer on its box. */
function place(f: Flight) {
  const b = f.box;
  f.el.style.left = `${b.left.toFixed(2)}px`;
  f.el.style.top = `${b.top.toFixed(2)}px`;
  f.el.style.width = `${b.width.toFixed(2)}px`;
  f.el.style.maxWidth = 'none';
}

/**
 * Lifts `text` out of `source` (the composer's field, or a queue row's text) and keeps it in the
 * air until something with the same text claims it. Call before the field is cleared.
 */
export function launchFlight(source: Source, opts: { dest: FlightDest; steer?: boolean; first?: boolean }): FlightHandle | null {
  if (reducedMotion() || !source.text.trim()) return null;
  const t0 = performance.now();
  const bubble = opts.dest === 'timeline';
  const steer = !!opts.steer;
  // Every read first: one layout for the whole launch.
  const m = measure(source.el);
  if (!m) return null;
  const bar = source.oneLine ? null : source.el.closest<HTMLElement>('.cmp-card');
  const g = readGeometry(bar);
  const z = g.z;
  const rowEl = source.oneLine ? source.el.closest<HTMLElement>('[data-qrow]') : null;
  const rowBox = rowEl?.getBoundingClientRect();
  const cardR = g.card;
  // The field closes to one line with the words. A docked bar grows upward, so its top edge comes
  // down by what the field loses; the home card's copy keeps its top (home/handoff.ts).
  const ta = bar && source.el instanceof HTMLTextAreaElement ? source.el : null;
  const oneLine = m.line + (parseFloat(m.cs.paddingTop) || 0) + (parseFloat(m.cs.paddingBottom) || 0);
  const shrink = ta ? Math.max(0, ta.getBoundingClientRect().height / z - oneLine) : 0;
  const from: LiquidSpec['from'] = cardR
    ? { x: cardR.right / z - CORNER, y: cardR.top / z + (opts.first ? 0 : shrink), edge: true }
    : rowBox
      ? { x: rowBox.right / z - 44, y: (rowBox.top + rowBox.height / 2) / z, edge: false }
      : { x: m.box.right - 30, y: (m.box.top + m.box.bottom) / 2, edge: false };

  const f: Flight = {
    key: norm(source.text),
    dest: opts.dest,
    steer,
    t0,
    started: false,
    liquid: null,
    plan: null as unknown as LiquidPlan,
    pourEls: [],
    el: null as unknown as HTMLDivElement,
    inner: null as unknown as HTMLElement,
    clip: null as unknown as HTMLElement,
    unfold: null as unknown as HTMLElement,
    surface: null,
    box: { left: 0, top: 0, width: 0, height: 0, radii: [18, 18, 6, 18] },
    anims: [],
    fixAnim: null,
    fixEnd: 0,
    all: [],
    resting: false,
    target: null,
    row: null,
    ending: false,
    done: holdSend(),
    wait: [],
    line: null,
    answer: 'pending',
    answeredAt: 0,
    timer: 0,
    restTimer: 0,
    home: { left: 0, top: 0, s0: 1 },
    bar,
    barAnim: null,
  };
  // Where the card stands to show its words exactly on the field's (a refused message goes back there).
  const s0 = Math.min(1, m.size / CARD_FONT);
  f.home = { left: m.left - CARD_PAD_X * s0, top: m.top - CARD_PAD_TOP * s0 + (m.line - CARD_LINE * s0) / 2, s0 };

  // The layer it lands as, measured where nothing shows it yet.
  if (bubble) {
    const max = g.stage ? Math.floor(columnEdges(0, g.stage.width / z, g.column).width * CARD_SHARE) : 600;
    Object.assign(f, makeCard(source.text, steer, max));
  } else Object.assign(f, makeRowWords(source.text, null));
  f.el.style.visibility = 'hidden';
  document.body.appendChild(f.el);
  if (bubble) {
    // Fractional: a width rounded down would wrap the last word.
    const size = f.el.getBoundingClientRect();
    const w = size.width / z;
    const h = size.height / z;
    const guess = guessLanding(g, w, h, !!opts.first);
    // No guess (a view changing under it): just above the bar, on the column's right; the row decides.
    const at = guess ?? { left: (cardR ? cardR.right / z : from.x + CORNER) - w, top: (cardR ? cardR.top / z : from.y) - 64 - h };
    f.box = { left: at.left, top: at.top, width: w, height: h, radii: [18, 18, 6, 18] };
  } else {
    // The tray's newest row: just above the bar, inside the tray that unfolds behind it.
    const c = cardR ?? new DOMRect(from.x - 400, from.y, 434, 60);
    f.box = { left: c.left / z + ROW.inset, top: c.top / z - ROW.gap - ROW.height, width: c.width / z - ROW.inset * 2, height: ROW.height, radii: [ROW.radius, ROW.radius, ROW.radius, ROW.radius] };
    f.el.style.height = `${ROW.height}px`;
  }
  place(f);
  f.el.style.visibility = '';

  const spec: LiquidSpec = { from, to: f.box, kind: bubble ? 'bubble' : 'row' };
  f.liquid = pour(spec);
  f.plan = f.liquid.plan;
  // The words gather into the corner the bead will rise from (or the row's end), and the landing
  // is revealed by the sheet.
  f.pourEls = gatherWords(f, source, m, { x: from.x, y: from.y });
  // A queue row's words are gathering out of it: the row itself shows none (it leaves the tray
  // meanwhile; one that stays gets its words back).
  if (source.oneLine) {
    const el = source.el;
    el.style.opacity = '0';
    window.setTimeout(() => (el.style.opacity = ''), COLLAPSE + 400);
  }
  unfoldAnims(f);
  // The bar holds still while the bead is joined to it, and its field closes with the words on
  // their curve (composer.css `.cmp-card[data-pouring]`; the composer's own measure then sets the
  // same height).
  if (bar) holdBar(bar, f.plan.snap + 80);
  if (ta && shrink > 0.5 && !opts.first) {
    ta.style.overflowY = 'hidden';
    ta.style.height = `${oneLine}px`;
    // Timed from the same frame as the words (a transition would start whenever the busy main
    // thread next gets to it), and above whatever the composer writes meanwhile.
    f.barAnim = fromKey(f, ta, [{ height: `${(oneLine + shrink).toFixed(2)}px` }, { height: `${oneLine}px` }], { duration: COLLAPSE, easing: linearEasing(collapseEase, 20), fill: 'backwards' });
  }
  pending.push(f);
  begin(f);
  // The waiting state is set now, to begin once the card is complete: on the compositor, it shows
  // on time even while the main thread is busy mounting the row it waits for.
  if (bubble) waitFrom(f, waitStart(f.plan.end));
  if (bubble) review(f);
  else f.timer = window.setTimeout(() => !f.target && abort(f), NO_CLAIM_MS);
  // Whatever happens on the way, nothing outlives this: the real message always shows.
  window.setTimeout(() => abort(f), bubble ? HOLD_MS + 2000 : MAX_LIFE_MS);
  // A conversation row that mounted first (the bridge answered before this row left the tray).
  if (bubble) {
    pruneUnclaimed(t0);
    const i = unclaimed.findIndex((u) => matches(f.key, u.key));
    if (i >= 0) {
      const u = unclaimed.splice(i, 1)[0];
      landInTimeline(u.root, u.key, { steer, late: true });
    }
  }
  if (import.meta.env.DEV) devHook();
  return { settle: (ok) => settle(f, ok) };
}

/**
 * Starts the message on the first frame after the launch: the worker and every layer take that
 * frame's time as their zero (a hidden window draws no frame: a timer starts it instead).
 */
function begin(f: Flight) {
  let done = false;
  const go = (at: number) => {
    if (done) return;
    done = true;
    f.t0 = at;
    f.started = true;
    for (const a of f.all) {
      a.startTime = at;
      if (frozenAt != null) {
        a.pause();
        a.currentTime = frozenAt;
      }
    }
    // A message given up before its first frame (its row was no place to land) draws nothing.
    if (!f.ending) f.liquid?.start(at);
    armRest(f);
  };
  requestAnimationFrame((now) => go(now));
  window.setTimeout(() => go(performance.now()), 120);
  armRest(f);
}

/** Rests once the liquid has run its course; the gathering words go once gathered. */
function armRest(f: Flight) {
  window.clearTimeout(f.restTimer);
  const left = f.t0 + f.plan.end - performance.now();
  f.restTimer = window.setTimeout(() => rest(f), Math.max(0, left));
  const poured = f.t0 + COLLAPSE + 40 - performance.now();
  window.setTimeout(() => {
    if (frozen) return;
    for (const p of f.pourEls) p.remove();
    f.pourEls = [];
  }, Math.max(0, poured));
}

/** The waiting state, from `at` ms after the key: the card at the waiting tone, a hairline filling along its lower edge. */
function waitFrom(f: Flight, at: number) {
  const inner = f.inner;
  const line = document.createElement('i');
  line.className = 'send-wait';
  line.setAttribute('aria-hidden', 'true');
  inner.appendChild(line);
  f.line = line;
  const tone = fromKey(f, inner, [{ opacity: 1 }, { opacity: WAIT_TONE }], { duration: 260, delay: at, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'forwards' });
  const fill = fromKey(
    f,
    line,
    [
      { transform: 'scaleX(0)', opacity: 0 },
      { transform: `scaleX(${(WAIT_REACH * 0.03).toFixed(3)})`, opacity: 1, offset: 0.015 },
      { transform: `scaleX(${WAIT_REACH})`, opacity: 1 },
    ],
    { duration: WAIT_FILL, delay: at, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' },
  );
  f.wait = [tone, fill].filter((a): a is Animation => !!a);
}

/** Whether the waiting state has begun (its animations are past their delay). */
const waiting = (f: Flight) => f.wait.length > 0 && f.wait[0].effect?.getComputedTiming().progress != null;

function endWait(f: Flight) {
  for (const a of f.wait) a.cancel();
  f.wait = [];
}

/**
 * The swap after a wait: the row takes the card's tone and steps up to its own, and the hairline
 * runs to the end along the row's edge and fades, so the wait visibly completes as the message lands.
 */
function finishWait(f: Flight, card: HTMLElement) {
  const tone = parseFloat(getComputedStyle(f.inner).opacity) || WAIT_TONE;
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

/** A message's hold, decided now and again when it could next change (see bubbleHold). */
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

/** The springs (stiffness, damping) of a card going back: the axis that leads and the one that follows. */
const LEAD = { k: 520, c: 40 };
const FOLLOW = { k: 460, c: 38 };
/** The throw: each axis leaves at this share of its trip per second, so the first frames cover ground. */
const THROW = 4;
const THROW_FOLLOW = 1.5;
/** How far it sinks while the key gives (px). */
const DIP = 2;

/**
 * A path from `from` to (gx, gy), stepped ahead of time (semi-implicit Euler, 4 ms steps, a sample
 * every 16 ms): a short gather until the release, the throw, then one spring per axis until it
 * rests exactly there. A refused message's card flies back into the field on it. Pure, so it can
 * be tested.
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

/**
 * Refused: before the card is complete, what is in the air fades as the words are put back in the
 * field; a complete card flies back to where its words stood, shrinking to the field's type while
 * its surface dissolves. Resolves when the words can be put back (the caller does that).
 */
function goBack(f: Flight): Promise<void> {
  f.ending = true;
  window.clearTimeout(f.timer);
  window.clearTimeout(f.restTimer);
  drop(f);
  const shown = f.row ?? f.target;
  if (shown) shown.style.opacity = '';
  const tone = parseFloat(getComputedStyle(f.inner).opacity) || 1;
  endWait(f);
  f.line?.remove();
  f.liquid?.cancel();
  for (const p of f.pourEls) p.remove();
  f.pourEls = [];
  const finish = (a: Animation | null) =>
    new Promise<void>((resolve) => {
      const gone = () => {
        f.el.remove();
        f.done();
        resolve();
      };
      if (a) a.finished.then(gone, gone);
      else gone();
    });
  const t = performance.now() - f.t0;
  if (f.dest !== 'timeline' || t < f.plan.hand) {
    for (const a of f.all) if (a !== f.barAnim) a.pause();
    return finish(play(f.el, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'linear', fill: 'forwards' }));
  }
  // From where it is (the correction folded in) back onto the words' place in the field.
  const fix = shiftAt(f.plan, t);
  for (const a of f.all) a.cancel();
  const to = { x: f.home.left - f.box.left, y: f.home.top - f.box.top };
  const path = springPath({ t: 0, x: fix.x, y: fix.y, vx: 0, vy: 0 }, to.x, to.y);
  const end = path[path.length - 1].t || 1;
  const frames: Keyframe[] = path.map((p) => {
    const u = p.t / end;
    return { offset: Math.min(1, u), transform: `translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, 0) scale(${(1 + (f.home.s0 - 1) * Math.min(1, u * 1.4)).toFixed(4)})` };
  });
  frames[frames.length - 1].offset = 1;
  f.el.style.transformOrigin = '0 0';
  const back = play(f.el, frames, { duration: end, easing: 'linear', fill: 'forwards' });
  if (tone < 1) play(f.inner, [{ opacity: tone }, { opacity: 1 }], { duration: 160, easing: EASE_OUT, fill: 'forwards' });
  // The surface goes as the words settle back into the field.
  play(f.surface, [{ opacity: 1 }, { opacity: 0 }], { duration: Math.min(end, 220), delay: Math.max(0, end - 220), easing: 'linear', fill: 'forwards' });
  return finish(back);
}

/** What the landing layer lines up with: the message's card, or the tray row. */
const landingEl = (f: Flight) => (f.dest === 'tray' ? (f.target?.closest<HTMLElement>('[data-qrow]') ?? f.target) : f.target);

/** The target's place at rest (the conversation follows a sent message to its end: the row rests that much higher). */
function targetAt(f: Flight): { left: number; top: number; width: number; height: number } | null {
  const t = landingEl(f);
  if (!t?.isConnected) return null;
  const z = uiZoom();
  const r = t.getBoundingClientRect();
  if (!r.width) return null;
  const sc = f.dest === 'timeline' ? t.closest<HTMLElement>('.tl-content')?.parentElement : null;
  const gap = sc ? Math.max(0, sc.scrollHeight - sc.clientHeight - sc.scrollTop) : 0;
  return { left: r.left / z, top: r.top / z - gap, width: r.width / z, height: r.height / z };
}

/** The liquid has run its course. With a target the real thing takes over; without one the card waits. */
function rest(f: Flight) {
  f.resting = true;
  if (frozen || !f.target || f.ending) return;
  if (performance.now() < f.fixEnd) return;
  if (f.dest === 'tray') still(f);
  else land(f);
}

/**
 * The tray opens under the words (its height animates), so its row may still be moving when they
 * are complete: they hold until it has come to rest, then the two swap. A few frames of polling, once.
 */
function still(f: Flight) {
  let last: { left: number; top: number } | null = null;
  let tries = 0;
  const tick = () => {
    if (f.ending) return;
    const to = targetAt(f);
    if (!to) return abort(f);
    // At rest: the swap moves the row by whatever is left between the words and it.
    if ((last && Math.abs(to.left - last.left) < 0.3 && Math.abs(to.top - last.top) < 0.3) || ++tries > 45) return land(f);
    last = to;
    requestAnimationFrame(tick);
  };
  tick();
}

/**
 * The swap. The copy sits on the real card: one goes, the other shows, in one frame. A row that
 * is not quite there (the view is still catching up, a line arrived above it) takes the remainder
 * itself and settles onto its place.
 */
function land(f: Flight) {
  if (f.ending) return;
  const to = targetAt(f);
  f.ending = true;
  window.clearTimeout(f.timer);
  window.clearTimeout(f.restTimer);
  const shown = f.row ?? f.target;
  if (shown) shown.style.opacity = '';
  if (f.dest === 'timeline' && f.target && waiting(f)) finishWait(f, f.target);
  endWait(f);
  const el = landingEl(f);
  if (to && shown && el) {
    const fix = shiftAt(f.plan, performance.now() - f.t0);
    // Where the copy stands now against where the row is now (not at rest: the row moves the rest itself).
    const r = el.getBoundingClientRect();
    const z = uiZoom();
    const dx = f.box.left + fix.x - r.left / z;
    const dy = f.box.top + fix.y - r.top / z;
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
  for (const p of f.pourEls) p.remove();
  f.pourEls = [];
  drop(f);
  f.done();
}

function abort(f: Flight) {
  if (f.ending) return;
  f.ending = true;
  window.clearTimeout(f.timer);
  window.clearTimeout(f.restTimer);
  const shown = f.row ?? f.target;
  if (shown) shown.style.opacity = '';
  f.liquid?.cancel();
  for (const p of f.pourEls) p.remove();
  f.pourEls = [];
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

/** Whether `target` (a message's card in the conversation) is a place the card may land on. */
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
 * The real landing takes over from the guess. Before the drop has left, the landing simply moves
 * (nothing of it shows yet). After that, everything still to come moves by the difference: the
 * worker shifts the drop and the sheet, the words' layer takes the same shift on the same curve.
 */
function aim(f: Flight) {
  const to = targetAt(f);
  if (!to) return abort(f);
  const t = performance.now() - f.t0;
  const cur = shiftAt(f.plan, Math.max(t, f.fixEnd - f.t0));
  const dx = to.left - (f.box.left + cur.x);
  const dy = to.top - (f.box.top + cur.y);
  const resized = Math.abs(to.width - f.box.width) > 0.5 || Math.abs(to.height - f.box.height) > 0.5;
  if (t < f.plan.snap - 12 && f.liquid) {
    if (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3 && !resized) return;
    const height = f.dest === 'tray' ? f.box.height : to.height;
    f.box = { ...f.box, left: to.left, top: to.top, width: to.width, height };
    place(f);
    f.liquid.retarget(f.box);
    f.plan = f.liquid.plan;
    unfoldAnims(f);
    armRest(f);
    return;
  }
  if (Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6) {
    if (f.resting) rest(f);
    return;
  }
  // Lands where the row is by the time it touches down (or soon after, when it already has).
  const dur = Math.max(160, f.plan.land - t);
  const s = { at: t, dx, dy, dur };
  if (f.liquid) f.liquid.shift(s);
  if (f.liquid?.plan !== f.plan) f.plan.shifts.push(s);
  f.fixEnd = f.t0 + t + dur;
  // The words' layer follows the same sum of shifts, from now to the end of the last one.
  const frames: Keyframe[] = [];
  const n = Math.max(4, Math.round(dur / 16));
  for (let i = 0; i <= n; i++) {
    const at = t + (dur * i) / n;
    const p = shiftAt(f.plan, at);
    frames.push({ offset: i / n, transform: `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px)` });
  }
  const old = f.fixAnim;
  f.fixAnim = fromKey(f, f.inner, frames, { duration: dur, delay: t, fill: 'forwards' });
  old?.cancel();
  window.setTimeout(() => f.resting && rest(f), Math.max(0, f.fixEnd - performance.now()) + 4);
}

/**
 * A message mounted in the conversation (`root` is its `.user` element). When its message is in
 * the air, it lands here: the row skips its own entrance and stays clear until the card sits on
 * it, then the two swap. Returns true when a message in the air took it.
 */
export function landInTimeline(root: HTMLElement, text: string, opts: { steer?: boolean; late?: boolean } = {}): boolean {
  if (reducedMotion()) return false;
  const f = claim('timeline', text);
  if (!f) {
    if (!opts.late) {
      const now = performance.now();
      pruneUnclaimed(now);
      unclaimed.push({ key: text, root, at: now });
      if (unclaimed.length > 4) unclaimed.shift();
      // Forgotten once it can no longer be claimed, so a conversation left behind is not held.
      window.setTimeout(() => pruneUnclaimed(performance.now()), UNCLAIMED_MS + 20);
    }
    return false;
  }
  const card = root.querySelector<HTMLElement>('.user-card');
  if (!card) return false;
  // A row that is not where a message belongs (off the column, out of reach, not laid out): the
  // message fades where it is and the row makes its own entrance.
  if (!certainTarget(card)) {
    abort(f);
    return false;
  }
  root.setAttribute('data-flight', '');
  for (const a of root.getAnimations()) a.cancel();
  // The card becomes this card: the same width and lines, its marks and attachments.
  const width = card.getBoundingClientRect().width / uiZoom();
  const copy = card.cloneNode(true) as HTMLElement;
  copy.style.cssText = `max-width:none;width:${width.toFixed(2)}px;transition:none;opacity:${getComputedStyle(card).opacity};`;
  f.unfold.querySelector('.user-card')?.replaceWith(copy);
  // Past the drop's leaving the landing keeps its place and only shifts: the surface takes the real width now.
  f.el.style.width = `${width.toFixed(2)}px`;
  f.target = card;
  f.row = root;
  root.style.opacity = '0';
  const steer = f.steer || !!opts.steer;
  f.onLand = () => {
    if (!steer) return;
    // The wire of a steer draws itself down into the turn (timeline.css `.user-wire[data-draw]`),
    // and its mark beside the card comes in after the card.
    root.querySelector('.user-wire')?.setAttribute('data-draw', '');
    play(root.querySelector('.user-steer'), [{ opacity: 0, transform: 'translateX(4px)' }], { duration: 220, delay: 40, easing: EASE_OUT, fill: 'backwards' });
  };
  watch(f);
  return true;
}

/**
 * Where a row rests is only known once the conversation has laid out around it (the turn it starts
 * settles in the effects after it mounts): measured on the next frame, and again just before the
 * drop leaves and just before it touches down, so a late change bends its flight instead of
 * showing as a jump at the landing.
 */
function watch(f: Flight) {
  requestAnimationFrame(() => !f.ending && aim(f));
  const at = (ms: number) => {
    const wait = f.t0 + ms - performance.now();
    if (wait > 0) window.setTimeout(() => !f.ending && aim(f), wait);
  };
  at(f.plan.snap - 24);
  at(f.plan.land - 40);
}

/** A queued message's row appeared in the tray: the words land on it. */
export function landInTray(textEl: HTMLElement, text: string): boolean {
  if (reducedMotion()) return false;
  const f = claim('tray', text);
  if (!f) return false;
  // The words take the row's type and stand where its text starts.
  const row = textEl.closest<HTMLElement>('[data-qrow]');
  const words = f.unfold.querySelector<HTMLElement>('.send-row-text');
  if (words && row) {
    const cs = getComputedStyle(textEl);
    const z = uiZoom();
    words.style.cssText = `${fontOf(cs)}padding-left:${((textEl.getBoundingClientRect().left - row.getBoundingClientRect().left) / z).toFixed(2)}px;`;
  }
  f.target = textEl;
  textEl.style.opacity = '0';
  // The tray is still unfolding under it (a transform): the guess is where the row comes to rest,
  // and what is left is settled once it has (`still`).
  return true;
}

/** A queued message left the tray for the conversation: it gathers at the row's end and rises from there. */
export function launchFromTray(textEl: HTMLElement, text: string) {
  if (reducedMotion()) return;
  launchFlight({ el: textEl, text, oneLine: true }, { dest: 'timeline' });
}

/** For tests and the dev console: messages in the air. */
export const flightsInAir = () => pending.length;

// ── dev: frame sheets ──

let frozen = false;
let frozenAt: number | null = null;

/** Dev only: holds every message in the air at `t` ms after its key (null lets them run on). */
function freezeFlights(t: number | null) {
  frozen = t != null;
  frozenAt = t;
  freezeLiquid(t);
  for (const f of pending) {
    for (const a of f.all) {
      if (t == null) {
        a.startTime = f.t0;
      } else {
        a.pause();
        a.currentTime = t;
      }
    }
    if (t == null) {
      armRest(f);
      if (f.resting) rest(f);
    }
  }
}

function devHook() {
  const w = window as unknown as { __sableLiquid?: object };
  if (!w.__sableLiquid)
    w.__sableLiquid = {
      freeze: freezeFlights,
      plan: (spec: LiquidSpec) => planLiquid(spec),
      inAir: () => pending.length,
      easing: linearEasing(shiftEase),
      debug: () =>
        pending.map((f) => ({ dest: f.dest, t: Math.round(performance.now() - f.t0), box: f.box, from: f.plan.spec.from, land: f.plan.land, hand: f.plan.hand, end: f.plan.end, shifts: f.plan.shifts, target: !!f.target, ending: f.ending, resting: f.resting, el: f.el.getBoundingClientRect().toJSON() })),
    };
}

// The worker that draws the liquid is loaded while the page is idle, ahead of the first send.
if (typeof window !== 'undefined') prewarmLiquid();
