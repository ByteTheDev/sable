/**
 * One highlight per menu that glides between rows.
 *
 * Radix highlights a menu row by focusing it (pointer and keyboard alike). Instead of each row
 * lighting up on its own, every `.pop` gets one `.menu-glide` element under its rows; on each
 * focus it moves to the focused row with a short transform transition (ui.css). Rows keep their
 * own colour change; only the fill travels. Positions are read (two rects, converted to the pop's
 * CSS pixels) before anything is written, inside the menu only:
 * a move restyles one element and repaints nothing outside the menu. Nothing here knows about a
 * specific menu; a popover without menu rows never gets a glide.
 */

const ROW = '.menu-item[role^="menuitem"], .menu-item[role="option"]';

function glideOf(pop: HTMLElement): HTMLElement {
  let g = pop.querySelector<HTMLElement>(':scope > .menu-glide');
  if (!g) {
    g = document.createElement('span');
    g.className = 'menu-glide';
    g.setAttribute('aria-hidden', 'true');
    pop.prepend(g);
    pop.dataset.glide = '';
  }
  return g;
}

/** The row's box in the pop's own coordinates, scroll offsets of anything between taken off. */
function boxIn(row: HTMLElement, pop: HTMLElement) {
  const P = pop.getBoundingClientRect();
  const R = row.getBoundingClientRect();
  // Client pixels to the pop's own CSS pixels (Interface size zooms floating layers).
  const k = P.width ? pop.offsetWidth / P.width : 1;
  return {
    x: Math.round((R.left - P.left) * k - pop.clientLeft),
    y: Math.round((R.top - P.top) * k - pop.clientTop),
    w: Math.round(R.width * k),
    h: Math.round(R.height * k),
  };
}

function place(pop: HTMLElement, row: HTMLElement, animate: boolean) {
  const b = boxIn(row, pop);
  const g = glideOf(pop);
  const shown = g.dataset.on !== undefined;
  // First appearance (or after a fade): jump into place, then fade in. Afterwards: glide.
  if (!animate || !shown) g.dataset.jump = '';
  else delete g.dataset.jump;
  g.style.width = `${b.w}px`;
  g.style.height = `${b.h}px`;
  g.style.transform = `translate(${b.x}px, ${b.y}px)`;
  g.dataset.tone = row.dataset.tone ?? '';
  g.dataset.on = '';
  current.set(pop, row);
}

function hide(pop: HTMLElement) {
  const g = pop.querySelector<HTMLElement>(':scope > .menu-glide');
  if (g) delete g.dataset.on;
  current.delete(pop);
}

const current = new WeakMap<HTMLElement, HTMLElement>();

if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const pop = t.closest<HTMLElement>('.pop');
      if (!pop) return;
      if (t.matches(ROW) && !t.hasAttribute('data-disabled')) place(pop, t, true);
      // Radix moves focus to the menu itself when the pointer leaves the rows.
      else if (t === pop || t.matches('[role="menu"]')) hide(pop);
    },
    true,
  );

  // A row scrolled under a still pointer: follow it without a glide.
  document.addEventListener(
    'scroll',
    (e) => {
      const s = e.target;
      if (!(s instanceof HTMLElement)) return;
      const pop = s.closest<HTMLElement>('.pop');
      const row = pop && current.get(pop);
      if (pop && row?.isConnected) place(pop, row, false);
    },
    { capture: true, passive: true },
  );
}

export {};
