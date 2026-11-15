import { memo, useEffect, useRef, useState, type RefObject } from 'react';
import { pulseFrom, reducedMotion } from '@/lib/motion';
import { Tip } from '@/ui';

const SEGMENTS = 22;
const CHARGE_MS = 720;
const DRAIN_MS = 560;

/** The ultracode glyph: two stacked heads, the same mark the send key gains when it is on. */
function UltraGlyph() {
  return (
    <svg className="uc-glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path className="uc-g1" d="M4.2 8.2 8 4.4l3.8 3.8" />
      <path className="uc-g2" d="M4.2 12.2 8 8.4l3.8 3.8" />
    </svg>
  );
}

/** The toolbar switch. Quiet when off; lit (ivory glyph on one fill step) when on. */
export const UltraToggle = memo(function UltraToggle({ on, onToggle }: { on: boolean; onToggle: (on: boolean) => void }) {
  return (
    <Tip label={on ? 'Ultracode is on' : 'Ultracode'} side="top">
      <button type="button" className="uc-toggle" aria-label="Ultracode" aria-pressed={on} data-on={on || undefined} onClick={() => onToggle(!on)}>
        <UltraGlyph />
      </button>
    </Tip>
  );
});

type Phase = 'charge' | 'run' | 'drain';

/**
 * The composer's power-mode light: a slow band of dithered ivory light travelling around the
 * card's edge. Switching on races it once around and pulses the backdrop; switching off lets it
 * drain away tail first. Small leaf elements moved along the edge (offset-path), so a frame costs
 * a few composited moves and no layout; paused while the window is hidden.
 */
export const UltraEdge = memo(function UltraEdge({ on, card }: { on: boolean; card: RefObject<HTMLElement | null> }) {
  const [phase, setPhase] = useState<Phase | null>(on ? 'run' : null);
  const [paused, setPaused] = useState(() => typeof document !== 'undefined' && document.hidden);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const still = reducedMotion();
    if (on) {
      if (still) return setPhase('run');
      setPhase('charge');
      pulseFrom(card.current, 0.9);
      const t = window.setTimeout(() => setPhase('run'), CHARGE_MS - 140);
      return () => window.clearTimeout(t);
    }
    if (still) return setPhase(null);
    setPhase((p) => (p ? 'drain' : null));
    const t = window.setTimeout(() => setPhase(null), DRAIN_MS);
    return () => window.clearTimeout(t);
  }, [on, card]);

  useEffect(() => {
    if (!phase) return;
    const vis = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [phase]);

  if (!phase) return null;
  const segs = Array.from({ length: SEGMENTS }, (_, i) => <i key={i} style={{ ['--i' as string]: i }} />);
  return (
    <span className="uc" data-phase={phase} data-paused={paused || undefined} aria-hidden>
      <span className="uc-run">{segs}</span>
      {phase === 'charge' && <span className="uc-charge">{segs}</span>}
    </span>
  );
});
