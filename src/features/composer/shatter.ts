import { reducedMotion, uiZoom } from '@/lib/motion';

/**
 * The composer's removal effect, a louder cousin of lib/dissolve: the thing's own ink (its text,
 * or an image's light) is re-drawn as 2 px dither cells, a thin scan of light sweeps across it, and
 * the cells it passes tear loose: they are flung up and to the right, tumble under a little
 * gravity, shrink and fade. Its surface breaks into a coarse grain that thins out behind them.
 * About 520 ms on one small canvas over the element's last position, so the element can leave at
 * once and its neighbours close up underneath. Monochrome; nothing under reduced motion.
 */

const CELL = 2;
const SWEEP = 170;
const LIFE = 360;
const MAX = 2400;

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => v / 16);

interface Cell {
  x: number;
  y: number;
  a: number;
  delay: number;
  vx: number;
  vy: number;
  spin: number;
}

/** A tiny deterministic random, so two removals in a row never look alike yet stay stable per cell. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function shatter(el: Element | null | undefined) {
  if (!el || reducedMotion() || typeof document === 'undefined') return;
  const box = el.getBoundingClientRect();
  if (box.width < 4 || box.height < 4 || box.bottom < 0 || box.top > window.innerHeight) return;
  const z = uiZoom();
  const r = { left: box.left / z, top: box.top / z, width: Math.ceil(box.width / z), height: Math.ceil(box.height / z) };

  // ── the element's ink, rasterised at 1 css px per pixel ──
  const off = document.createElement('canvas');
  off.width = r.width;
  off.height = r.height;
  const o = off.getContext('2d', { willReadFrequently: true });
  if (!o) return;
  const cs = getComputedStyle(el);
  const ink = cs.color || 'rgb(242 241 238)';
  const img = el.querySelector('img');
  if (img && img.complete && img.naturalWidth) {
    o.drawImage(img, 0, 0, r.width, r.height);
  } else {
    // Every text run in the element, drawn where it sits, in its own font.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent?.trim();
      const host = n.parentElement;
      if (!t || !host || host.closest('[aria-hidden="true"]:not(.cq-n)')) continue;
      const hs = getComputedStyle(host);
      if (hs.opacity === '0' || hs.visibility === 'hidden') continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const tr = range.getBoundingClientRect();
      if (!tr.width) continue;
      o.font = `${hs.fontWeight} ${hs.fontSize} ${hs.fontFamily}`;
      o.fillStyle = '#fff';
      o.textBaseline = 'middle';
      // Clip to the host's box so ellipsed text breaks up only as far as it was shown.
      const hb = host.getBoundingClientRect();
      o.save();
      o.beginPath();
      o.rect((hb.left - box.left) / z, 0, hb.width / z, r.height);
      o.clip();
      o.fillText(n.textContent ?? '', (tr.left - box.left) / z, (tr.top - box.top + tr.height / 2) / z);
      o.restore();
    }
  }
  const data = o.getImageData(0, 0, r.width, r.height).data;
  const lit = !!img;
  const rand = rng((Date.now() ^ (r.width * 7919)) >>> 0);
  const cells: Cell[] = [];
  const surface: { x: number; y: number; b: number }[] = [];
  const surfaceTone = cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor);
  for (let y = 0; y < r.height; y += CELL) {
    for (let x = 0; x < r.width; x += CELL) {
      const i = ((y + (CELL >> 1)) * r.width + x + (CELL >> 1)) * 4;
      // Ink: alpha for text; for an image, its light (luminance) through an ordered dither.
      const b = BAYER4[((y / CELL) & 3) * 4 + ((x / CELL) & 3)];
      const v = lit ? (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255 : data[i + 3] / 255;
      if (v > (lit ? b : 0.28)) {
        const u = x / r.width;
        cells.push({
          x,
          y,
          a: lit ? 0.5 + v * 0.5 : Math.min(1, v + 0.15),
          delay: u * SWEEP + rand() * 46,
          vx: 30 + rand() * 120 + u * 40,
          vy: -(70 + rand() * 210),
          spin: rand(),
        });
      } else if ((surfaceTone || lit) && b < 0.22) surface.push({ x, y, b });
    }
  }
  if (cells.length > MAX) cells.splice(0, cells.length - MAX);

  // ── the stage: a canvas with room above and to the right for the cells to fly ──
  const padX = 40;
  const padT = 70;
  const padB = 16;
  const w = r.width + padX * 2;
  const h = r.height + padT + padB;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.cssText = `position:fixed;left:${r.left - padX}px;top:${r.top - padT}px;width:${w}px;height:${h}px;pointer-events:none;z-index:80;`;
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  document.body.appendChild(canvas);
  ctx.scale(dpr, dpr);
  const total = SWEEP + 46 + LIFE;
  const start = performance.now();
  const g = 420;

  const frame = (now: number) => {
    const t = now - start;
    if (t >= total || !canvas.isConnected) {
      canvas.remove();
      return;
    }
    ctx.clearRect(0, 0, w, h);
    const sweepX = Math.min(1, t / SWEEP) * r.width;

    // The surface: a coarse grain that thins out as the scan passes.
    ctx.fillStyle = ink;
    for (const s of surface) {
      const left = s.x < sweepX;
      const fade = left ? Math.max(0, 1 - (t - (s.x / r.width) * SWEEP) / 220) : 1;
      if (fade <= 0) continue;
      ctx.globalAlpha = 0.07 * fade * (1 - s.b * 2);
      ctx.fillRect(padX + s.x, padT + s.y, CELL, CELL);
    }

    // The cells: whole until the scan reaches them, then loose.
    for (const c of cells) {
      const k = (t - c.delay) / LIFE;
      if (k <= 0) {
        ctx.globalAlpha = c.a;
        ctx.fillRect(padX + c.x, padT + c.y, CELL, CELL);
        continue;
      }
      if (k >= 1) continue;
      const s = (t - c.delay) / 1000;
      const dx = c.vx * s;
      const dy = c.vy * s + 0.5 * g * s * s;
      const size = CELL * (1 - 0.55 * k) * (c.spin > 0.8 ? 1.5 : 1);
      ctx.globalAlpha = c.a * (1 - k) * (1 - k * 0.4);
      ctx.fillRect(padX + c.x + dx, padT + c.y + dy, size, size);
    }

    // The scan: a thin line of light, brightest mid-sweep.
    if (t < SWEEP + 40) {
      const p = Math.min(1, t / SWEEP);
      ctx.globalAlpha = 0.55 * Math.sin(Math.PI * Math.min(1, t / (SWEEP + 40)));
      ctx.fillRect(padX + p * r.width - 1, padT - 2, 1.5, r.height + 4);
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
