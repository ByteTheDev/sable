import { memo, useMemo } from 'react';
import { motion } from 'motion/react';
import type { ToolItem, UserItem } from '@shared/protocol';
import { clock } from '@/features/usage/format';
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

/** How many sub-agents and workflows are working now: the figure beside the tab's icon. */
export function useLiveAgentCount(sessionId: string): number {
  const ids = useToolIds(sessionId, isAgent);
  const key = useLiveKey(sessionId, ids);
  let n = 0;
  for (const c of key) if (c === '1') n++;
  return n;
}

/** The blocks are the conversation's own: they read the session through the same context. Rows here always animate in. */
const ON = { current: true };

type Row = { kind: 'head'; key: string; label: string; time?: number; count?: number } | { kind: 'agent'; key: string; live: boolean };

/** The first line of a prompt, short enough for a heading. */
function promptLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 90 ? line.slice(0, 89) + '…' : line || 'Message';
}

/**
 * Every sub-agent and workflow of the session, as the conversation shows them, with more room.
 * What works now is on top (oldest first, each with its live time and what it does); what is done
 * follows, grouped under the message whose turn started it, newest turn first. One flat list, so a
 * block that finishes glides from the running group into its turn.
 */
export function AgentsTab({ sessionId }: { sessionId: string }) {
  const ids = useToolIds(sessionId, isAgent);
  const cwd = useStore((s) => s.sessions[sessionId]?.cwd ?? '');
  const home = useStore((s) => s.home);
  const roots = useStore((s) => s.data[sessionId]?.roots);
  const ctx = useMemo<TimelineCtxValue>(() => ({ sessionId, cwd, home, live: ON, stuck: ON }), [sessionId, cwd, home]);
  const liveKey = useLiveKey(sessionId, ids);

  const { rows, live, done } = useMemo(() => {
    const items = useStore.getState().data[sessionId]?.items ?? {};
    const users: UserItem[] = [];
    for (const id of roots ?? []) {
      const it = items[id];
      if (it?.type === 'user') users.push(it);
    }
    const running: string[] = [];
    const turns = new Map<string, { user?: UserItem; ids: string[] }>();
    ids.forEach((id, i) => {
      if (liveKey[i] === '1') return void running.push(id);
      const ts = items[id]?.ts ?? 0;
      let user: UserItem | undefined;
      for (const u of users) if (u.ts <= ts) user = u;
      const key = user?.id ?? '';
      const group = turns.get(key) ?? { user, ids: [] };
      group.ids.push(id);
      turns.set(key, group);
    });
    const out: Row[] = [];
    if (running.length) {
      out.push({ kind: 'head', key: 'h:running', label: 'Running now', count: running.length });
      for (const id of running) out.push({ kind: 'agent', key: id, live: true });
    }
    const groups = [...turns.values()].sort((a, b) => (b.user?.ts ?? 0) - (a.user?.ts ?? 0));
    for (const g of groups) {
      out.push({ kind: 'head', key: `h:${g.user?.id ?? 'start'}`, label: g.user ? promptLine(g.user.text) : 'Earlier', time: g.user?.ts });
      for (const id of g.ids) out.push({ kind: 'agent', key: id, live: false });
    }
    return { rows: out, live: running.length, done: ids.length - running.length };
  }, [ids, liveKey, roots, sessionId]);

  if (!ids.length) {
    return (
      <div className="rail-scroll scroll">
        <p className="rail-empty">No agents in this session yet.</p>
      </div>
    );
  }

  const motionOn = !reducedMotion();
  return (
    <div className="rail-col">
      <div className="rail-bar">
        <span className="rail-bar-title">Agents</span>
        <span className="rail-bar-meta num">{[live && `${live} running`, done && `${done} done`].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="rail-scroll scroll">
        <TimelineCtx.Provider value={ctx}>
          <ul className="agc-list">
            {rows.map((r, i) =>
              r.kind === 'head' ? (
                <motion.li key={r.key} className="agc-head" layout={motionOn ? 'position' : false} transition={SPRING} data-running={r.key === 'h:running' || undefined}>
                  <span className="agc-head-label truncate">{r.label}</span>
                  {r.count !== undefined ? <span className="agc-head-meta num">{r.count}</span> : r.time ? <span className="agc-head-meta num">{clock(r.time)}</span> : null}
                </motion.li>
              ) : (
                <AgentCard key={r.key} sessionId={sessionId} id={r.key} index={i} live={r.live} animate={motionOn} />
              ),
            )}
          </ul>
        </TimelineCtx.Provider>
      </div>
    </div>
  );
}

const SPRING = { type: 'spring', stiffness: 460, damping: 38 } as const;

/** How many of its latest steps a working agent shows here: one more than the conversation, there is room. */
const TAIL = 4;

const AgentCard = memo(function AgentCard({ sessionId, id, index, live, animate }: { sessionId: string; id: string; index: number; live: boolean; animate: boolean }) {
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
      data-live={live || undefined}
      data-workflow={item.workflow ? '' : undefined}
      aria-label={agentTask(item)}
      layout={animate ? 'position' : false}
      transition={SPRING}
      style={{ animationDelay: `${Math.min(index, 6) * 36}ms` }}
    >
      <AgentBlock item={item} tail={TAIL} scope="agent-rail" extra={reveal} />
    </motion.li>
  );
});
