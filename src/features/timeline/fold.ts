import { useCallback, useSyncExternalStore } from 'react';

/**
 * What the reader has opened in the conversation (a turn's work, a run of steps), remembered
 * while the app is open. Keyed by session and item id; each key notifies only its own readers,
 * so opening one fold re-renders nothing else.
 */
const state = new Map<string, boolean>();
const listeners = new Map<string, Set<() => void>>();

function emit(key: string) {
  listeners.get(key)?.forEach((l) => l());
}

export function getFold(key: string): boolean | undefined {
  return state.get(key);
}

export function setFold(key: string, open: boolean) {
  if (state.get(key) === open) return;
  state.set(key, open);
  emit(key);
}

function subscribe(key: string, l: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(l);
  return () => {
    set.delete(l);
    if (!set.size) listeners.delete(key);
  };
}

/** A remembered open/closed flag. `fallback` applies until the reader chooses. */
export function useFold(key: string, fallback = false): [boolean, (open: boolean) => void] {
  const sub = useCallback((l: () => void) => subscribe(key, l), [key]);
  const value = useSyncExternalStore(sub, () => state.get(key));
  const set = useCallback((open: boolean) => setFold(key, open), [key]);
  return [value ?? fallback, set];
}

/** How many of `keys` are open, kept current as any of them changes. */
export function useOpenCount(keys: string[]): number {
  const sig = keys.join('\u0001');
  const sub = useCallback(
    (l: () => void) => {
      const offs = sig ? sig.split('\u0001').map((k) => subscribe(k, l)) : [];
      return () => offs.forEach((off) => off());
    },
    [sig],
  );
  return useSyncExternalStore(sub, () => keys.reduce((n, k) => n + (state.get(k) ? 1 : 0), 0));
}

export const foldKey = (sessionId: string, id: string, part = 'work') => `${sessionId}\u0000${part}\u0000${id}`;
