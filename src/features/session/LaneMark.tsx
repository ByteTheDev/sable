import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionLane } from '@shared/protocol';
import { Icon } from '@/icons';
import { plural } from '@/lib/format';
import { reducedMotion, uiZoom } from '@/lib/motion';
import { useStore } from '@/state/store';
import { Tip } from '@/ui';
import { useLaneForecast, useLanes, useSessionLane } from './lane';
import './lane.css';

/**
 * The lane's glyph: the folder's branch (a trunk) and the lane (a short line off it with its
 * node). `data-phase` plays its one moment: `peel` draws the lane off the trunk once when it
 * appears, `merge` folds it back into the trunk when it lands. Transform and opacity only.
 */
export function LaneGlyph({ size = 13, phase }: { size?: number; phase?: 'peel' | 'merge' | 'leave' }) {
  return (
    <svg className="lane-glyph" data-phase={phase} viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <line className="lane-glyph-trunk" x1="4.5" y1="2.25" x2="4.5" y2="13.75" />
      <g className="lane-glyph-lane">
        <line x1="4.5" y1="11" x2="10.1" y2="5.4" />
        <circle cx="11.25" cy="4.25" r="1.6" />
      </g>
    </svg>
  );
}

const MERGE_MS = 520;
const SLIDE = { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };

/** The crumb after the mark glides to where it now sits, instead of jumping (transform only). */
function glide(el: Element | null | undefined, dx: number) {
  if (!el || Math.abs(dx) < 1 || reducedMotion()) return;
  el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], SLIDE);
}

/**
 * The session's lane in the header: its glyph, its branch and how far it is from the folder's
 * branch. Opens the Changes tab, where the lane lands. A lane that ends plays its last moment
 * (landed: the line folds back into the trunk) before the mark goes.
 */
export function LaneMark({ sessionId }: { sessionId: string }) {
  const lane = useSessionLane(sessionId);
  const ended = useLanes((s) => s.byId[sessionId]?.ended);
  const setUi = useStore((s) => s.setUi);
  const [shown, setShown] = useState<SessionLane | undefined>(lane);
  const [phase, setPhase] = useState<'peel' | 'merge' | 'leave' | undefined>(() => (lane && Date.now() - lane.createdAt < 8000 ? 'peel' : undefined));
  const prev = useRef(lane);
  const leaving = useRef(0);
  const btn = useRef<HTMLButtonElement>(null);
  /** The crumb after the mark and where it stood, while the mark goes. */
  const follower = useRef<{ el: Element; left: number } | null>(null);
  useEffect(() => () => window.clearTimeout(leaving.current), []);

  useEffect(() => {
    const was = prev.current;
    prev.current = lane;
    if (lane) {
      window.clearTimeout(leaving.current);
      setShown(lane);
      // A lane made while the chat is open draws itself once.
      if (!was || was.path !== lane.path) setPhase(Date.now() - lane.createdAt < 8000 ? 'peel' : undefined);
      return;
    }
    if (!was) return;
    // How it ended is set before the bridge answers (see landLane), so it is known here.
    setPhase(useLanes.getState().byId[sessionId]?.ended === 'landed' ? 'merge' : 'leave');
    leaving.current = window.setTimeout(() => {
      const sib = btn.current?.nextElementSibling;
      follower.current = sib ? { el: sib, left: sib.getBoundingClientRect().left } : null;
      setShown(undefined);
      setPhase(undefined);
    }, MERGE_MS);
  }, [lane, sessionId]);

  // The mark gone: what followed it closes the gap smoothly.
  useLayoutEffect(() => {
    const f = follower.current;
    follower.current = null;
    if (shown || !f) return;
    glide(f.el, (f.left - f.el.getBoundingClientRect().left) / uiZoom());
  }, [shown]);

  // The mark arriving: what follows makes room smoothly while the lane peels off.
  const peeling = phase === 'peel' ? shown?.path : undefined;
  useLayoutEffect(() => {
    const el = btn.current;
    if (!peeling || !el) return;
    glide(el.nextElementSibling, -(el.getBoundingClientRect().width / uiZoom() + 4));
  }, [peeling]);

  const entry = useLaneForecast(sessionId, lane?.path);
  if (!shown) return null;
  const f = entry?.forecast;
  const from = shown.from ?? 'its base';
  const tip = !lane
    ? ended === 'landed'
      ? `Landed on ${f?.target ?? from}`
      : 'Lane closed'
    : f?.state === 'conflicts'
      ? `Lane from ${from}, ${plural(f.conflicts.length, 'file')} ${f.conflicts.length === 1 ? 'conflicts' : 'conflict'} with ${f.target}`
      : f?.state === 'clean'
        ? `Lane from ${from}, lands cleanly on ${f.target}`
        : `Lane from ${from}`;
  return (
    <Tip label={tip}>
      <button
        ref={btn}
        type="button"
        className="lane-mark"
        data-phase={phase}
        data-tone={f?.state === 'conflicts' ? 'conflict' : undefined}
        aria-label={`${tip}. Show changes`}
        onClick={() => setUi({ railOpen: true, railTab: 'changes' })}
      >
        <LaneGlyph phase={phase} />
        <span className="truncate lane-mark-name">{shown.branch}</span>
        {lane && !!f?.ahead && (
          <span className="lane-ab num" aria-label={`${plural(f.ahead, 'commit')} ahead`}>
            <Icon name="arrow-up" size={10} />
            {f.ahead}
          </span>
        )}
        {lane && !!f?.behind && (
          <span className="lane-ab num" aria-label={`${plural(f.behind, 'commit')} behind`}>
            <Icon name="arrow-down" size={10} />
            {f.behind}
          </span>
        )}
      </button>
    </Tip>
  );
}
