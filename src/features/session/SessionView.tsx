import { useEffect, useRef, useState } from 'react';
import { Backdrop } from '@/art/Backdrop';
import { Composer } from '@/features/composer/Composer';
import { PromptDock } from '@/features/prompts/PromptDock';
import { Timeline } from '@/features/timeline/Timeline';
import { useStore } from '@/state/store';
import './session.css';

/**
 * One conversation: the timeline, with a low band of light under it that breathes with the agent
 * (a little brighter and faster while it works, amber while it waits on you). The dock (prompts and
 * composer) floats over it but is not part of it: it lives one level up (`SessionDock`), so moving
 * between sessions dissolves the conversation while the composer stays where it is.
 */
export function SessionView({ sessionId }: { sessionId: string }) {
  // Only what the light needs: usage ticks while streaming must not re-render the whole view.
  const provider = useStore((s) => s.sessions[sessionId]?.provider);
  const status = useStore((s) => s.sessions[sessionId]?.status);

  // The band of light is not needed for the first paint: it starts in idle time and fades in.
  const [light, setLight] = useState(false);
  useEffect(() => {
    if (typeof requestIdleCallback !== 'function') {
      const t = window.setTimeout(() => setLight(true), 120);
      return () => window.clearTimeout(t);
    }
    const id = requestIdleCallback(() => setLight(true), { timeout: 700 });
    return () => cancelIdleCallback(id);
  }, []);

  if (!provider || !status) return null;

  return (
    <div className="session" data-status={status}>
      <div className="session-light" data-status={status}>
        {light && <Backdrop surface="session" provider={provider} status={status} />}
      </div>
      <Timeline sessionId={sessionId} />
    </div>
  );
}

/**
 * What waits above the conversation's end: the prompt cards and the composer. One instance for
 * every session (App keeps it mounted across switches); its contents follow the session.
 */
export function SessionDock({ sessionId }: { sessionId: string }) {
  const dock = useRef<HTMLDivElement>(null);
  const exists = useStore((s) => !!s.sessions[sessionId]);

  // The timeline pads its end by the dock's height so nothing hides behind the glass. Set on the
  // stage body, which holds both the conversation and the dock.
  useEffect(() => {
    const el = dock.current;
    const host = el?.closest<HTMLElement>('.stage-body');
    if (!el || !host) return;
    const ro = new ResizeObserver(() => host.style.setProperty('--dock-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, [exists]);

  if (!exists) return null;
  return (
    <div className="dock" ref={dock}>
      <div className="dock-inner">
        <PromptDock key={`p:${sessionId}`} sessionId={sessionId} />
        <Composer key={sessionId} sessionId={sessionId} variant="session" autoFocus />
      </div>
    </div>
  );
}
