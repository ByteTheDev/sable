import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { NoticeItem, UntilEnd, UntilState } from '@shared/protocol';
import { fieldBeat } from '@/art/events';
import { shortDuration, useTick } from '@/features/timeline/util';
import { useStore } from '@/state/store';
import { checkUntilNow, stopUntil } from './until';
import './until.css';

const rise = {
  initial: { opacity: 0, y: 10, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 4, transition: { duration: 0.14, ease: [0.5, 0, 0.9, 0.4] as const } },
  transition: { type: 'spring' as const, stiffness: 460, damping: 36 },
};

/** How long the strip stays with its end line before it leaves (ms). */
const HOLD_GREEN = 1900;
const HOLD_END = 1300;

type ArcState = 'ahead' | 'failed' | 'now' | 'pass';

/**
 * One arc per round around the strip's mark: checked rounds sit dim, the round in progress brighter,
 * those ahead a faint track. When the check passes every arc comes in solid ivory, one after
 * another, and the ring turns into rest.
 */
function Rounds({ rounds, round, green }: { rounds: number; round: number; green: boolean }) {
  const c = 9;
  const r = 7;
  const state = (i: number): ArcState => (green ? 'pass' : i < round - 1 ? 'failed' : i === round - 1 ? 'now' : 'ahead');
  const arcs =
    rounds <= 1
      ? [<circle key={0} cx={c} cy={c} r={r} data-s={state(0)} />]
      : Array.from({ length: rounds }, (_, i) => {
          const gap = Math.min(30, 150 / rounds);
          const a0 = ((-90 + (i * 360) / rounds + gap / 2) * Math.PI) / 180;
          const a1 = ((-90 + ((i + 1) * 360) / rounds - gap / 2) * Math.PI) / 180;
          const p = (a: number) => `${(c + r * Math.cos(a)).toFixed(3)} ${(c + r * Math.sin(a)).toFixed(3)}`;
          return <path key={i} d={`M ${p(a0)} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}`} data-s={state(i)} style={green ? { transitionDelay: `${i * 45}ms` } : undefined} />;
        });
  return (
    <motion.svg className="us-ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden animate={{ rotate: green ? 30 : 0 }} transition={{ type: 'spring', stiffness: 420, damping: 34, delay: green ? 0.12 : 0 }}>
      {arcs}
    </motion.svg>
  );
}

/** How long the check has run, once it is past two seconds (most are done by then). */
function CheckClock({ since }: { since: number }) {
  const now = useTick();
  return now - since >= 2000 ? <> · {shortDuration(now - since)}</> : null;
}

/** The loop's end notice, when it is the newest of the session's few last items (just added). */
function endNotice(sessionId: string): NoticeItem | undefined {
  const d = useStore.getState().data[sessionId];
  if (!d) return undefined;
  for (let i = d.roots.length - 1; i >= Math.max(0, d.roots.length - 4); i--) {
    const it = d.items[d.roots[i]];
    if (it?.type === 'notice' && it.until?.end) return Date.now() - it.ts < 5000 ? it : undefined;
  }
  return undefined;
}

/**
 * Until green, above the composer: "Until pnpm test passes · round 2 of 5 · 3 failing", with Stop
 * (and Check now while the loop is paused after a stopped or failed turn). When the loop ends it
 * shows its end line for a moment and leaves; a green end lights the ring and answers in the field.
 */
export const UntilStrip = memo(function UntilStrip({ sessionId }: { sessionId: string }) {
  const until = useStore((s) => s.sessions[sessionId]?.until ?? null);
  const [ended, setEnded] = useState<{ state: UntilState; end: UntilEnd; text: string } | null>(null);
  const last = useRef<UntilState | null>(until);

  useEffect(() => {
    const before = last.current;
    last.current = until;
    if (until) {
      setEnded(null);
      return;
    }
    if (!before) return;
    const note = endNotice(sessionId);
    // Closed or replaced without a word: the strip just goes.
    if (!note?.until?.end) return;
    setEnded({ state: before, end: note.until.end, text: note.text });
    const t = window.setTimeout(() => setEnded(null), note.until.end === 'passed' ? HOLD_GREEN : HOLD_END);
    return () => window.clearTimeout(t);
  }, [until, sessionId]);

  const ring = useRef<HTMLDivElement>(null);
  const green = ended?.end === 'passed';
  useLayoutEffect(() => {
    if (green) fieldBeat('done', ring.current, 0.85);
  }, [green]);

  const shown = until ?? ended?.state ?? null;

  return (
    <AnimatePresence initial={false}>
      {shown && (
        <motion.div key="until" className="us-slot" {...rise}>
          <section className="us" data-spot data-phase={ended ? 'ended' : shown.phase} data-green={green || undefined} aria-live="polite">
            <div className="us-mark" ref={ring}>
              <Rounds rounds={shown.rounds} round={ended?.end === 'passed' ? shown.rounds : shown.round} green={green} />
            </div>
            {ended ? (
              <span key="end" className="us-label us-end truncate">
                {ended.text}
              </span>
            ) : shown.phase === 'checking' ? (
              <span key="checking" className="us-label truncate">
                <span className="shimmer">Checking</span> <span className="us-cmd">{shown.check}</span>
              </span>
            ) : (
              <span key="until" className="us-label truncate">
                Until <span className="us-cmd">{shown.check}</span> passes
              </span>
            )}
            {!ended && (
              <span className="us-meta num">
                Round {shown.round} of {shown.rounds}
                {shown.failing ? ` · ${shown.failing} failing` : ''}
                {shown.phase === 'checking' && shown.since && !ended ? <CheckClock since={shown.since} /> : null}
                {shown.phase === 'paused' ? ' · paused' : ''}
              </span>
            )}
            {!ended && (
              <span className="us-actions">
                {shown.phase === 'paused' && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void checkUntilNow(sessionId)}>
                    Check now
                  </button>
                )}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void stopUntil(sessionId)} aria-label={`Stop until ${shown.check} passes`}>
                  Stop
                </button>
              </span>
            )}
          </section>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
