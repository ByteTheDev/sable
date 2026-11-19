import { useEffect, useRef } from 'react';
import type { ProviderId } from '@shared/protocol';

/**
 * The dither field behind home and chats, as on the desktop: light that gathers at the lower edge,
 * soft diagonal streaks, a 4x4 ordered dither in the agent's palette. Battery first: one still
 * frame at rest, a slow drift (8 fps) only while a turn runs on screen, a one-shot wave on send,
 * nothing at all while the app is hidden or under reduced motion.
 */

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export type Palette = 'ember' | 'iris' | 'mint' | 'mono';
const PALETTES: Record<Palette, [RGB, RGB, RGB]> = {
  ember: [hex('#7a2608'), hex('#f2702e'), hex('#ffe2bc')],
  iris: [hex('#262c84'), hex('#6c88ff'), hex('#e2ebff')],
  mint: [hex('#0b6444'), hex('#45dc98'), hex('#e4ffec')],
  mono: [hex('#2c2c30'), hex('#909096'), hex('#f2f2f0')],
};

export const paletteFor = (p: ProviderId | undefined): Palette => (p === 'codex' ? 'iris' : p === 'demo' ? 'mint' : 'ember');

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

type Beat = { at: number; kind: 'send' | 'done' };
const beats = new Set<(b: Beat) => void>();

/** A one-shot wave through every field on screen. */
export function fieldBeat(kind: Beat['kind']) {
  const b = { at: performance.now(), kind };
  for (const f of beats) f(b);
}

export function Field({ palette, amount = 1, focusY = 1.06, spread = 0.62, active = false }: { palette: Palette; amount?: number; focusY?: number; spread?: number; active?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ palette, amount, active, focusY, spread });
  live.current = { palette, amount, active, focusY, spread };
  const api = useRef<{ draw: () => void; kick: () => void } | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const CELL = 3;
    let cols = 0;
    let rows = 0;
    let base = new Float32Array(0);
    let img: ImageData | null = null;
    let beat: Beat | null = null;
    let timer = 0;
    let raf = 0;
    const t0 = performance.now();

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      cols = Math.max(1, Math.ceil(r.width / CELL));
      rows = Math.max(1, Math.ceil(r.height / CELL));
      canvas.width = cols;
      canvas.height = rows;
      img = ctx.createImageData(cols, rows);
      base = new Float32Array(cols * rows);
      const { focusY: fy, spread: sp } = live.current;
      const aspect = r.height / Math.max(1, r.width);
      for (let y = 0; y < rows; y++) {
        const ny = y / rows;
        for (let x = 0; x < cols; x++) {
          const nx = x / cols;
          const dx = (nx - 0.58) * 1.1;
          const dy = (ny - fy) * aspect;
          const d = Math.sqrt(dx * dx + dy * dy) / sp;
          base[y * cols + x] = Math.max(0, 1 - d) ** 1.6;
        }
      }
    };

    const draw = () => {
      if (!img) return;
      const { palette: pal, amount: amt } = live.current;
      const stops = PALETTES[pal];
      const now = performance.now();
      const t = reduced ? 0 : (now - t0) / 1000;
      const data = img.data;
      const ang = 0.61; // ~35°
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      let wave = 0;
      let waveR = 0;
      if (beat) {
        const age = (now - beat.at) / 1000;
        if (age > 1.1) beat = null;
        else {
          waveR = age * 1.35;
          wave = (1 - age / 1.1) * (beat.kind === 'send' ? 0.6 : 0.4);
        }
      }
      for (let y = 0; y < rows; y++) {
        const ny = y / rows;
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          let b = base[i];
          if (b <= 0.002 && !wave) {
            data[i * 4 + 3] = 0;
            continue;
          }
          const nx = x / cols;
          const u = nx * ca + ny * sa;
          const streak = 0.62 + 0.38 * Math.sin(u * 22 + t * 0.35) * Math.sin(u * 7.3 - t * 0.12 + ny * 2.1);
          b *= streak * amt;
          if (wave) {
            const dx = nx - 0.5;
            const dy = (ny - 1) * (rows / cols);
            const d = Math.sqrt(dx * dx + dy * dy);
            const crest = Math.exp(-(((d - waveR) / 0.06) ** 2));
            // The wave stays low on the screen and thins as it rises: never over what you read.
            const low = Math.max(0, (ny - 0.45) / 0.55);
            b += crest * wave * (0.25 + base[i]) * low * low;
          }
          const level = b * 3 + BAYER[(y & 3) * 4 + (x & 3)] - 0.5;
          const k = Math.min(3, Math.floor(level + 0.5));
          if (k <= 0) {
            data[i * 4 + 3] = 0;
            continue;
          }
          const c = stops[k - 1];
          data[i * 4] = c[0];
          data[i * 4 + 1] = c[1];
          data[i * 4 + 2] = c[2];
          data[i * 4 + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    };

    const loop = () => {
      raf = 0;
      if (document.hidden) return;
      draw();
      if (beat) {
        raf = requestAnimationFrame(loop);
        return;
      }
      if (live.current.active && !reduced) timer = window.setTimeout(() => (raf = requestAnimationFrame(loop)), 125);
    };
    const kick = () => {
      clearTimeout(timer);
      if (!raf) raf = requestAnimationFrame(loop);
    };
    api.current = { draw, kick };

    resize();
    draw();
    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(canvas);
    const onBeat = (b: Beat) => {
      if (reduced) return;
      beat = b;
      kick();
    };
    beats.add(onBeat);
    const onVis = () => !document.hidden && kick();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      ro.disconnect();
      beats.delete(onBeat);
      document.removeEventListener('visibilitychange', onVis);
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      api.current = null;
    };
  }, []);

  useEffect(() => {
    api.current?.kick();
  }, [palette, amount, active]);

  return <canvas ref={ref} className="field" aria-hidden />;
}
