import { uiZoom } from '@/lib/motion';

/**
 * Popovers grow out of where they came from and shrink back into it.
 *
 * Every `.pop` opens with the `pop-grow` keyframes and closes with `pop-shrink` (ui.css): a
 * clip from an origin rectangle to the full box, so the content is never scaled. This module
 * supplies that rectangle. When a popover's open or close animation starts, it finds the
 * trigger (Radix links the two with aria attributes), measures both live, and writes the
 * insets as custom properties on the popover. Nothing here knows about a specific menu.
 *
 * - Default: the popover hangs off its trigger. It grows from the stretch of its own edge that
 *   touches the trigger.
 * - `data-origin="select"`: the popover opens over its trigger like a native select. It is
 *   shifted so its `[data-current]` row lies exactly on the trigger (as far as the window
 *   allows), starts as the trigger's rectangle, and that row takes focus.
 */

const PAD = 10;

function triggerOf(pop: HTMLElement): HTMLElement | null {
  const by = pop.getAttribute('aria-labelledby');
  const el = by ? document.getElementById(by) : null;
  if (el) return el;
  return pop.id ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(pop.id)}"]`) : null;
}

/** Insets along one axis: the trigger's own span where the two overlap, else a strip at the near edge. */
function axis(t0: number, t1: number, c0: number, c1: number): [number, number] {
  const a = Math.max(t0, c0);
  const b = Math.min(t1, c1);
  if (b - a >= 6) return [a - c0, c1 - b];
  const size = c1 - c0;
  const strip = Math.min(size, Math.max(10, size * 0.15));
  return (t0 + t1) / 2 <= (c0 + c1) / 2 ? [0, size - strip] : [size - strip, 0];
}

function setOrigin(pop: HTMLElement, opening: boolean) {
  const trig = triggerOf(pop);
  if (!trig || !trig.isConnected) return;
  const z = uiZoom();
  const T = trig.getBoundingClientRect();
  if (!T.width && !T.height) return;
  let C = pop.getBoundingClientRect();
  const select = pop.dataset.origin === 'select';

  if (opening && select) {
    const row = pop.querySelector<HTMLElement>('[data-current]');
    if (row) {
      const R = row.getBoundingClientRect();
      const ra = row.querySelector('[data-origin-anchor]');
      const ta = trig.querySelector('[data-origin-anchor]');
      let dx = ra && ta ? ta.getBoundingClientRect().left - ra.getBoundingClientRect().left : T.left - R.left;
      let dy = T.top + T.height / 2 - (R.top + R.height / 2);
      // Stay inside the window: the row lands on the trigger only where there is room for the rest.
      dx = Math.min(Math.max(dx, PAD - C.left), window.innerWidth - PAD - C.right);
      dy = Math.min(Math.max(dy, PAD - C.top), window.innerHeight - PAD - C.bottom);
      pop.style.setProperty('--o-x', `${dx / z}px`);
      pop.style.setProperty('--o-y', `${dy / z}px`);
      C = new DOMRect(C.left + dx, C.top + dy, C.width, C.height);
      row.focus({ preventScroll: true });
    }
  }

  const [l, r] = axis(T.left, T.right, C.left, C.right);
  const [t, b] = axis(T.top, T.bottom, C.top, C.bottom);
  const s = pop.style;
  s.setProperty('--g-l', `${l / z}px`);
  s.setProperty('--g-r', `${r / z}px`);
  s.setProperty('--g-t', `${t / z}px`);
  s.setProperty('--g-b', `${b / z}px`);
  s.setProperty('--g-rad', select ? `${Math.min(14, T.height / 2 / z)}px` : '10px');
}

const placed = new WeakSet<HTMLElement>();

/** Radix holds a popover still (`animation: none`) until it is positioned; the moment that lifts is the open. */
function whenPositioned(pop: HTMLElement) {
  const ready = () => pop.style.animationName !== 'none' && pop.style.animation !== 'none';
  const go = () => {
    if (placed.has(pop)) return;
    placed.add(pop);
    setOrigin(pop, true);
  };
  if (ready()) {
    go();
    return;
  }
  const mo = new MutationObserver(() => {
    if (!ready()) return;
    mo.disconnect();
    go();
  });
  mo.observe(pop, { attributes: true, attributeFilter: ['style'] });
}

if (typeof document !== 'undefined' && typeof MutationObserver === 'function') {
  // Opening: measured in the same task that positions the popover, so its first painted frame
  // is already the origin rectangle. Floating layers are portalled to the body, so only the
  // body's own child list is watched.
  const watch = () =>
    new MutationObserver((records) => {
      for (const rec of records)
        for (const node of rec.addedNodes) {
          if (!(node instanceof HTMLElement) || !node.hasAttribute('data-radix-popper-content-wrapper')) continue;
          const pop = node.firstElementChild;
          if (pop instanceof HTMLElement && pop.classList.contains('pop')) whenPositioned(pop);
        }
    }).observe(document.body, { childList: true });
  if (document.body) watch();
  else document.addEventListener('DOMContentLoaded', watch, { once: true });

  // Closing: shrink into wherever the trigger is now (its label may have changed size).
  document.addEventListener(
    'animationstart',
    (e) => {
      const pop = e.target;
      if (!(pop instanceof HTMLElement) || !pop.classList.contains('pop')) return;
      if (e.animationName === 'pop-shrink') setOrigin(pop, false);
      else if (e.animationName === 'pop-grow' && !placed.has(pop)) {
        placed.add(pop);
        setOrigin(pop, true);
      }
    },
    true,
  );
}
