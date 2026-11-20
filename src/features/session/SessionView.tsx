import { useEffect, useRef, useState } from 'react';
import { Backdrop } from '@/art/Backdrop';
import { Composer } from '@/features/composer/Composer';
import { PromptDock } from '@/features/prompts/PromptDock';
import { Timeline } from '@/features/timeline/Timeline';
import { afterSend } from '@/features/composer/settle';
import { useStore } from '@/state/store';
import { ConversationFind } from './FindBar';
import './session.css';

/**
 * One conversation: the timeline. The band of light under it lives one level up (`SessionLight`),
 * like the dock (`SessionDock`): moving between sessions dissolves the conversation while the
 * light and the composer stay where they are.
 */
export function SessionView({ sessionId }: { sessionId: string }) {
  // Only what the view needs: usage ticks while streaming must not re-render the whole view.
  const status = useStore((s) => s.sessions[sessionId]?.status);
  if (!status) return null;
  return (
    <div className="session" data-status={status}>
      <Timeline sessionId={sessionId} />
      <ConversationFind sessionId={sessionId} />
    </div>
  );
}

/**
 * A low band of light under the conversation that breathes with the agent (a little brighter and
 * faster while it works, amber while it waits on you). One instance for every session (App keeps
 * it mounted across switches): a switch changes its colour and pace, the field is never rebuilt.
 */
export function SessionLight({ sessionId }: { sessionId: string }) {
  const provider = useStore((s) => s.sessions[sessionId]?.provider);
  const status = useStore((s) => s.sessions[sessionId]?.status);

  // The band is not needed for the first paint: it starts in idle time and fades in, and after a
  // sent message has landed (its field starting up is not part of the send's frames).
  const [light, setLight] = useState(false);
  useEffect(() => {
    let t = 0;
    let id = 0;
    const off = afterSend(() => {
      if (typeof requestIdleCallback !== 'function') t = window.setTimeout(() => setLight(true), 120);
      else id = requestIdleCallback(() => setLight(true), { timeout: 180 });
    });
    return () => {
      off();
      window.clearTimeout(t);
      if (id) cancelIdleCallback(id);
    };
  }, []);

  if (!provider || !status) return null;
  return <div className="session-light" data-status={status}>{light && <Backdrop surface="session" provider={provider} status={status} />}</div>;
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
