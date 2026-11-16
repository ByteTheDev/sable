/**
 * The dither dissolve: a surface covers and uncovers itself through the app's ordered dither,
 * the way the mark builds in the launch intro (sparse, then a checker, then solid).
 *
 * Four layers in the surface colour sit over the content, each holding one quarter of a 4x4 Bayer
 * tile (the same order as MARK_CELLS), so together they step from a sparse scatter to solid. Each
 * layer is painted once when it is created; after that only its opacity changes, so the whole
 * dissolve runs on the compositor and nothing under it is laid out or repainted, however busy the
 * main thread is (a view mounting underneath, for one). No masks, no filters.
 *
 * - `swap`: covers what is there, holds solid for a frame while the caller swaps the content, and
 *   uncovers the new content (`VEIL_SWAP` ms, the content swap at `VEIL_SWAP_AT` of it).
 * - `reveal`: starts solid and uncovers (new content resolving out of the ground).
 * - `cover`: covers (content dissolving into the ground before it goes).
 *
 * Reduced motion: nothing is drawn (callers fade instead).
 */

export type VeilMode = 'swap' | 'reveal' | 'cover';

/** The whole swap, and the point in it (0..1) where the cover is solid and the content changes. */
export const VEIL_SWAP = 260;
export const VEIL_SWAP_AT = 0.4;

/** 4x4 ordered dither: the rank of each cell (row-major). */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const tiles = new Map<string, string[]>();

/** The four quarter tiles (ranks 0-3, 4-7, 8-11, 12-15) as SVG data URLs, for one colour and cell size. */
function quarterTiles(color: string, cell: number): string[] {
  const key = `${color}/${cell}`;
  let t = tiles.get(key);
  if (t) return t;
  const size = cell * 4;
  t = [0, 1, 2, 3].map((q) => {
    let d = '';
    for (let i = 0; i < 16; i++) {
      if (BAYER4[i] >> 2 !== q) continue;
      const x = (i & 3) * cell;
      const y = (i >> 2) * cell;
      d += `M${x} ${y}h${cell}v${cell}h-${cell}z`;
    }
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' shape-rendering='crispEdges'><path fill='${color}' d='${d}'/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  });
  tiles.set(key, t);
  return t;
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The surface colour, resolved once per token (the veil must match what is under the content). */
const colours = new Map<string, string>();
function resolve(token: string): string {
  let c = colours.get(token);
  if (c) return c;
  if (!token.startsWith('--')) return token;
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  // An SVG fill takes any CSS colour; fall back to the stage colour if the token is missing.
  c = v || '#0c0c0e';
  colours.set(token, c);
  return c;
}

/** The running veil per host: a new one replaces it (a quick second navigation restarts cleanly). */
const live = new WeakMap<HTMLElement, { el: HTMLElement; anims: Animation[] }>();

/** Each quarter's window, as offsets into the run: when it turns on and when it turns off. */
function windows(mode: VeilMode): [number, number][] {
  if (mode === 'cover') return [0, 1, 2, 3].map((q) => [q * 0.24, 2]);
  if (mode === 'reveal') return [0, 1, 2, 3].map((q) => [-1, 1 - (q + 1) * 0.24]);
  // swap: on in Bayer order up to the hold, off in reverse after it, so the new content resolves sparse first.
  const a = VEIL_SWAP_AT;
  return [0, 1, 2, 3].map((q) => [q * (a / 4) - 0.02, a + 0.04 + (3 - q) * ((1 - a - 0.06) / 4)]);
}

/**
 * Plays a dither dissolve over `host` (positioned; the veil fills it). Returns a promise that
 * settles when it is gone. `color` is the surface colour under the content (a token or a colour).
 */
export function veil(host: HTMLElement | null, mode: VeilMode, opts: { duration?: number; color?: string; cell?: number } = {}): Promise<void> {
  if (!host || reduced() || typeof host.animate !== 'function') return Promise.resolve();
  const duration = opts.duration ?? (mode === 'swap' ? VEIL_SWAP : 200);
  const layers = quarterTiles(resolve(opts.color ?? '--sheet'), opts.cell ?? 4);
  live.get(host)?.el.remove();
  // The veil fills its host: a static host would let it spread over whatever ancestor is positioned.
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const el = document.createElement('div');
  el.className = 'veil';
  el.setAttribute('aria-hidden', 'true');
  const step = 16 / duration;
  const anims: Animation[] = [];
  windows(mode).forEach(([on, off], q) => {
    const layer = document.createElement('i');
    layer.style.backgroundImage = layers[q];
    layer.style.backgroundSize = `${(opts.cell ?? 4) * 4}px`;
    el.appendChild(layer);
    // A quarter switches over about one frame, so each step reads as a step of the dither, not a fade.
    const frames: Keyframe[] = [];
    const push = (offset: number, opacity: number) => {
      const o = Math.min(1, Math.max(0, offset));
      if (frames.length && o <= (frames[frames.length - 1].offset as number)) frames[frames.length - 1].opacity = opacity;
      else frames.push({ offset: o, opacity });
    };
    push(0, on <= 0 ? 1 : 0);
    if (on > 0 && on < 1) {
      push(on, 0);
      push(on + step, 1);
    }
    if (off > 0 && off < 1) {
      push(off, 1);
      push(off + step, 0);
    }
    push(1, off >= 1 ? 1 : 0);
    if (frames.length === 1) frames.push({ offset: 1, opacity: frames[0].opacity });
    anims.push(layer.animate(frames, { duration, easing: 'linear', fill: 'both' }));
  });
  host.appendChild(el);
  const entry = { el, anims };
  live.set(host, entry);
  return Promise.all(anims.map((a) => a.finished)).then(
    () => {
      if (live.get(host) === entry) live.delete(host);
      // A cover stays until its host goes (the caller removes the content under it).
      if (mode !== 'cover') el.remove();
    },
    () => {
      if (live.get(host) === entry) live.delete(host);
      el.remove();
    },
  );
}
