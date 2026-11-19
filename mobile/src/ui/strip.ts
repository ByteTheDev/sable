import { paletteRgb, type Palette } from './Field';

/**
 * A strip of the dither field, drawn once per palette and kept as an image: the light at the foot
 * of a live card. It tiles sideways (its streaks repeat over its width), so it can drift on the
 * compositor (a transform) without being drawn again.
 */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const cache = new Map<string, string>();

export const STRIP_W = 128;
export const STRIP_H = 10;

export function ditherStrip(p: Palette): string {
  const hit = cache.get(p);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = STRIP_W;
  c.height = STRIP_H;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(STRIP_W, STRIP_H);
  const stops = paletteRgb(p);
  for (let y = 0; y < STRIP_H; y++) {
    const ny = y / (STRIP_H - 1);
    // Strongest at the foot, gone at the top.
    const rise = ny ** 2.2;
    for (let x = 0; x < STRIP_W; x++) {
      const u = (x / STRIP_W) * Math.PI * 2;
      // Periodic over the width (the tile repeats without a seam), uneven like the field's streaks.
      const streak = 0.5 + 0.28 * Math.sin(u * 2 + ny * 1.4) + 0.14 * Math.sin(u * 5 - ny * 2.1 + 1.3) + 0.08 * Math.sin(u * 11 + 0.4);
      const b = rise * streak * 0.62;
      const level = b * 3 + BAYER[(y & 3) * 4 + (x & 3)] - 0.5;
      const k = Math.min(3, Math.floor(level + 0.5));
      const i = (y * STRIP_W + x) * 4;
      if (k <= 0) continue;
      const col = stops[k - 1];
      img.data[i] = col[0];
      img.data[i + 1] = col[1];
      img.data[i + 2] = col[2];
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL('image/png');
  cache.set(p, url);
  return url;
}
