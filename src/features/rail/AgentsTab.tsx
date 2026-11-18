import { memo, useMemo } from 'react';
import { motion } from 'motion/react';
import type { ToolItem } from '@shared/protocol';
import { AgentBlock } from '@/features/timeline/Agent';
import { agentTask, isAgentLive as isLive } from '@/features/timeline/agent-line';
import { TimelineCtx, type TimelineCtxValue } from '@/features/timeline/ctx';
import { revealItem } from '@/features/timeline/reveal';
import { reducedMotion } from '@/lib/motion';
import { useStore } from '@/state/store';
import { IconButton } from '@/ui';
import { useToolIds } from './util';

const isAgent = (it: ToolItem) => it.kind === 'agent';

/** One character per agent, `1` while it works: the order and the tab's count follow it, nothing else re-renders. */
function useLiveKey(sessionId: string, ids: string[]): string {
  return useStore((s) => {
    const items = s.data[sessionId]?.items;
    let key = '';
    for (const id of ids) key += isLive(items?.[id] as ToolItem | undefined) ? '1' : '0';
    return key;
  });
}

/** How many sub-agents are working now: the figure beside the tab's icon. */
export function useLiveAgentCount(sessionId: string): number {
  const ids = useToolIds(sessionId, isAgent);
  const key = useLiveKey(sessionId, ids);
  let n = 0;
  for (const c of key) if (c === '1') n++;
  return n;
}

/** The blocks are the conversation's own: they read the session through the same context. Rows here always animate in. */
const ON = { current: true };

/** Every sub-agent of the session, as the conversation shows it, with more room: working ones first, then the newest. */
export function AgentsTab({ sessionId }: { sessionId: string }) {
  const ids = useToolIds(sessionId, isAgent);
  const cwd = useStore((s) => s.sessions[sessionId]?.cwd ?? '');
  const home = useStore((s) => s.home);
  const ctx = useMemo<TimelineCtxValue>(() => ({ sessionId, cwd, home, live: ON, stuck: ON }), [sessionId, cwd, home]);
  const liveKey = useLiveKey(sessionId, ids);
  const order = useMemo(() => {
    const live: string[] = [];
    const done: string[] = [];
    for (let i = ids.length - 1; i >= 0; i--) (liveKey[i] === '1' ? live : done).push(ids[i]);
    return { ids: [...live, ...done], live: live.length };
  }, [ids, liveKey]);

  if (!ids.length) {
    return (
      <div className="rail-scroll scroll">
        <p className="rail-empty">No sub-agents in this session yet.</p>
      </div>
    );
  }

  return (
    <div className="rail-col">
      <div className="rail-bar">
        <span className="rail-bar-title">Sub-agents</span>
        <span className="rail-bar-meta num">{order.live > 0 ? `${order.live} of ${ids.length} working` : ids.length}</span>
      </div>
      <div className="rail-scroll scroll">
        <TimelineCtx.Provider value={ctx}>
          <ul className="agc-list">
            {order.ids.map((id, i) => (
              <AgentCard key={id} sessionId={sessionId} id={id} index={i} />
            ))}
          </ul>
        </TimelineCtx.Provider>
      </div>
    </div>
  );
}

/** How many of its latest steps a working agent shows here: one more than the conversation, there is room. */
const TAIL = 4;

const AgentCard = memo(function AgentCard({ sessionId, id, index }: { sessionId: string; id: string; index: number }) {
  const item = useStore((s) => s.data[sessionId]?.items[id]) as ToolItem | undefined;
  const reveal = useMemo(
    () => <IconButton icon="chat" size={14} className="icon-btn-xs agc-reveal" label="Show in conversation" tipSide="left" onClick={() => revealItem(sessionId, id)} />,
    [sessionId, id],
  );
  if (!item) return null;
  return (
    <motion.li
      className="agc"
      data-spot=""
      data-status={item.status}
      data-live={isLive(item) || undefined}
      aria-label={agentTask(item)}
      layout={reducedMotion() ? false : 'position'}
      transition={{ type: 'spring', stiffness: 460, damping: 38 }}
      style={{ animationDelay: `${Math.min(index, 6) * 36}ms` }}
    >
      <AgentBlock item={item} tail={TAIL} scope="agent-rail" extra={reveal} />
    </motion.li>
  );
});
