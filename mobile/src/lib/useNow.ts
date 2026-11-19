import { useSyncExternalStore } from 'react';

/** One shared clock for relative times, ticking every 30 s while someone listens. */
let now = Date.now();
const listeners = new Set<() => void>();
let timer: number | undefined;

function subscribe(l: () => void) {
  listeners.add(l);
  if (timer === undefined) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      listeners.forEach((fn) => fn());
    }, 30_000);
  }
  return () => {
    listeners.delete(l);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export const useNow = () => useSyncExternalStore(subscribe, () => now);
