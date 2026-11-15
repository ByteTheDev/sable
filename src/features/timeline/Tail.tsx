import { memo } from 'react';
import { Tiles } from '@/art/Logo';
import { Icon } from '@/icons';
import { useNow } from '@/lib/view-hooks';
import { useStore, type SessionData } from '@/state/store';
import { Kbd } from '@/ui';
import { useTimeline } from './ctx';
import { shortDuration } from './util';

/** `${turnStart}|${quiet}`: when the running turn began, and whether its last item is streaming prose. */
function tailInfo(data: SessionData | undefined): string {
  if (!data || !data.roots.length) return '0|0';
  const last = data.items[data.roots[data.roots.length - 1]];
  const quiet = !!last && (last.type === 'text' || last.type === 'thinking') && last.streaming;
  // Walking back to the previous turn: the earliest sent message since then started this one.
  let user = 0;
  let first = 0;
  for (let i = data.roots.length - 1, n = 0; i >= 0 && n < 600; i--, n++) {
    const it = data.items[data.roots[i]];
    if (!it) continue;
    if (it.type === 'turn') break;
    if (it.type === 'user' && it.state !== 'queued') user = it.ts;
    first = it.ts;
  }
  return `${user || first}|${quiet ? 1 : 0}`;
}

/**
 * The line under the transcript while the agent works: what it is doing, for how long,
 * and how to stop it. It steps back while prose is streaming, since the words are the signal.
 */
export const Tail = memo(function Tail() {
  const { sessionId } = useTimeline();
  const status = useStore((s) => s.sessions[sessionId]?.status);
  const activity = useStore((s) => s.sessions[sessionId]?.activity);
  const info = useStore((s) => tailInfo(s.data[sessionId]));
  const working = status === 'running' || status === 'starting';
  const now = useNow(working);
  if (!working && status !== 'awaiting') return null;

  const [startRaw, quietRaw] = info.split('|');
  const start = Number(startRaw);
  const elapsed = start ? now - start : 0;

  if (status === 'awaiting') {
    return (
      <div className="tail" data-status="awaiting" role="status">
        <span className="row-slot tail-wait-icon">
          <Icon name="hourglass" size={15} />
        </span>
        <span className="tail-wait">Waiting for you</span>
      </div>
    );
  }

  return (
    <div className="tail" data-status={status} data-quiet={quietRaw === '1' || undefined} role="status" aria-live="off">
      <span className="row-slot">
        <Tiles size={14} />
      </span>
      <span className="tail-label shimmer truncate">{status === 'starting' ? 'Starting' : activity || 'Working'}</span>
      {elapsed >= 1000 && <span className="tail-time num">{shortDuration(elapsed)}</span>}
      <span className="tail-esc">
        <Kbd combo="esc" /> to stop
      </span>
    </div>
  );
});
