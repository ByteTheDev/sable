import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { EASE_STD, play } from '@/lib/motion';

/**
 * A label inside a control whose content changes as "fade, resize, fade": the old content fades
 * out (60 ms), the box resizes to the new content (110 ms, standard curve), the new content fades
 * in (60 ms). A re-render with the same key changes nothing.
 */
export function Morph({ k, children, className }: { k: string; children: ReactNode; className?: string }) {
  const [st, setSt] = useState<{ k: string; old: ReactNode | null; n: number }>({ k, old: null, n: 0 });
  const box = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const width = useRef(0);
  const last = useRef<ReactNode>(children);

  if (st.k !== k) setSt({ k, old: last.current, n: st.n + 1 });

  useLayoutEffect(() => {
    last.current = children;
  });

  useLayoutEffect(() => {
    const el = box.current;
    const now = inner.current?.offsetWidth ?? 0;
    const was = width.current;
    width.current = now;
    if (!st.n || !el) return;
    play(inner.current, [{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], { duration: 230, easing: 'linear' });
    if (Math.abs(now - was) > 1 && was > 0) play(el, [{ width: `${was}px` }, { width: `${now}px` }], { duration: 110, delay: 60, easing: EASE_STD, fill: 'backwards' });
    const t = window.setTimeout(() => setSt((s) => (s.n === st.n ? { ...s, old: null } : s)), 80);
    return () => window.clearTimeout(t);
  }, [st.n]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span ref={box} className={className ? `morph ${className}` : 'morph'}>
      <span ref={inner} className="morph-in" key={st.n}>
        {children}
      </span>
      {st.old != null && (
        <span className="morph-old" aria-hidden key={`o${st.n}`}>
          {st.old}
        </span>
      )}
    </span>
  );
}
