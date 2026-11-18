import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useStore } from '@/state/store';

type State = ReturnType<typeof useStore.getState>;

/** Holds a deferred update until a moment has passed (calls `fn` then); returns a cancel. */
export type Gate = (fn: () => void) => () => void;

interface Options {
  /** Waits for this before settling (e.g. a sent message's landing), at most `maxWait` ms. */
  gate?: Gate;
  maxWait?: number;
}

/**
 * A store selection that follows the store one task behind, for chrome that need not change in the
 * same frame as the stage: the top bar's extras, the sidebar's order. Store updates arrive inside
 * the bridge's messages and render at once (a session mounting is one of them); what reads through
 * this renders in a task of its own right after, and a burst of updates renders it once. With a
 * `gate` it also waits for that moment (a send's landing), so its work stays out of those frames.
 * Rendered there and then (flushSync): left to React's default lane it would be swept into the next
 * update that renders synchronously, which is often the very mount it is meant to stay out of.
 * Not a transition either: nothing that streams can hold it back.
 *
 * `select` must be a function of the state alone (it is read from a ref, the latest one wins).
 */
export function useLaggedStore<T>(select: (s: State) => T, equal: (a: T, b: T) => boolean = Object.is, opts: Options = {}): T {
  const [value, setValue] = useState(() => select(useStore.getState()));
  const sel = useRef(select);
  sel.current = select;
  const eq = useRef(equal);
  eq.current = equal;
  const gate = useRef(opts.gate);
  gate.current = opts.gate;
  const maxWait = opts.maxWait ?? 2500;
  useEffect(() => {
    let timer = 0;
    let cap = 0;
    let ungate: (() => void) | null = null;
    let last = value;
    const settle = (now: boolean) => {
      window.clearTimeout(timer);
      window.clearTimeout(cap);
      ungate?.();
      timer = cap = 0;
      ungate = null;
      const next = sel.current(useStore.getState());
      if (eq.current(last, next)) return;
      last = next;
      if (now) flushSync(() => setValue(next));
      else setValue(next);
    };
    // A task of its own, once the gate opens (or the wait is over).
    const later = () => {
      if (timer) return;
      timer = window.setTimeout(() => settle(true), 0);
    };
    // A change between the first render and this effect.
    settle(false);
    const off = useStore.subscribe(() => {
      if (timer || ungate) return;
      const g = gate.current;
      if (!g) return later();
      let opened = false;
      const un = g(() => {
        opened = true;
        ungate = null;
        later();
      });
      if (opened) return;
      ungate = un;
      cap = window.setTimeout(later, maxWait);
    });
    return () => {
      off();
      window.clearTimeout(timer);
      window.clearTimeout(cap);
      ungate?.();
    };
    // Subscribed once; `value` is only its starting point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return value;
}
