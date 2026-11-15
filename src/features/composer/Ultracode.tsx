import { memo, useEffect, useRef, useState, type RefObject } from 'react';
import { pulseFrom, reducedMotion } from '@/lib/motion';

const SEGMENTS = 22;
const CHARGE_MS = 720;
const DRAIN_MS = 400;

type Phase = 'charge' | 'on' | 'drain';

/**
 * The composer's "ultra" edge (ultracode on, or an Ultra level). Turning it on races one band of
 * dithered ivory light around the card's edge and pulses the backdrop from it; afterwards only a
 * faint, still hairline stays. Nothing loops. Small leaf elements moved along the edge
 * (offset-path), so the lap costs a few composited moves and no layout.
 */
export const UltraEdge = memo(function UltraEdge({ on, card }: { on: boolean; card: RefObject<HTMLElement | null> }) {
  const [phase, setPhase] = useState<Phase | null>(on ? 'on' : null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const still = reducedMotion();
    if (on) {
      if (still) return setPhase('on');
      setPhase('charge');
      pulseFrom(card.current, 0.9);
      const t = window.setTimeout(() => setPhase('on'), CHARGE_MS);
      return () => window.clearTimeout(t);
    }
    if (still) return setPhase(null);
    setPhase((p) => (p ? 'drain' : null));
    const t = window.setTimeout(() => setPhase(null), DRAIN_MS);
    return () => window.clearTimeout(t);
  }, [on, card]);

  if (!phase) return null;
  return (
    <span className="uc" data-phase={phase} aria-hidden>
      {phase === 'charge' && (
        <span className="uc-charge">
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <i key={i} style={{ ['--i' as string]: i }} />
          ))}
        </span>
      )}
    </span>
  );
});
