import { animate } from 'motion';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { pushBack } from '@m/lib/back';
import { haptic } from '@m/lib/native';
import { reduced, rubber } from './motion';

export { SPRING } from './motion';

/** In, out and back: springs the compositor runs (WAAPI), so a busy page never holds a sheet up. */
const RISE = { type: 'spring', stiffness: 420, damping: 40, mass: 0.9 } as const;
const FALL = { type: 'spring', stiffness: 460, damping: 46, restDelta: 2 } as const;
const BACK = { type: 'spring', stiffness: 380, damping: 34, mass: 0.9 } as const;
type Spring = typeof RISE | typeof FALL | typeof BACK;

/** Where a sheet's transform puts it now (mid-animation too). */
const yOf = (el: HTMLElement) => {
  const t = getComputedStyle(el).transform;
  return t && t !== 'none' ? new DOMMatrixReadOnly(t).m42 : 0;
};
const at = (y: number) => `translate3d(0px, ${y.toFixed(1)}px, 0px)`;

/**
 * A bottom sheet: opaque liquid glass over a dimmed screen, rising on a spring. It follows the
 * finger (from its grip, its title, or its list once that is scrolled to the top), rubber-bands
 * upward, and a flick or a pull past a fifth of it (or 120 px) closes it with the finger's speed.
 * Tap outside or press back to close. `dismissable={false}` keeps it until an answer.
 *
 * Speed: the sheet moves by its own transform only. Rising, falling and springing back are WAAPI
 * animations (the compositor runs them while the page mounts what the sheet shows); under the finger
 * the transform is written once per move. Nothing behind it moves: a screen that stepped back under
 * the sheet made the WebView paint and raster the conversation again on every frame of a drag.
 * The keyboard lifts a sheet only while a field inside it has the focus (sheets.css).
 */
export function Sheet({
  open: isOpen,
  onClose,
  children,
  title,
  label,
  dismissable = true,
  tall,
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: ReactNode;
  label?: string;
  dismissable?: boolean;
  tall?: boolean;
  className?: string;
}) {
  const [mounted, setMounted] = useState(isOpen);
  const sheet = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const h = useRef(600);
  const running = useRef<{ stop: () => void }[]>([]);
  /** The finger's speed when it let go (px/s, down is positive): a fling that closes carries it. */
  const fling = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismiss = useRef(dismissable);
  dismiss.current = dismissable;

  useEffect(() => {
    if (isOpen) setMounted(true);
  }, [isOpen]);

  useEffect(() => (isOpen ? pushBack(() => (closeRef.current(), true)) : undefined), [isOpen]);

  // A sheet that rises takes the screen: the keyboard of the field under it goes down.
  useEffect(() => {
    if (isOpen && document.activeElement instanceof HTMLElement && document.activeElement.closest('.sheet') === null) document.activeElement.blur();
  }, [isOpen]);

  const stop = () => {
    running.current.forEach((a) => a.stop());
    running.current = [];
  };
  const fade = (y: number) => Math.max(0, Math.min(1, 1 - Math.max(0, y) / Math.max(1, h.current)));
  /** Springs to `to` from wherever it is, with the finger's speed. */
  const go = (to: number, spring: Spring, velocity = 0) => {
    const el = sheet.current;
    const sc = scrim.current;
    if (!el || !sc) return Promise.resolve(false);
    stop();
    const from = yOf(el);
    const quick = reduced();
    const a = animate(el, { transform: [at(from), at(to)] }, quick ? { duration: 0.12 } : { ...spring, velocity });
    const b = animate(sc, { opacity: [fade(from), fade(to)] }, { duration: quick ? 0.12 : 0.26, ease: [0.2, 0.8, 0.2, 1] });
    const mine = [a, b];
    running.current = mine;
    return a.finished.then(
      () => {
        if (running.current !== mine) return false;
        running.current = [];
        el.style.transform = at(to);
        sc.style.opacity = String(fade(to));
        return true;
      },
      () => false,
    );
  };

  // In and out on a spring from the sheet's own height.
  useLayoutEffect(() => {
    if (!mounted) return;
    const el = sheet.current;
    const sc = scrim.current;
    if (!el || !sc) return;
    if (isOpen) {
      h.current = el.offsetHeight || 600;
      // Opening: from below its foot (or from where a close left it).
      if (!running.current.length && yOf(el) > h.current) {
        el.style.transform = at(h.current);
        sc.style.opacity = '0';
      }
      void go(0, RISE);
      return;
    }
    // Closing: down from where it is, with the fling's speed, then gone.
    let live = true;
    void go(h.current + 24, FALL, Math.max(0, fling.current)).then((done) => done && live && setMounted(false));
    fling.current = 0;
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mounted]);

  useEffect(() => () => stop(), []);

  // The finger: grip and title always drag; the list drags once it is at its top and pulled down.
  useEffect(() => {
    const el = sheet.current;
    const sc = scrim.current;
    if (!el || !sc || !mounted) return;
    let startY = 0;
    let startX = 0;
    let from = 0;
    let cur = 0;
    let mode: 'idle' | 'maybe' | 'drag' | 'scroll' = 'idle';
    let handle = false;
    let samples: { t: number; y: number }[] = [];
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1 || !dismiss.current) return;
      const t = e.target as HTMLElement;
      // Fields and things that scroll sideways keep their own gestures.
      if (t.closest('input, textarea, .no-drag')) return;
      handle = !!t.closest('.sheet-grip, .sheet-head');
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      mode = 'maybe';
      samples = [{ t: performance.now(), y: startY }];
    };
    const move = (e: TouchEvent) => {
      if (mode === 'idle' || mode === 'scroll') return;
      const cy = e.touches[0].clientY;
      const dy = cy - startY;
      const dx = e.touches[0].clientX - startX;
      if (mode === 'maybe') {
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
        const atTop = (body.current?.scrollTop ?? 0) <= 0;
        if (Math.abs(dx) > Math.abs(dy) || (!handle && (dy < 0 || !atTop))) {
          mode = 'scroll';
          return;
        }
        mode = 'drag';
        stop();
        from = yOf(el);
        startY = cy;
      }
      e.preventDefault();
      const d = cy - startY + from;
      cur = d >= 0 ? d : rubber(d, 48);
      el.style.transform = at(cur);
      sc.style.opacity = String(fade(cur));
      const now = performance.now();
      samples.push({ t: now, y: cy });
      // The speed is read over the last tenth of a second.
      while (samples.length > 2 && now - samples[0].t > 100) samples.shift();
    };
    const up = () => {
      if (mode !== 'drag') {
        mode = 'idle';
        return;
      }
      mode = 'idle';
      const a = samples[0];
      const b = samples[samples.length - 1];
      const v = a && b && b.t > a.t ? ((b.y - a.y) / (b.t - a.t)) * 1000 : 0;
      // A fifth of it, or 120 px, or a flick down: it goes. Otherwise it springs back with the finger's speed.
      if (cur > Math.min(h.current * 0.22, 120) || (v > 450 && cur > 8)) {
        haptic('tap');
        fling.current = v;
        closeRef.current();
        return;
      }
      void go(0, BACK, v);
    };
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', up, { passive: true });
    el.addEventListener('touchcancel', up, { passive: true });
    return () => {
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', up);
      el.removeEventListener('touchcancel', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  if (!mounted) return null;
  // On the body, above every screen and its header (a screen's own layers would trap it under them).
  return createPortal(
    <div className="sheet-layer" role="presentation" data-closing={!isOpen || undefined}>
      <div ref={scrim} className="sheet-scrim" style={{ opacity: 0 }} onClick={dismissable && isOpen ? onClose : undefined} />
      <div
        ref={sheet}
        className={`sheet ${className ?? ''}`}
        data-tall={tall || undefined}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? (typeof title === 'string' ? title : undefined)}
        style={{ transform: at(2000) }}
      >
        <div className="sheet-grip" aria-hidden>
          <span />
        </div>
        {title && (
          <div className="sheet-head">
            <h2 className="sheet-title">{title}</h2>
          </div>
        )}
        <div className="sheet-body" ref={body}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** One choice in a sheet's list: a 52 px row with a check on the current one. */
export function Choice({
  selected,
  onPick,
  children,
  icon,
  aside,
  mark,
}: {
  selected?: boolean;
  onPick: () => void;
  children: ReactNode;
  icon?: ReactNode;
  aside?: ReactNode;
  /** Answers to a question: a round mark (one answer) or a square one (several), filled when picked. */
  mark?: 'radio' | 'check';
}) {
  if (mark)
    return (
      <button type="button" className="choice choice-mark" data-selected={selected || undefined} onClick={onPick} role={mark === 'radio' ? 'radio' : 'checkbox'} aria-checked={!!selected}>
        <span className="pick" data-kind={mark} aria-hidden>
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="choice-label">{children}</span>
      </button>
    );
  return (
    <button type="button" className="choice" data-selected={selected || undefined} onClick={onPick} aria-pressed={selected}>
      {icon && <span className="choice-icon">{icon}</span>}
      <span className="choice-label">{children}</span>
      {aside && <span className="choice-aside">{aside}</span>}
      <span className="choice-check" aria-hidden>
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
        </svg>
      </span>
    </button>
  );
}
