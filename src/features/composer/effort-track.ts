/**
 * The effort track's state, kept apart from the view so it can be tested: which stop the pointer
 * stands on, the drag, and what is committed. Clicking a stop, dragging and the keys all go through
 * `step()`; the view only renders the state and sends `commit` when one comes out.
 */

/** The stop under a pointer at `x` on a row of `n` equal cells that starts at `left` and is `width` wide. */
export function stopAt(x: number, left: number, width: number, n: number): number {
  if (n < 2 || width <= 0) return 0;
  const i = Math.floor(((x - left) / width) * n);
  return Math.max(0, Math.min(n - 1, i));
}

export interface TrackState {
  /** The stop the track stands for (what the header and the chip name). */
  level: number;
  /** A stop the pointer rests on without a press, for a preview of its name; null otherwise. */
  hover: number | null;
  dragging: boolean;
}

export type TrackEvent =
  | { type: 'hover'; at: number }
  | { type: 'leave' }
  | { type: 'down'; at: number }
  | { type: 'move'; at: number }
  | { type: 'up' }
  | { type: 'cancel'; to: number }
  | { type: 'key'; key: string }
  /** The confirmed value changed from outside (another window, the agent). */
  | { type: 'sync'; level: number };

export interface TrackStep {
  state: TrackState;
  /** The stop to save and send, when this event settles on one. */
  commit?: number;
  /** Enter: close the popover. */
  done?: boolean;
}

const clamp = (i: number, n: number) => Math.max(0, Math.min(n - 1, i));

export function step(s: TrackState, e: TrackEvent, n: number): TrackStep {
  if (n < 1) return { state: s };
  switch (e.type) {
    case 'hover':
      return { state: s.dragging ? s : { ...s, hover: clamp(e.at, n) } };
    case 'leave':
      return { state: { ...s, hover: null } };
    case 'down':
      // A press starts a drag on the stop under it; the preview clears so the header names the level.
      return { state: { level: clamp(e.at, n), hover: null, dragging: true } };
    case 'move':
      if (!s.dragging) return step(s, { type: 'hover', at: e.at }, n);
      return { state: { ...s, level: clamp(e.at, n) } };
    case 'up':
      if (!s.dragging) return { state: s };
      // The release lands on the nearest stop, which is the one saved and sent.
      return { state: { ...s, dragging: false }, commit: s.level };
    case 'cancel':
      return { state: { level: clamp(e.to, n), hover: null, dragging: false } };
    case 'sync':
      return { state: s.dragging ? s : { ...s, level: e.level } };
    case 'key': {
      const k = e.key;
      if (k === 'Enter') return { state: s, done: true };
      let next: number | null = null;
      if (k === 'ArrowRight' || k === 'ArrowUp') next = s.level + 1;
      else if (k === 'ArrowLeft' || k === 'ArrowDown') next = s.level - 1;
      else if (k === 'Home') next = 0;
      else if (k === 'End') next = n - 1;
      else if (/^[1-9]$/.test(k)) next = Number(k) - 1;
      if (next === null || next < 0 || next > n - 1) return { state: { ...s, hover: null } };
      const state = { level: next, hover: null, dragging: false };
      return next === s.level ? { state } : { state, commit: next };
    }
  }
}

/** Whether a key is one the track answers (so the view can prevent the default). */
export const TRACK_KEYS = /^(Arrow(Left|Right|Up|Down)|Home|End|Enter|[1-9])$/;

/** The level the header names: a hover preview only while nothing is pressed. */
export const headerLevel = (s: TrackState) => (!s.dragging && s.hover !== null ? s.hover : s.level);
