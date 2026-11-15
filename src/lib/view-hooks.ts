/** Small view hooks shared by the transcript components. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** The current time, refreshed every `interval` ms while `active`. One timer per component. */
export function useNow(active: boolean, interval = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(t);
  }, [active, interval]);
  return now;
}

// One observer per scroll container for every element that wants to know when it first comes
// near the viewport. The container is the observer's root: a margin on the window would be
// clipped away by the scroller, so content just above or below it would only build once visible.
const seen = new WeakMap<Element, () => void>();
const byRoot = new WeakMap<Element, IntersectionObserver>();
let windowIo: IntersectionObserver | undefined;

const onEntries = (entries: IntersectionObserverEntry[], io: IntersectionObserver) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    seen.get(e.target)?.();
    seen.delete(e.target);
    io.unobserve(e.target);
  }
};

function observer(el: Element) {
  const root = el.parentElement?.closest('.scroll') ?? null;
  if (!root) return (windowIo ??= new IntersectionObserver(onEntries, { rootMargin: '600px 0px' }));
  let io = byRoot.get(root);
  if (!io) byRoot.set(root, (io = new IntersectionObserver(onEntries, { root, rootMargin: '600px 0px' })));
  return io;
}

/** True once the element has been within ~600px of the viewport. Used to defer costly work. */
export function useNearViewport(ref: RefObject<Element | null>, skip = false, eager = false): boolean {
  const [near, setNear] = useState(false);
  // `eager`: decide before the first paint when the element is already on screen, so
  // content that mounts in view (a diff that just arrived) never shows a blank frame.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!eager || !el || near || skip) return;
    const r = el.getBoundingClientRect();
    if (r.width + r.height > 0 && r.bottom > -600 && r.top < window.innerHeight + 600) setNear(true);
  }, [ref, near, skip, eager]);
  useEffect(() => {
    const el = ref.current;
    if (!el || near || skip) return;
    if (typeof IntersectionObserver !== 'function') {
      setNear(true);
      return;
    }
    seen.set(el, () => setNear(true));
    const io = observer(el);
    io.observe(el);
    return () => {
      seen.delete(el);
      io.unobserve(el);
    };
  }, [ref, near, skip]);
  return near;
}

/** Copies text and reports success for a moment so a button can show a check. */
export function useCopy(timeout = 1400): [copied: boolean, copy: (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback(
    (text: string) => {
      const done = () => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), timeout);
      };
      const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
          done();
        } catch {
          /* clipboard unavailable */
        }
        ta.remove();
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    },
    [timeout],
  );
  return [copied, copy];
}
