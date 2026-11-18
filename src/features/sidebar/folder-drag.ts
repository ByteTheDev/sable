import type { PointerEvent as ReactPointerEvent } from 'react';
import { reducedMotion, uiZoom } from '@/lib/motion';

/**
 * Dragging a folder in the sidebar to a new place in the manual order.
 *
 * Press on a folder's header and move a few pixels: the folder lifts (one step lighter, a soft
 * shadow) and follows the pointer on the compositor; the folders it passes slide out of its way
 * (transform only, a short ease) and the list scrolls when the pointer nears an edge. On release
 * the new order goes to the store at once: the list's Flip reads where everything is drawn, the
 * DOM moves, the transforms are dropped in the same frame (`releaseFolderDrag`), and the folder
 * settles into its slot from where it was let go. A press that does not move stays a click.
 *
 * Folders move within their own block: pinned folders among pinned ones, the others among the others.
 */

interface Drag {
  list: HTMLElement;
  el: HTMLElement;
  key: string;
  /** The folders of the block, in their order at the start, with their places then (list coordinates). */
  block: { el: HTMLElement; key: string; top: number; height: number }[];
  from: number;
  to: number;
  startY: number;
  startScroll: number;
  y: number;
  gap: number;
  raf: number;
  onDrop: (keys: string[]) => void;
}

const THRESHOLD = 5;
const EDGE = 44;
const SLIDE = '200ms cubic-bezier(0.2, 0.8, 0.2, 1)';

let drag: Drag | null = null;
/** Folders whose transforms the next list update drops (set at the drop). */
let releasing: HTMLElement[] = [];

/**
 * Starts watching a press on a folder header. `keys` gives the folder keys of the press's block in
 * order; `onDrop` gets them in the new order when the folder lands elsewhere.
 */
export function pressFolder(e: ReactPointerEvent<HTMLElement>, key: string, onDrop: (keys: string[]) => void) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || drag) return;
  const head = e.currentTarget;
  const el = head.closest<HTMLElement>('section.sgroup');
  const list = head.closest<HTMLElement>('.side-list');
  if (!el || !list) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const id = e.pointerId;
  let started = false;

  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    if (!started) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
      started = begin(list, el, key, startY, onDrop);
      if (!started) return end();
      try {
        head.setPointerCapture(id);
      } catch {
        /* the pointer is gone */
      }
    }
    if (drag) {
      drag.y = ev.clientY;
      follow();
    }
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    end();
    if (started) {
      // The release ends a drag, not a click on the header.
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      drop(ev.type === 'pointercancel');
    }
  };
  const end = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
}

const swallow = (e: Event) => {
  e.stopPropagation();
  e.preventDefault();
};

function begin(list: HTMLElement, el: HTMLElement, key: string, startY: number, onDrop: (keys: string[]) => void): boolean {
  const pinned = el.hasAttribute('data-pinned');
  const all = [...list.querySelectorAll<HTMLElement>(':scope .side-rows > section.sgroup[data-folder]')].filter((s) => s.hasAttribute('data-pinned') === pinned);
  if (all.length < 2) return false;
  const z = uiZoom();
  const lr = list.getBoundingClientRect();
  const block = all.map((s) => {
    const r = s.getBoundingClientRect();
    return { el: s, key: s.dataset.folder!, top: (r.top - lr.top) / z + list.scrollTop, height: r.height / z };
  });
  const from = block.findIndex((b) => b.el === el);
  if (from < 0) return false;
  // The space between two folders (their margins), so a folder that moves keeps it.
  const gap = block.length > 1 ? Math.max(0, block[1].top - (block[0].top + block[0].height)) : 0;
  for (const a of el.getAnimations()) a.cancel();
  drag = { list, el, key, block, from, to: from, startY, startScroll: list.scrollTop, y: startY, gap, raf: 0, onDrop };
  list.style.setProperty('--shield-h', `${list.clientHeight}px`);
  list.dataset.dragging = '';
  el.dataset.dragging = '';
  const motion = !reducedMotion();
  for (const b of block) if (b.el !== el) b.el.style.transition = motion ? `transform ${SLIDE}` : '';
  tick();
  return true;
}

/** Puts the folder under the pointer and the others where they make room for it. */
function follow() {
  const d = drag;
  if (!d) return;
  const z = uiZoom();
  const dy = (d.y - d.startY) / z + (d.list.scrollTop - d.startScroll);
  d.el.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0)`;
  const me = d.block[d.from];
  const centre = me.top + dy + me.height / 2;
  // The new place: past every folder whose middle the dragged folder's middle has crossed.
  let to = d.from;
  for (let i = d.from + 1; i < d.block.length; i++) if (centre > d.block[i].top + d.block[i].height / 2) to = i;
  for (let i = d.from - 1; i >= 0; i--) if (centre < d.block[i].top + d.block[i].height / 2) to = i;
  if (to === d.to) return;
  d.to = to;
  const shift = me.height + d.gap;
  d.block.forEach((b, i) => {
    if (i === d.from) return;
    const off = d.from < to && i > d.from && i <= to ? -shift : d.from > to && i >= to && i < d.from ? shift : 0;
    b.el.style.transform = off ? `translate3d(0, ${off}px, 0)` : '';
  });
}

/** Scrolls the list while the pointer is near its top or bottom edge. */
function tick() {
  const d = drag;
  if (!d) return;
  const r = d.list.getBoundingClientRect();
  const near = d.y < r.top + EDGE ? d.y - (r.top + EDGE) : d.y > r.bottom - EDGE ? d.y - (r.bottom - EDGE) : 0;
  if (near) {
    const before = d.list.scrollTop;
    d.list.scrollTop += Math.max(-18, Math.min(18, near * 0.35));
    if (d.list.scrollTop !== before) follow();
  }
  d.raf = requestAnimationFrame(tick);
}

function drop(cancelled: boolean) {
  const d = drag;
  if (!d) return;
  drag = null;
  cancelAnimationFrame(d.raf);
  delete d.list.dataset.dragging;
  const keys = d.block.map((b) => b.key);
  const moved = !cancelled && d.to !== d.from;
  if (!moved) {
    // Back to its place, and the others back to theirs.
    const motion = !reducedMotion();
    d.el.style.transition = motion ? `transform ${SLIDE}` : '';
    d.el.style.transform = '';
    for (const b of d.block) b.el.style.transform = '';
    window.setTimeout(() => {
      delete d.el.dataset.dragging;
      for (const b of d.block) b.el.style.transition = '';
    }, motion ? 220 : 0);
    return;
  }
  const [k] = keys.splice(d.from, 1);
  keys.splice(d.to, 0, k);
  releasing = d.block.map((b) => b.el);
  d.el.dataset.dropped = '';
  d.onDrop(keys);
  // Should the list not re-render (the order was refused), nothing is left displaced.
  window.setTimeout(() => releaseFolderDrag(), 120);
}

/**
 * Called by the list's Flip right after the DOM took the new order and before it measures: the
 * folders lose the transforms of the drag, so Flip slides them from where they were drawn.
 */
export function releaseFolderDrag() {
  if (!releasing.length) return;
  for (const el of releasing) {
    el.style.transition = '';
    el.style.transform = '';
    if (el.hasAttribute('data-dropped')) {
      delete el.dataset.dragging;
      window.setTimeout(() => delete el.dataset.dropped, 400);
    }
  }
  releasing = [];
}

/** The keyboard way: Alt+Up / Alt+Down on a folder header moves it one place in its block. */
export function nudgeFolder(keys: string[], key: string, by: -1 | 1): string[] | null {
  const i = keys.indexOf(key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= keys.length) return null;
  const next = [...keys];
  next.splice(i, 1);
  next.splice(j, 0, key);
  return next;
}
