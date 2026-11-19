/**
 * Motion for the phone, one vocabulary: springs for anything that moves (they carry the finger's
 * speed), short eases for what only fades. Transform and opacity only; WAAPI where motion can hand
 * the spring to the compositor.
 */

/** Screens and sheets: quick, no overshoot you would see. */
export const SPRING = { type: 'spring', stiffness: 430, damping: 42, mass: 0.9 } as const;
/** Things the finger let go of: a touch softer, keeps its momentum. */
export const FLING = { type: 'spring', stiffness: 360, damping: 36, mass: 0.9 } as const;
/** Small pieces (chips, keys, rows): fast and settled. */
export const SNAP = { type: 'spring', stiffness: 560, damping: 40 } as const;
/** Height reveals. */
export const REVEAL = { type: 'spring', stiffness: 420, damping: 40 } as const;

export const EASE_OUT = [0.2, 0.8, 0.2, 1] as const;
/** Android's keyboard curve (the IME slides on it for about 280 ms). */
export const IME_EASE = [0.2, 0, 0, 1] as const;

export const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A rubber band: follows the finger, stiffer the further it goes (`max` is where it gives no more). */
export const rubber = (d: number, max = 120) => {
  const s = Math.sign(d);
  const a = Math.abs(d);
  return s * max * (1 - Math.exp(-a / (max * 1.6)));
};

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The scale and opacity an element shows now (mid-animation too): explicit starting keyframes for the next one. */
export function nowOf(el: Element) {
  const c = getComputedStyle(el);
  const m = /matrix\(([^,]+)/.exec(c.transform);
  return { scale: m ? parseFloat(m[1]) : 1, opacity: parseFloat(c.opacity) };
}
