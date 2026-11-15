import { reducedMotion, uiZoom } from './motion';

/** Ordered-dither thresholds (8x8), the same grain the backdrop is drawn with. */
const BAYER = (() => {
  const m = new Float32Array(64);
  const b2 = [0, 2, 3, 1];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      let v = 0;
      for (let bit = 0; bit < 3; bit++) v += b2[((y >> bit) & 1) * 2 + ((x >> bit) & 1)] / 4 ** (bit + 1);
      m[y * 8 + x] = v;
    }
  return m;
})();

const DURATION = 300;
const MAX_CELLS = 2600;

/**
 * The removal effect: the thing breaks into the backdrop's dither cells, which drift up and
 * away and fade (about 300 ms). Call it with the element right before it is removed; it draws
 * on its own small canvas over the element's last position, so the element can leave at once
 * and its neighbours can close the gap. Any number can run together; under reduced motion it
 * does nothing (the element's own fade is the whole effect).
 */
export function dissolve(el: Element | null | undefined) {
  if (!el || reducedMotion() || typeof document === 'undefined') return;
  const box = el.getBoundingClientRect();
  if (box.width < 4 || box.height < 4 || box.bottom < 0 || box.top > window.innerHeight) return;
  // The canvas lives on the body, under the zoomed root: screen pixels become zoomed ones.
  const z = uiZoom();
  const r = { left: box.left / z, top: box.top / z, width: box.width / z, height: box.height / z };
  const padX = 26;
  const padY = 22;
  let cell = 5;
  while ((r.width / cell) * (r.height / cell) > MAX_CELLS) cell++;
  const cols = Math.ceil(r.width / cell);
  const rows = Math.ceil(r.height / cell);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  const w = r.width + padX * 2;
  const h = r.height + padY * 2;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.cssText = `position:fixed;left:${r.left - padX}px;top:${r.top - padY}px;width:${w}px;height:${h}px;pointer-events:none;z-index:80;`;
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  document.body.appendChild(canvas);
  ctx.scale(dpr, dpr);
  const ink = getComputedStyle(el).color || 'rgb(244 243 240)';
  const start = performance.now();
  const frame = (now: number) => {
    const t = (now - start) / DURATION;
    if (t >= 1 || !canvas.isConnected) {
      canvas.remove();
      return;
    }
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = ink;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const b = BAYER[(y & 7) * 8 + (x & 7)];
        // The break-up sweeps across the item; each cell leaves at its own threshold.
        const born = (x / cols) * 0.34 + b * 0.22;
        const u = (t - born) / (1 - born);
        if (u <= 0) {
          // Not yet loose: a fine grain where the item was, thinning as the sweep nears.
          if (b < 0.42 - t * 0.5) {
            ctx.globalAlpha = 0.16;
            ctx.fillRect(padX + x * cell, padY + y * cell, cell - 1, cell - 1);
          }
          continue;
        }
        if (u >= 1 || b > 0.72) continue;
        const e = 1 - (1 - u) * (1 - u);
        const dx = e * (8 + b * 16);
        const dy = -e * (6 + ((x * 7 + y * 13) % 9) * 1.6);
        ctx.globalAlpha = (1 - u) * (0.2 + 0.5 * (1 - b));
        const s = (cell - 1) * (1 - 0.45 * u);
        ctx.fillRect(padX + x * cell + dx, padY + y * cell + dy, s, s);
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
