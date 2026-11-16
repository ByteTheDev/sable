import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { ProviderId } from '@shared/protocol';
import { loadSessionView } from '@/app/views';
import { Backdrop } from '@/art/Backdrop';
import type { DitherPalette } from '@/art/DitherField';
import { buildMark, LogoMark, markEcho } from '@/art/Logo';
import { Composer } from '@/features/composer/Composer';
import { ConnectBanner } from '@/features/connect/Connect';
import { dissolve } from '@/lib/dissolve';
import { EASE_OUT, play, reducedMotion, spring, uiZoom } from '@/lib/motion';
import { usePrewarm } from '@/state/hooks';
import { useStore } from '@/state/store';
import { handoffPhase, subscribeHandoff } from './handoff';
import './home.css';

export const PROVIDER_PALETTE: Record<ProviderId, DitherPalette> = { claude: 'ember', codex: 'iris', demo: 'forest' };

/** The headline and composer rise in after the mark: a short rise and fade, opacity and transform only. */
function rise(el: Element | null, delay: number) {
  play(el, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0px)' }], { duration: 520, delay, easing: EASE_OUT, fill: 'backwards' });
}

/**
 * The arrival, one composed movement each time the home screen appears:
 * - straight after the launch intro, the intro's mark itself glides and shrinks into the home mark
 *   (the intro hides its own copy in the same frame), then the headline and the composer rise;
 * - otherwise (a fast start, or coming back from a session) the mark builds in dither order, as
 *   the intro's does, and the headline and composer rise behind it.
 * Under reduced motion everything is simply there.
 */
function useArrival(mark: RefObject<HTMLDivElement | null>, title: RefObject<HTMLElement | null>, composer: RefObject<HTMLDivElement | null>) {
  // Once per mount (a development double run would measure its own first frame and cancel the glide).
  const ran = useRef(false);
  useLayoutEffect(() => {
    if (ran.current || reducedMotion()) return;
    ran.current = true;
    const m = mark.current;
    const intro = document.querySelector<HTMLElement>('.logo-intro .logo-mark');
    const from = intro?.getBoundingClientRect();
    const to = m?.getBoundingClientRect();
    if (m && intro && from && to && from.width && to.width) {
      intro.style.visibility = 'hidden';
      const z = uiZoom();
      const dx = (from.left + from.width / 2 - (to.left + to.width / 2)) / z;
      const dy = (from.top + from.height / 2 - (to.top + to.height / 2)) / z;
      const k = from.width / to.width;
      const s = spring(300, 32);
      play(m, [{ transform: `translate(${dx}px, ${dy}px) scale(${k})` }, { transform: 'translate(0px, 0px) scale(1)' }], { duration: s.duration, easing: s.easing });
      rise(title.current, 150);
      rise(composer.current, 230);
      return;
    }
    buildMark(m, 40);
    rise(title.current, 110);
    rise(composer.current, 190);
  }, [mark, title, composer]);
}

/** The empty stage: the mark, one question, one composer, light across the whole stage. */
export function Home() {
  // Latched: once the first message has left, the home screen stays emptied while it fades out
  // (the flight lands before the view has gone, and its headline must not come back meanwhile).
  const flying = useSyncExternalStore(subscribeHandoff, handoffPhase, handoffPhase) === 'flying';
  const [left, setLeft] = useState(false);
  // A send that started no session (cancelled flight) brings the home screen back.
  const opened = useStore((s) => s.ui.activeSessionId != null);
  if (flying && !left) setLeft(true);
  else if (!flying && left && !opened) setLeft(false);
  const leaving = flying || left;
  const mark = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  usePrewarm('.home-composer');
  useArrival(mark, title, composer);

  // Sending the first message: the headline and mark break up and drift upward as the composer leaves.
  useEffect(() => {
    if (!leaving) return;
    dissolve(mark.current);
    dissolve(title.current);
  }, [leaving]);

  // The mark listens: each keystroke in the composer glints one of its missing corner cells.
  useEffect(() => {
    const host = composer.current;
    if (!host) return;
    const onInput = (e: Event) => {
      if ((e.target as HTMLElement).tagName !== 'TEXTAREA') return;
      markEcho(mark.current);
      // A send is coming: the session view must be loaded before it asks for it.
      void loadSessionView().catch(() => {});
    };
    host.addEventListener('input', onInput);
    return () => host.removeEventListener('input', onInput);
  }, []);

  return (
    <div className="home" data-leaving={leaving || undefined}>
      <Backdrop surface="home" />
      <div className="home-veil" />
      <div className="home-col scroll">
        <div className="home-center">
          <div ref={mark} className="home-mark">
            <LogoMark size={36} cells />
          </div>
          <h1 className="display home-title">
            <span ref={title} className="home-title-in">
              What are we building?
            </span>
          </h1>
          <div ref={composer} className="home-composer">
            <Composer sessionId={null} variant="home" autoFocus />
          </div>
          <ConnectBanner />
        </div>
      </div>
    </div>
  );
}
