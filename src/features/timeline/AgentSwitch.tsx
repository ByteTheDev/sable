import { memo, useState } from 'react';
import type { NoticeItem } from '@shared/protocol';
import { ProviderMark } from '@/art/Logo';
import { switchAgent } from '@/state/actions';
import { useStore } from '@/state/store';
import { useTimeline } from './ctx';
import './agent-switch.css';

/**
 * Where the chat switched agents (`session.switchAgent`): one quiet line with the new agent's mark.
 * The latest switch offers to switch back, between turns: right after the switch that undoes it,
 * later the agent before resumes its own conversation and hears what happened since.
 */
export const AgentSwitchLine = memo(function AgentSwitchLine({ item }: { item: NoticeItem }) {
  const mark = item.agentSwitch!;
  const { sessionId } = useTimeline();
  const busy = useStore((s) => {
    const st = s.sessions[sessionId]?.status;
    return st === 'running' || st === 'starting' || st === 'awaiting';
  });
  const [going, setGoing] = useState(false);
  const offer = !mark.past;
  const off = busy || going;
  const back = () => {
    if (off) return;
    setGoing(true);
    void switchAgent(sessionId, mark.from, undefined, true).finally(() => setGoing(false));
  };
  return (
    <div className="notice as-line" data-variant="switch">
      <div className="notice-line">
        <span className="notice-rule" />
        <span className="notice-label">
          <ProviderMark provider={mark.to} size={13} className="as-mark" />
          <span className="truncate">{item.text}</span>
        </span>
        {offer && (
          <button type="button" className="as-back" aria-disabled={off || undefined} onClick={back}>
            Switch back
          </button>
        )}
        <span className="notice-rule" />
      </div>
    </div>
  );
});
