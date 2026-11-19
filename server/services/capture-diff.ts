/**
 * Where two pictures of a page differ, as a few rectangles. Works on small RGB thumbnails (one
 * cell per few CSS pixels, so JPEG noise averages out): cells whose colour moved past a threshold
 * are grown a little, joined into connected areas, specks dropped, nearby areas merged, and the
 * result capped at a handful of boxes. Pure: no I/O, tested on synthetic pictures.
 */

/** A thumbnail: `w` x `h` cells, three bytes (r, g, b) per cell, row by row. */
export interface Thumb {
  w: number;
  h: number;
  data: Uint8Array;
}

/** A rectangle in cells (or, after scaling, in CSS pixels). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiffOptions {
  /** A cell changed when one channel moved by more than this (0 to 255). */
  threshold?: number;
  /** Cells joined into one area when they are this close (cells), so a changed line of text is one area. */
  reach?: number;
  /** Areas this close (cells) after grouping become one box. */
  gap?: number;
  /** Areas with fewer changed cells than this are noise. */
  minCells?: number;
  /** At most this many boxes: the closest ones merge until it fits. */
  max?: number;
}

export interface DiffResult {
  /** Largest first. */
  boxes: Box[];
  /** Share of cells that changed, 0 to 1. */
  changed: number;
}

/** The cells whose colour changed past `threshold`. */
export function changedCells(a: Thumb, b: Thumb, threshold: number): Uint8Array {
  const n = a.w * a.h;
  const mask = new Uint8Array(n);
  const da = a.data;
  const db = b.data;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const d = Math.max(Math.abs(da[j] - db[j]), Math.abs(da[j + 1] - db[j + 1]), Math.abs(da[j + 2] - db[j + 2]));
    if (d > threshold) mask[i] = 1;
  }
  return mask;
}

/** Grows every set cell by `r` cells in each direction (a square), in two separable passes. */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const row = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    // Left to right: distance to the last set cell; then right to left.
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) last = x;
      if (x - last <= r) row[y * w + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (mask[y * w + x]) last = x;
      if (last - x <= r) row[y * w + x] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (row[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (row[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

/** Space between two boxes along the axis where they are furthest apart (0 when they touch or overlap). */
export function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.max(dx, dy);
}

export function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

const area = (b: Box) => b.w * b.h;

/** Merges boxes that are within `gap` of each other until none are. */
export function mergeNear(boxes: Box[], gap: number): Box[] {
  const out = boxes.map((b) => ({ ...b }));
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (boxGap(out[i], out[j]) <= gap) {
          out[i] = union(out[i], out[j]);
          out.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return out;
}

/** Merges the pair that costs the least added area until at most `max` boxes are left. */
export function capBoxes(boxes: Box[], max: number): Box[] {
  const out = boxes.map((b) => ({ ...b }));
  while (out.length > Math.max(1, max)) {
    let best = [0, 1];
    let cost = Infinity;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const c = area(union(out[i], out[j])) - area(out[i]) - area(out[j]);
        if (c < cost) {
          cost = c;
          best = [i, j];
        }
      }
    }
    const [i, j] = best;
    out[i] = union(out[i], out[j]);
    out.splice(j, 1);
  }
  return out;
}

/** The changed areas between two thumbnails of the same size (cells). */
export function diffRegions(a: Thumb, b: Thumb, opts: DiffOptions = {}): DiffResult {
  const { threshold = 24, reach = 2, gap = 3, minCells = 3, max = 6 } = opts;
  if (a.w !== b.w || a.h !== b.h || a.data.length !== b.data.length) {
    return { boxes: [{ x: 0, y: 0, w: b.w, h: b.h }], changed: 1 };
  }
  const { w, h } = a;
  const mask = changedCells(a, b, threshold);
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  if (!count) return { boxes: [], changed: 0 };

  // Connected areas of the grown mask; each area's box is the tight box of its own changed cells.
  const grown = dilate(mask, w, h, reach);
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const found: Box[] = [];
  let kept = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!grown[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    let cells = 0;
    while (top) {
      const i = stack[--top];
      const x = i % w;
      const y = (i - x) / w;
      if (mask[i]) {
        cells++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      if (x > 0 && grown[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), (stack[top++] = i - 1);
      if (x < w - 1 && grown[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), (stack[top++] = i + 1);
      if (y > 0 && grown[i - w] && !seen[i - w]) (seen[i - w] = 1), (stack[top++] = i - w);
      if (y < h - 1 && grown[i + w] && !seen[i + w]) (seen[i + w] = 1), (stack[top++] = i + w);
    }
    if (cells < minCells) continue;
    kept += cells;
    found.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  if (!found.length) return { boxes: [], changed: 0 };
  const boxes = capBoxes(mergeNear(found, gap), max).sort((p, q) => area(q) - area(p));
  return { boxes, changed: kept / mask.length };
}

/** Boxes in cells to CSS pixels: `cell` pixels per cell, `pad` around each, clamped to the view. */
export function toPixels(boxes: Box[], cell: number, pad: number, width: number, height: number): Box[] {
  return boxes.map((b) => {
    const x = Math.max(0, b.x * cell - pad);
    const y = Math.max(0, b.y * cell - pad);
    const r = Math.min(width, (b.x + b.w) * cell + pad);
    const bottom = Math.min(height, (b.y + b.h) * cell + pad);
    return { x, y, w: r - x, h: bottom - y };
  });
}
