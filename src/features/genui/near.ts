import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Whether an element is near the viewport, both ways: frames mount when they come within reach and
 * unmount a little after they leave it, so a long conversation full of widgets keeps only the ones
 * around the reader alive. One observer per scroll container.
 */

const MARGIN = 900;
/** A frame that left the viewport stays a little longer, so scrolling back and forth does not rebuild it. */
const LINGER_MS = 5000;

const handlers = new WeakMap<Element, (near: boolean) => void>();
const byRoot = new Map<Element | null, IntersectionObserver>();

function observer(el: Element): IntersectionObserver {
  const root = el.parentElement?.closest('.scroll') ?? null;
  let io = byRoot.get(root);
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) handlers.get(e.target)?.(e.isIntersecting);
      },
      { root, rootMargin: `${MARGIN}px 0px` },
    );
    byRoot.set(root, io);
  }
  return io;
}

export function useNear(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);

  // Decide before the first paint when it is already on screen (a widget arriving at the end).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.bottom > -MARGIN && r.top < window.innerHeight + MARGIN) setNear(true);
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') {
      setNear(true);
      return;
    }
    let timer = 0;
    handlers.set(el, (inside) => {
      window.clearTimeout(timer);
      if (inside) setNear(true);
      else timer = window.setTimeout(() => setNear(false), LINGER_MS);
    });
    const io = observer(el);
    io.observe(el);
    return () => {
      window.clearTimeout(timer);
      handlers.delete(el);
      io.unobserve(el);
    };
  }, [ref]);

  return near;
}

// ── heights, kept across unmounts and reloads ──

const KEY = 'sable.widget-heights';
const MAX_ENTRIES = 400;
let heights: Map<string, number> | undefined;
let saveTimer = 0;

function load(): Map<string, number> {
  if (heights) return heights;
  heights = new Map();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) for (const [k, v] of JSON.parse(raw) as [string, number][]) if (typeof v === 'number') heights.set(k, v);
  } catch {
    /* storage unavailable: memory only */
  }
  return heights;
}

export function cachedHeight(key: string): number | undefined {
  return load().get(key);
}

export function rememberHeight(key: string, h: number) {
  const m = load();
  if (m.get(key) === h) return;
  m.delete(key);
  m.set(key, h);
  while (m.size > MAX_ENTRIES) m.delete(m.keys().next().value as string);
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify([...m]));
    } catch {
      /* full or unavailable */
    }
  }, 800);
}
