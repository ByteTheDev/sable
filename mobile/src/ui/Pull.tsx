import { animate } from 'motion';
import { useEffect, useRef, type ReactNode } from 'react';
import { haptic } from '@m/lib/native';
import { LogoMark } from './marks';

const THRESH = 72;
const MAX = 120;

/**
 * Pull to refresh: the list follows the finger on a rubber band and Sable's mark builds from its
 * own cells under it, one cell per step of the pull (in the dither order of the launch). Past the
 * line it clicks once; let go and the mark glints while the desktop is asked again, then the list
 * springs back. Direct DOM writes on the compositor (transform, one custom property), no renders.
 */
export function Pull({ onRefresh, children, className }: { onRefresh: () => Promise<unknown>; children: ReactNode; className?: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const run = useRef(onRefresh);
  run.current = onRefresh;

  useEffect(() => {
    const sc = scroller.current;
    const body = content.current;
    const m = mark.current;
    if (!sc || !body || !m) return;
    let startY = 0;
    let startX = 0;
    let pulling = false;
    let decided = false;
    let y = 0;
    let busy = false;
    let armed = false;
    let spring: { stop: () => void } | null = null;

    const set = (v: number) => {
      y = v;
      body.style.transform = v ? `translate3d(0, ${v}px, 0)` : '';
      m.style.setProperty('--p', String(Math.min(1, v / THRESH)));
      // The list's body is clear: the mark shows only once the list has moved past it.
      m.style.opacity = String(Math.max(0, Math.min(1, (v - 30) / 26)));
    };
    const settle = (to: number) => {
      spring?.stop();
      spring = animate(y, to, { type: 'spring', stiffness: 420, damping: 38, onUpdate: set });
    };

    const down = (e: TouchEvent) => {
      if (busy || e.touches.length !== 1) return;
      spring?.stop();
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      pulling = sc.scrollTop <= 0;
      decided = false;
      armed = false;
    };
    const move = (e: TouchEvent) => {
      if (!pulling || busy) return;
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;
      if (!decided) {
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
        decided = true;
        // Only a downward pull from the very top; anything else is a normal scroll.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || sc.scrollTop > 0) {
          pulling = false;
          return;
        }
      }
      if (dy <= 0) return set(0);
      // A rubber band: easy at first, stiffer as it goes.
      const v = MAX * (1 - Math.exp(-dy / (MAX * 1.6)));
      set(v);
      if (!armed && v >= THRESH) {
        armed = true;
        haptic('select');
      } else if (armed && v < THRESH) armed = false;
    };
    const up = () => {
      if (!pulling) return;
      pulling = false;
      if (y >= THRESH && !busy) {
        busy = true;
        m.dataset.busy = '';
        settle(THRESH * 0.78);
        const t0 = performance.now();
        void run
          .current()
          .catch(() => {})
          .then(() => new Promise((r) => setTimeout(r, Math.max(0, 650 - (performance.now() - t0)))))
          .then(() => {
            delete m.dataset.busy;
            busy = false;
            settle(0);
          });
      } else settle(0);
    };
    sc.addEventListener('touchstart', down, { passive: true });
    sc.addEventListener('touchmove', move, { passive: true });
    sc.addEventListener('touchend', up, { passive: true });
    sc.addEventListener('touchcancel', up, { passive: true });
    return () => {
      spring?.stop();
      sc.removeEventListener('touchstart', down);
      sc.removeEventListener('touchmove', move);
      sc.removeEventListener('touchend', up);
      sc.removeEventListener('touchcancel', up);
    };
  }, []);

  return (
    <div className={className} ref={scroller}>
      <div className="pull" ref={mark} aria-hidden>
        <LogoMark size={22} cells />
      </div>
      <div className="pull-body" ref={content}>
        {children}
      </div>
    </div>
  );
}
