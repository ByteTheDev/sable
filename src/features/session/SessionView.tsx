import { useEffect, useRef, useState } from 'react';
import { Backdrop } from '@/art/Backdrop';
import { Composer } from '@/features/composer/Composer';
import { PromptDock } from '@/features/prompts/PromptDock';
import { Timeline } from '@/features/timeline/Timeline';
import { useStore } from '@/state/store';
import './session.css';

/**
 * One conversation: the timeline scrolls underneath a floating dock (prompts +
 * composer). A low band of light behind the dock breathes with the agent:
 * a little brighter and faster while it works, amber while it waits on you.
 */
export function SessionView({ sessionId }: { sessionId: string }) {
  // Only what the light needs: usage ticks while streaming must not re-render the whole view.
  const provider = useStore((s) => s.sessions[sessionId]?.provider);
  const status = useStore((s) => s.sessions[sessionId]?.status);
  const root = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);

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

  // The timeline pads its end by the dock's height so nothing hides behind the glass.
  useEffect(() => {
    const el = dock.current;
    const host = root.current;
    if (!el || !host) return;
    const ro = new ResizeObserver(() => host.style.setProperty('--dock-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!provider || !status) return null;

  return (
    <div className="session" ref={root} data-status={status}>
      <div className="session-light" data-status={status}>
        {light && <Backdrop surface="session" provider={provider} status={status} />}
      </div>
      <Timeline sessionId={sessionId} />
      <div className="dock" ref={dock}>
        <div className="dock-inner">
          <PromptDock sessionId={sessionId} />
          <Composer sessionId={sessionId} variant="session" autoFocus />
        </div>
      </div>
    </div>
  );
}
