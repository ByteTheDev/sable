/**
 * The keyboard, as the native side reports it (android/…/ImeLift.java): the page keeps its size,
 * and is told how far its bottom must rise and over how long the keyboard slides. `--kb` (the rise)
 * and `--kb-ms` drive the lift in CSS (`translate`, on the keyboard's curve); `onKeyboard` lets a
 * scroller glide its newest line up with it. In a browser (no native side) the visual viewport
 * stands in.
 */
type Sub = (lift: number, prev: number, ms: number) => void;

declare global {
  interface Window {
    __sableIme?: (lift: number, ms: number, bar: number) => void;
    __sableImeState?: [number, number, number];
  }
}

let lift = 0;
const subs = new Set<Sub>();
const root = document.documentElement;

function apply(raw: number, ms: number, bar: number) {
  // The gesture bar's inset stays what it was while the keyboard is up (the page's bottom moves once).
  root.style.setProperty('--sable-bar', `${bar}px`);
  const next = Math.max(0, Math.round(raw - bar));
  const prev = lift;
  if (next === prev) return;
  lift = next;
  root.style.setProperty('--kb-ms', `${Math.round(ms)}ms`);
  root.style.setProperty('--kb', `${next}px`);
  if (next > 0) root.setAttribute('data-kb', '');
  else root.removeAttribute('data-kb');
  subs.forEach((f) => f(next, prev, ms));
}

window.__sableIme = apply;
if (window.__sableImeState) {
  const [l, , b] = window.__sableImeState;
  apply(l, 0, b);
}

// A browser: the visual viewport shrinks for the keyboard (dev and the web preview only).
if (!('Capacitor' in window && (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()) && window.visualViewport) {
  const vv = window.visualViewport;
  vv.addEventListener('resize', () => {
    const k = Math.max(0, window.innerHeight - vv.height);
    if (k > 120 || lift > 0) apply(k > 120 ? k : 0, 260, 0);
  });
}

export const keyboardLift = () => lift;

export function onKeyboard(f: Sub) {
  subs.add(f);
  return () => void subs.delete(f);
}
