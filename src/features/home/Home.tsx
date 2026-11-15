import { useEffect, useRef, useSyncExternalStore } from 'react';
import { motion } from 'motion/react';
import type { ProviderId } from '@shared/protocol';
import { Backdrop } from '@/art/Backdrop';
import type { DitherPalette } from '@/art/DitherField';
import { LogoMark } from '@/art/Logo';
import { Composer } from '@/features/composer/Composer';
import { ConnectBanner } from '@/features/connect/Connect';
import { dissolve } from '@/lib/dissolve';
import { usePrewarm } from '@/state/hooks';
import { handoffPhase, subscribeHandoff } from './handoff';
import './home.css';

export const PROVIDER_PALETTE: Record<ProviderId, DitherPalette> = { claude: 'ember', codex: 'iris', demo: 'forest' };

// Opacity and a short rise only: a filter here would stop the composer's glass from blurring
// what is behind it, and dropping it at the end makes the glass pop in.
const rise = (i: number) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, delay: 0.05 * i, ease: [0.16, 1, 0.3, 1] as const },
});

/** The empty stage: the mark, one question, one composer, light across the whole stage. */
export function Home() {
  const leaving = useSyncExternalStore(subscribeHandoff, handoffPhase, handoffPhase) === 'flying';
  const mark = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  usePrewarm('.home-composer');

  // Sending the first message: the headline and mark break up and drift upward as the composer leaves.
  useEffect(() => {
    if (!leaving) return;
    dissolve(mark.current);
    dissolve(title.current);
  }, [leaving]);

  return (
    <div className="home" data-leaving={leaving || undefined}>
      <Backdrop surface="home" />
      <div className="home-veil" />
      <div className="home-col scroll">
        <div className="home-center">
          <motion.div {...rise(0)}>
            <div ref={mark} className="home-mark">
              <LogoMark size={36} />
            </div>
          </motion.div>
          <motion.h1 className="display home-title" {...rise(1)}>
            <span ref={title} className="home-title-in">
              What are we building?
            </span>
          </motion.h1>
          <motion.div className="home-composer" {...rise(2)}>
            <Composer sessionId={null} variant="home" autoFocus />
          </motion.div>
          <ConnectBanner />
        </div>
      </div>
    </div>
  );
}
