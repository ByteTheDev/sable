import { useEffect, useRef, useState, type ReactNode } from 'react';
import './collapse.css';

/**
 * Reveals its children with an animated height. Children are mounted only while open
 * (or closing), so collapsed details cost nothing. The first render never animates:
 * a transcript loaded from history appears in its final shape. Once fully open it stops
 * clipping (`data-settled`), so rings, shadows and labels can reach past its edges.
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  const [settled, setSettled] = useState(open);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSettled(false);
    if (open) {
      setMounted(true);
      // Two frames: one to mount at height 0, one to start the transition.
      let b = 0;
      const a = requestAnimationFrame(() => {
        b = requestAnimationFrame(() => setShown(true));
      });
      // Fallback in case the transition never ends (reduced motion, hidden tab).
      const t = window.setTimeout(() => setSettled(true), 450);
      return () => {
        cancelAnimationFrame(a);
        cancelAnimationFrame(b);
        window.clearTimeout(t);
      };
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), 400);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!mounted && !open) return null;
  return (
    <div
      className={`collapse ${className ?? ''}`}
      data-open={shown && open ? '' : undefined}
      data-settled={settled && open ? '' : undefined}
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget || e.propertyName !== 'grid-template-rows') return;
        if (open) setSettled(true);
        else setMounted(false);
      }}
    >
      <div className="collapse-inner">{mounted || open ? children : null}</div>
    </div>
  );
}
