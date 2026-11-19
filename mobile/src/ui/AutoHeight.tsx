import { motion } from 'motion/react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { reduced, REVEAL } from './motion';

/**
 * A box whose height follows its content on a spring: what arrives (models, limits, an error)
 * grows the box instead of pushing everything under it in one frame. The first height is taken
 * as it is (nothing animates in on mount).
 */
export function AutoHeight({ children, className, role, label }: { children: ReactNode; className?: string; role?: string; label?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | 'auto'>('auto');
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    setH(el.offsetHeight);
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <motion.div className={className} role={role} aria-label={label} style={{ overflow: 'hidden' }} initial={false} animate={{ height: h }} transition={reduced() ? { duration: 0 } : REVEAL}>
      <div ref={inner} className="auto-h">
        {children}
      </div>
    </motion.div>
  );
}
