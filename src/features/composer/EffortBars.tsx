import { memo, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import type { Effort } from '@shared/protocol';
import { EFFORT_LABEL } from './choice';

export interface EffortBarsProps {
  efforts: Effort[];
  /** The chosen level; undefined is the model default (empty bars). */
  value: Effort | undefined;
  /** What "Default" resolves to, for the label. */
  fallback?: Effort;
  /** Picking the lit top bar again goes back to the default (home only). */
  clearable: boolean;
  onChange: (e: Effort | undefined) => void;
}

/**
 * Reasoning effort as a row of small level bars, filled up to the current level. Click or drag
 * across to pick, scroll or use the arrow keys to step. The level's name shows above for a moment
 * after a change. The bars fill and empty as a short wave from the old level to the new.
 */
export const EffortBars = memo(function EffortBars({ efforts, value, fallback, clearable, onChange }: EffortBarsProps) {
  const n = efforts.length;
  const committed = value ? efforts.indexOf(value) : -1;
  const [preview, setPreview] = useState<number | null>(null);
  const [flash, setFlash] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; moved: boolean } | null>(null);
  const timer = useRef(0);
  const flashTimer = useRef(0);
  const level = preview ?? committed;

  // The wave starts where the bars were last drawn.
  const prev = useRef(level);
  const origin = prev.current;
  useEffect(() => {
    prev.current = level;
  }, [level]);

  useEffect(() => () => (window.clearTimeout(timer.current), window.clearTimeout(flashTimer.current)), []);
  // A change from outside (another window, the slash command) settles the preview.
  useEffect(() => {
    if (!drag.current) setPreview(null);
  }, [committed]);

  const show = () => {
    setFlash((f) => f + 1);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(0), 1100);
  };

  const commit = (i: number, delay = 0) => {
    window.clearTimeout(timer.current);
    const go = () => {
      const next = i < 0 ? undefined : efforts[i];
      if (next !== value) onChange(next);
    };
    if (delay) timer.current = window.setTimeout(go, delay);
    else go();
  };

  const step = (by: number) => {
    const min = clearable ? -1 : 0;
    const next = Math.max(min, Math.min(n - 1, level + by));
    if (next === level) return show();
    setPreview(next);
    show();
    commit(next, 260);
  };

  /** The bar nearest the pointer (by centres), so the ends of the pill count as the first and last level. */
  const at = (clientX: number) => {
    const bars = box.current?.querySelectorAll<HTMLElement>('.ef-bar');
    if (!bars?.length) return level;
    let best = 0;
    let d = Infinity;
    bars.forEach((b, i) => {
      const r = b.getBoundingClientRect();
      const dist = Math.abs(clientX - (r.left + r.width / 2));
      if (dist < d) {
        d = dist;
        best = i;
      }
    });
    return best;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic or already-released pointer */
    }
    e.currentTarget.focus({ preventScroll: true });
    const i = at(e.clientX);
    drag.current = { start: i, moved: false };
    setPreview(i);
    show();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const i = at(e.clientX);
    if (i !== d.start) d.moved = true;
    if (i !== preview) {
      setPreview(i);
      show();
    }
  };
  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    let i = preview ?? committed;
    // Clicking the lit top bar again (without dragging) returns to the default.
    if (!d.moved && clearable && i === committed && committed >= 0) i = -1;
    setPreview(i === committed ? null : i);
    commit(i);
  };

  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaY) < 1 && Math.abs(e.deltaX) < 1) return;
    step((Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? -e.deltaY : e.deltaX) > 0 ? 1 : -1);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowUp') step(1);
    else if (k === 'ArrowLeft' || k === 'ArrowDown') step(-1);
    else if (k === 'Home') step(-n);
    else if (k === 'End') step(n);
    else return;
    e.preventDefault();
  };

  const label = level < 0 ? `Default${fallback ? ` (${EFFORT_LABEL[fallback]})` : ''}` : EFFORT_LABEL[efforts[level]];

  return (
    <div
      ref={box}
      className="ef"
      role="slider"
      tabIndex={0}
      aria-label="Reasoning effort"
      aria-valuemin={0}
      aria-valuemax={n}
      aria-valuenow={level + 1}
      aria-valuetext={label}
      data-default={level < 0 || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onFocus={(e) => e.currentTarget.matches(':focus-visible') && show()}
    >
      <span className="ef-bars" aria-hidden>
        {efforts.map((e, i) => (
          <span key={e} className="ef-bar" style={{ height: `${Math.round(6 + (i * 7) / Math.max(1, n - 1))}px` }}>
            <span className="ef-fill" data-on={i <= level || undefined} style={{ transitionDelay: `${Math.max(0, Math.abs(i - origin) - 1) * 18}ms` }} />
          </span>
        ))}
      </span>
      <span className="ef-tip" data-on={flash > 0 || undefined} aria-hidden>
        <span className="ef-tip-in" key={label}>
          {label}
        </span>
      </span>
    </div>
  );
});
