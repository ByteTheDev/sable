import type { PointerEvent as ReactPointerEvent } from 'react';
import { reducedMotion, uiZoom } from '@/lib/motion';

/**
 * Dragging a folder, a project or the chats group in the sidebar to a new place in the manual order,
 * and a folder into or out of a project.
 *
 * Press on a header and move a few pixels: the section lifts (one step lighter, a soft shadow) and
 * follows the pointer on the compositor; the sections it passes slide out of its way (transform
 * only, a short ease) and the list scrolls when the pointer nears an edge. On release the new order
 * goes to the store at once: the list's Flip reads where everything is drawn, the DOM moves, the
 * transforms are dropped in the same frame (`releaseFolderDrag`), and the section settles into its
 * slot from where it was let go. A press that does not move stays a click.
 *
 * Sections move within their own block: the entries beside them in the same list (pinned folders
 * among pinned ones, the others among the others; a project's folders among themselves). A loose
 * folder held over a project's header goes into that project (the header answers with a soft
 * edge); a project's folder taken above or below its project comes out of it, next to it.
 */

export interface FolderDrop {
  /** The block's keys in their new order. */
  reorder: (keys: string[]) => void;
  /** A loose folder let go over a project's header: `key` joins the project `into`. */
  into?: (key: string, into: string) => void;
  /** A project's folder let go outside its project: it stands loose, `side` of the project `from`. */
  out?: (key: string, from: string, side: 'before' | 'after') => void;
}

interface Item {
  el: HTMLElement;
  key: string;
  top: number;
  height: number;
  /** A project: its header's place, to drop a folder into it. */
  head?: { top: number; height: number };
  /** Where it is drawn now, relative to its place. */
  off: number;
}

interface Drag {
  list: HTMLElement;
  el: HTMLElement;
  key: string;
  /** The entries of the block, in their order at the start, with their places then (list coordinates). */
  block: Item[];
  from: number;
  to: number;
  startY: number;
  startScroll: number;
  y: number;
  gap: number;
  raf: number;
  drop: FolderDrop;
  /** A folder that may go into a project: the project under the pointer now. */
  into?: Item;
  /** A project's folder: its project's section, and where it would come out. */
  parent?: { el: HTMLElement; key: string; top: number; height: number };
  out?: 'before' | 'after';
}

const THRESHOLD = 5;
const EDGE = 44;
const SLIDE = '200ms cubic-bezier(0.2, 0.8, 0.2, 1)';

let drag: Drag | null = null;
/** Sections whose transforms the next list update drops (set at the drop). */
let releasing: HTMLElement[] = [];

/**
 * Starts watching a press on a section's header. `drop` gets the block's keys in their new order
 * when the section lands elsewhere, or the folder that went into or out of a project.
 */
export function pressFolder(e: ReactPointerEvent<HTMLElement>, key: string, drop: FolderDrop | ((keys: string[]) => void)) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || drag) return;
  const head = e.currentTarget;
  const el = head.closest<HTMLElement>('section.sgroup');
  const list = head.closest<HTMLElement>('.side-list');
  if (!el || !list) return;
  const handlers: FolderDrop = typeof drop === 'function' ? { reorder: drop } : drop;
  const startX = e.clientX;
  const startY = e.clientY;
  const id = e.pointerId;
  let started = false;

  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    if (!started) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
      started = begin(list, el, key, startY, handlers);
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
      finish(ev.type === 'pointercancel');
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

function begin(list: HTMLElement, el: HTMLElement, key: string, startY: number, drop: FolderDrop): boolean {
  const pinned = el.hasAttribute('data-pinned');
  const container = el.parentElement;
  if (!container) return false;
  const all = [...container.querySelectorAll<HTMLElement>(':scope > section.sgroup[data-folder]')].filter((s) => s.hasAttribute('data-pinned') === pinned);
  const z = uiZoom();
  const lr = list.getBoundingClientRect();
  const at = (r: DOMRect) => (r.top - lr.top) / z + list.scrollTop;
  const isFolder = el.dataset.kind === 'folder';
  const parentEl = el.parentElement?.closest<HTMLElement>('section.sgroup[data-kind="group"]') ?? undefined;
  const block: Item[] = all.map((s) => {
    const r = s.getBoundingClientRect();
    const head = isFolder && !parentEl && s.dataset.kind === 'group' ? s.querySelector<HTMLElement>(':scope > .sgroup-head')?.getBoundingClientRect() : undefined;
    return { el: s, key: s.dataset.folder!, top: at(r), height: r.height / z, head: head ? { top: at(head), height: head.height / z } : undefined, off: 0 };
  });
  const from = block.findIndex((b) => b.el === el);
  if (from < 0) return false;
  const canInto = !!drop.into && block.some((b) => b.head);
  const parent = parentEl && drop.out ? { el: parentEl, key: parentEl.dataset.folder!, top: at(parentEl.getBoundingClientRect()), height: parentEl.getBoundingClientRect().height / z } : undefined;
  if (block.length < 2 && !canInto && !parent) return false;
  // The space between two sections (their margins), so a section that moves keeps it.
  const gap = block.length > 1 ? Math.max(0, block[1].top - (block[0].top + block[0].height)) : 0;
  for (const a of el.getAnimations()) a.cancel();
  drag = { list, el, key, block, from, to: from, startY, startScroll: list.scrollTop, y: startY, gap, raf: 0, drop, parent };
  list.style.setProperty('--shield-h', `${list.clientHeight}px`);
  list.dataset.dragging = '';
  el.dataset.dragging = '';
  const motion = !reducedMotion();
  for (const b of block) if (b.el !== el) b.el.style.transition = motion ? `transform ${SLIDE}` : '';
  tick();
  return true;
}

/** Shifts the others so the dragged section has room at `to` (or puts them all back with `to === from`). */
function shiftTo(d: Drag, to: number) {
  if (to === d.to) return;
  d.to = to;
  const me = d.block[d.from];
  const shift = me.height + d.gap;
  d.block.forEach((b, i) => {
    if (i === d.from) return;
    const off = d.from < to && i > d.from && i <= to ? -shift : d.from > to && i >= to && i < d.from ? shift : 0;
    b.off = off;
    b.el.style.transform = off ? `translate3d(0, ${off}px, 0)` : '';
  });
}

function mark(el: HTMLElement | undefined, attr: string, value?: string) {
  if (!el) return;
  if (value === undefined) el.removeAttribute(attr);
  else el.setAttribute(attr, value);
}

/** Puts the section under the pointer and the others where they make room for it. */
function follow() {
  const d = drag;
  if (!d) return;
  const z = uiZoom();
  const dy = (d.y - d.startY) / z + (d.list.scrollTop - d.startScroll);
  d.el.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0)`;
  const me = d.block[d.from];
  const lr = d.list.getBoundingClientRect();
  const pointer = (d.y - lr.top) / z + d.list.scrollTop;

  // Into a project: the pointer on a project's header (as drawn now).
  const over = d.block.find((b) => b.head && pointer >= b.head.top + b.off && pointer <= b.head.top + b.off + b.head.height);
  if (over !== d.into) {
    mark(d.into?.el, 'data-drop-into');
    d.into = over;
    mark(over?.el, 'data-drop-into', '');
  }
  if (d.into) return;

  // Out of its project: the pointer above the project's header or below its end.
  if (d.parent) {
    const out = pointer < d.parent.top + 6 ? 'before' : pointer > d.parent.top + d.parent.height + 4 ? 'after' : undefined;
    if (out !== d.out) {
      d.out = out;
      mark(d.parent.el, 'data-drop-out', out);
    }
    if (out) return shiftTo(d, d.from);
  }

  const centre = me.top + dy + me.height / 2;
  // The new place: past every section whose middle the dragged section's middle has crossed.
  let to = d.from;
  for (let i = d.from + 1; i < d.block.length; i++) if (centre > d.block[i].top + d.block[i].height / 2) to = i;
  for (let i = d.from - 1; i >= 0; i--) if (centre < d.block[i].top + d.block[i].height / 2) to = i;
  shiftTo(d, to);
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

function finish(cancelled: boolean) {
  const d = drag;
  if (!d) return;
  drag = null;
  cancelAnimationFrame(d.raf);
  delete d.list.dataset.dragging;
  mark(d.into?.el, 'data-drop-into');
  mark(d.parent?.el, 'data-drop-out');
  const keys = d.block.map((b) => b.key);
  const into = !cancelled ? d.into : undefined;
  const out = !cancelled && !into && d.parent ? d.out : undefined;
  const moved = !cancelled && !into && !out && d.to !== d.from;
  if (!moved && !into && !out) {
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
  releasing = d.block.map((b) => b.el);
  d.el.dataset.dropped = '';
  if (into) d.drop.into?.(d.key, into.key);
  else if (out) d.drop.out?.(d.key, d.parent!.key, out);
  else {
    const [k] = keys.splice(d.from, 1);
    keys.splice(d.to, 0, k);
    d.drop.reorder(keys);
  }
  // Should the list not re-render (the order was refused), nothing is left displaced.
  window.setTimeout(() => releaseFolderDrag(), 120);
}

/**
 * Called by the list's Flip right after the DOM took the new order and before it measures: the
 * sections lose the transforms of the drag, so Flip slides them from where they were drawn.
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

/** The keyboard way: Alt+Up / Alt+Down on a header moves it one place in its block. */
export function nudgeFolder(keys: string[], key: string, by: -1 | 1): string[] | null {
  const i = keys.indexOf(key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= keys.length) return null;
  const next = [...keys];
  next.splice(i, 1);
  next.splice(j, 0, key);
  return next;
}
