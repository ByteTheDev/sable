import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useStore } from '@/state/store';

type State = ReturnType<typeof useStore.getState>;

/**
 * A store selection that follows the store one task behind, for chrome that need not change in the
 * same frame as the stage: the top bar's crumbs, the sidebar's order. Store updates arrive inside
 * the bridge's messages and render at once (a session mounting is one of them); what reads through
 * this renders in a task of its own right after, and a burst of updates renders it once. Rendered
 * there and then (flushSync): left to React's default lane it would be swept into the next update
 * that renders synchronously, which is often the very mount it is meant to stay out of. Not a
 * transition either: nothing that streams can hold it back.
 *
 * `select` must be a function of the state alone (it is read from a ref, the latest one wins).
 */
export function useLaggedStore<T>(select: (s: State) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const [value, setValue] = useState(() => select(useStore.getState()));
  const sel = useRef(select);
  sel.current = select;
  const eq = useRef(equal);
  eq.current = equal;
  useEffect(() => {
    let timer = 0;
    let last = value;
    const settle = (now: boolean) => {
      timer = 0;
      const next = sel.current(useStore.getState());
      if (eq.current(last, next)) return;
      last = next;
      if (now) flushSync(() => setValue(next));
      else setValue(next);
    };
    // A change between the first render and this effect.
    settle(false);
    const off = useStore.subscribe(() => {
      if ((window as unknown as { __lagOff?: boolean }).__lagOff) return settle(false); // TEMP-AB
      if (!timer) timer = window.setTimeout(() => settle(true), 0);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
    // Subscribed once; `value` is only its starting point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return value;
}
