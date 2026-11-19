/**
 * Where a chat opened from (a row, a live card, the new-chat field): the chat grows out of that
 * rectangle and, going back, folds into wherever its row is now (or slides away when it is not on
 * screen). Plain module state: the tap records, the chat's layer takes it once.
 */
export interface Origin {
  rect: { top: number; left: number; width: number; height: number };
  radius: number;
  at: number;
  /** What was tapped: drawn into the opening window for its first moment (a copy). */
  el?: Element;
}

const pending = new Map<string, Origin>();

export function openFrom(id: string, el: Element | null, radius = 18) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  pending.set(id, { rect: { top: r.top, left: r.left, width: r.width, height: r.height }, radius, at: performance.now(), el });
}

export function takeOrigin(id: string): Origin | null {
  const o = pending.get(id);
  pending.delete(id);
  if (!o || performance.now() - o.at > 1500) return null;
  return o;
}

/**
 * The chat's row on home, where it will be once home has come forward again (home is stepped back,
 * smaller, while a chat covers it), when that is on screen: to fold back into.
 */
export function rowOf(id: string): Origin | null {
  const home = document.querySelector<HTMLElement>('.home');
  const el = home?.querySelector<HTMLElement>(`[data-chat="${CSS.escape(id)}"]`);
  if (!home || !el) return null;
  const r = el.getBoundingClientRect();
  const m = /matrix\(([^,]+)/.exec(getComputedStyle(home).transform);
  const k = m ? parseFloat(m[1]) || 1 : 1;
  // Home scales about 50% 36% of the screen.
  const ox = window.innerWidth * 0.5;
  const oy = window.innerHeight * 0.36;
  const rect = { top: oy + (r.top - oy) / k, left: ox + (r.left - ox) / k, width: r.width / k, height: r.height / k };
  const h = window.innerHeight;
  if (rect.height < 8 || rect.top + rect.height < 60 || rect.top > h - 60) return null;
  return { rect, radius: Number(el.dataset.radius ?? 18), at: performance.now(), el };
}
