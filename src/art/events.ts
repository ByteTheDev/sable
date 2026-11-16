import type { FieldBeat } from './field';

/**
 * The backdrop's beats: moments in the app the light answers (see `FieldBeat` in field.ts for
 * their shapes). Anyone may send one; every animated field that reacts plays it from the given
 * point (viewport coordinates). Still fields, reduced motion and a field at its lowest quality
 * ignore them. `strength` is 0..1.
 *
 * - `send`: a message left the composer (from the send key).
 * - `done` / `fail`: the turn ended, from the composer the reply came back to.
 * - `pulse` (also `sable:pulse`, kept for older senders): a quieter beat for smaller moments.
 */
export const FIELD_EVENT = 'sable:field';

export interface FieldEventDetail {
  kind: FieldBeat;
  x: number;
  y: number;
  strength: number;
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Sends a beat from the centre of `el` (nothing when it is not laid out, or under reduced motion). */
export function fieldBeat(kind: FieldBeat, el: Element | null | undefined, strength = 1) {
  if (!el || reduced()) return;
  const r = el.getBoundingClientRect();
  if (!r.width) return;
  window.dispatchEvent(new CustomEvent<FieldEventDetail>(FIELD_EVENT, { detail: { kind, x: r.left + r.width / 2, y: r.top + r.height / 2, strength } }));
}
