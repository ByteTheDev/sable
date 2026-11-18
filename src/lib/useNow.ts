import { useSyncExternalStore } from 'react';

/**
 * One shared minute clock for relative times ("4m", "2h"). A single interval
 * serves every subscriber, and it stops when nobody listens.
 */

let now = Date.now();
const listeners = new Set<() => void>();
let timer: number | undefined;

function subscribe(l: () => void) {
  listeners.add(l);
  if (timer === undefined) {
    // The clock was stopped: it starts from the time now, not from when it stopped (React reads the
    // snapshot again right after subscribing, so the first render after a pause is current).
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const fn of listeners) fn();
    }, 30_000);
  }
  return () => {
    listeners.delete(l);
    if (!listeners.size && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
