import { useEffect, useRef } from 'react';

/**
 * How often a view that shows limits reads them again while it is on screen. The reads are cheap
 * (a live agent answers, or the last known windows come back), but Claude's usage endpoint refuses
 * when asked too often, so not much faster than this.
 */
export const LIMITS_TICK_MS = 2 * 60_000;

/**
 * Calls `tick` every `every` ms while `on` and the window is visible, and once when the window
 * comes back after being hidden. Nothing runs while hidden.
 */
export function useLimitsTicker(on: boolean, tick: () => void, every = LIMITS_TICK_MS) {
  const ref = useRef(tick);
  ref.current = tick;
  useEffect(() => {
    if (!on) return;
    let timer = 0;
    const arm = () => {
      window.clearInterval(timer);
      timer = document.visibilityState === 'visible' ? window.setInterval(() => ref.current(), every) : 0;
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') ref.current();
      arm();
    };
    arm();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [on, every]);
}
