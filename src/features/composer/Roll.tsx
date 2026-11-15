import { memo, useEffect, useState } from 'react';

/**
 * A number that rolls like an odometer when it changes: the old value slides out of a clipped
 * line and the new one slides in after it (up when it grows, down when it shrinks). About 150 ms.
 */
export const Roll = memo(function Roll({ value, className }: { value: number; className?: string }) {
  const [st, setSt] = useState<{ cur: number; old: number | null; up: boolean; n: number }>({ cur: value, old: null, up: true, n: 0 });
  if (st.cur !== value) setSt({ cur: value, old: st.cur, up: value > st.cur, n: st.n + 1 });
  useEffect(() => {
    if (st.old == null) return;
    const t = window.setTimeout(() => setSt((s) => (s.n === st.n ? { ...s, old: null } : s)), 200);
    return () => window.clearTimeout(t);
  }, [st.old, st.n]);
  return (
    <span className={className ? `roll ${className}` : 'roll'} data-dir={st.up ? 'up' : 'down'} aria-live="polite">
      {st.old != null && (
        <span key={`o${st.n}`} className="roll-old" aria-hidden>
          {st.old}
        </span>
      )}
      <span key={`n${st.n}`} className={st.old != null ? 'roll-new' : undefined}>
        {st.cur}
      </span>
    </span>
  );
});
