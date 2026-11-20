import type { Built } from './nav-model';
import type { Group } from './turns';

/**
 * What the conversation's map hears from elsewhere, per session: the find bar's matches (ticks on
 * the map) and the keys that step between messages (Alt+Up, Alt+Down), which the map answers
 * from its own model of where every message stands.
 */

/** The turn layout as the timeline built it, handed to the map after each commit (one per timeline). */
export interface NavLayout {
  groups: readonly Group[];
  built: Built;
}

export interface NavFeed {
  get(): NavLayout | null;
  set(layout: NavLayout): void;
  subscribe(l: () => void): () => void;
}

export function navFeed(): NavFeed {
  let cur: NavLayout | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => cur,
    set(layout) {
      if (cur && cur.groups === layout.groups && cur.built.lead === layout.built.lead && cur.built.gapFrom === layout.built.gapFrom && cur.built.hidden === layout.built.hidden) return;
      cur = layout;
      subs.forEach((l) => l());
    },
    subscribe(l) {
      subs.add(l);
      return () => subs.delete(l);
    },
  };
}

export interface FindMarks {
  /** Matching items, in conversation order. */
  ids: readonly string[];
  /** The match the find bar is on. */
  current?: string;
}

type Listener = () => void;

const finds = new Map<string, FindMarks>();
const listeners = new Map<string, Set<Listener>>();
const steppers = new Map<string, (dir: 1 | -1) => boolean>();

const emit = (sessionId: string) => listeners.get(sessionId)?.forEach((l) => l());

export function setFindMarks(sessionId: string, marks: FindMarks | null) {
  const was = finds.get(sessionId);
  if (!marks || !marks.ids.length) {
    if (!was) return;
    finds.delete(sessionId);
  } else {
    if (was && was.current === marks.current && was.ids === marks.ids) return;
    finds.set(sessionId, marks);
  }
  emit(sessionId);
}

export const findMarks = (sessionId: string) => finds.get(sessionId);

export function onFindMarks(sessionId: string, l: Listener): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  set.add(l);
  return () => {
    set.delete(l);
    if (!set.size) listeners.delete(sessionId);
  };
}

/** The open conversation's map takes the message keys; false when there is none to take them. */
export function stepMessage(sessionId: string, dir: 1 | -1): boolean {
  return steppers.get(sessionId)?.(dir) ?? false;
}

export function takeSteps(sessionId: string, step: (dir: 1 | -1) => boolean): () => void {
  steppers.set(sessionId, step);
  return () => {
    if (steppers.get(sessionId) === step) steppers.delete(sessionId);
  };
}
