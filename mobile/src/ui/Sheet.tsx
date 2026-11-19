import { animate, motion, useMotionValue, useTransform, type MotionValue } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { pushBack } from '@m/lib/back';
import { haptic } from '@m/lib/native';
import { FLING, reduced, rubber, SPRING } from './motion';

export { SPRING } from './motion';

/**
 * The screen under the newest open sheet steps back (a little smaller, rounded), as a page under a
 * card does: one transform on the app's layer, written per frame from the sheet's own position.
 */
const open: MotionValue<number>[] = [];
let unsub: (() => void) | null = null;
function depthFollow() {
  unsub?.();
  unsub = null;
  const app = document.querySelector<HTMLElement>('.app');
  const top = open[open.length - 1];
  if (!app) return;
  if (!top) {
    app.style.transform = '';
    app.removeAttribute('data-depth');
    return;
  }
  app.setAttribute('data-depth', '');
  const write = (p: number) => {
    const k = Math.max(0, Math.min(1, p));
    app.style.transform = k > 0.001 ? `translate3d(0, ${(k * 8).toFixed(2)}px, 0) scale(${(1 - k * 0.045).toFixed(4)})` : '';
  };
  write(top.get());
  unsub = top.on('change', write);
}

/**
 * A bottom sheet: frosted ink with grain over a dimmed screen, rising on a spring. It follows the
 * finger (from its grip, its title, or its list once that is scrolled to the top), rubber-bands
 * upward, and a flick or a long pull closes it with the finger's speed. Tap outside or press back
 * to close. `dismissable={false}` keeps it until an answer.
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
  const body = useRef<HTMLDivElement>(null);
  const y = useMotionValue(2000);
  const h = useRef(600);
  // 1 open, 0 closed: drives the scrim and the screen behind.
  const p = useTransform(y, (v) => 1 - Math.max(0, v) / Math.max(1, h.current));
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

  // In and out on a spring from the sheet's own height.
  useLayoutEffect(() => {
    if (!mounted) return;
    const el = sheet.current;
    if (!el) return;
    h.current = el.offsetHeight || 600;
    if (isOpen) {
      if (y.get() > h.current) y.set(h.current);
      open.push(p);
      depthFollow();
      const a = animate(y, 0, reduced() ? { duration: 0.12 } : SPRING);
      return () => {
        a.stop();
        const i = open.indexOf(p);
        if (i >= 0) open.splice(i, 1);
        depthFollow();
      };
    }
    // Closing: down from where it is, then gone.
    open.push(p);
    depthFollow();
    const a = animate(y, h.current + 24, reduced() ? { duration: 0.12 } : { type: 'spring', stiffness: 520, damping: 50, restDelta: 2 });
    void a.finished.then(() => setMounted(false));
    return () => {
      a.stop();
      const i = open.indexOf(p);
      if (i >= 0) open.splice(i, 1);
      depthFollow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mounted]);

  // The finger: grip and title always drag; the list drags once it is at its top and pulled down.
  useEffect(() => {
    const el = sheet.current;
    if (!el || !mounted) return;
    let startY = 0;
    let startX = 0;
    let from = 0;
    let mode: 'idle' | 'maybe' | 'drag' | 'scroll' = 'idle';
    let handle = false;
    let samples: { t: number; y: number }[] = [];
    let spring: { stop: () => void } | null = null;
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1 || !dismiss.current) return;
      const t = e.target as HTMLElement;
      // Fields and things that scroll sideways keep their own gestures.
      if (t.closest('input, textarea, .no-drag')) return;
      handle = !!t.closest('.sheet-grip, .sheet-head');
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      from = y.get();
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
        spring?.stop();
        startY = cy;
      }
      e.preventDefault();
      const d = cy - startY + from;
      y.set(d >= 0 ? d : rubber(d, 48));
      samples.push({ t: performance.now(), y: cy });
      if (samples.length > 6) samples.shift();
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
      const cur = y.get();
      if (cur > h.current * 0.32 || (v > 650 && cur > 12)) {
        haptic('tap');
        closeRef.current();
        return;
      }
      spring = animate(y, 0, { ...FLING, velocity: v });
    };
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', up, { passive: true });
    el.addEventListener('touchcancel', up, { passive: true });
    return () => {
      spring?.stop();
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', up);
      el.removeEventListener('touchcancel', up);
    };
  }, [mounted, y]);

  if (!mounted) return null;
  // On the body, above every screen and its header (a screen's own layers would trap it under them).
  return createPortal(
    <div className="sheet-layer" role="presentation" data-closing={!isOpen || undefined}>
      <motion.div className="sheet-scrim" style={{ opacity: p }} onClick={dismissable && isOpen ? onClose : undefined} />
      <motion.div
        ref={sheet}
        className={`sheet ${className ?? ''}`}
        data-tall={tall || undefined}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? (typeof title === 'string' ? title : undefined)}
        style={{ y }}
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
      </motion.div>
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
