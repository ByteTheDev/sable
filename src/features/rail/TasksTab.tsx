import { memo, useState, type CSSProperties } from 'react';
import type { Todo, ToolItem } from '@shared/protocol';
import { Ring } from '@/art/Logo';
import { Collapse } from '@/components/Collapse';
import { Glyph, Icon } from '@/icons';
import { formatDuration, plural } from '@/lib/format';
import { useNow } from '@/lib/view-hooks';
import { revealItem } from '@/features/timeline/reveal';
import { useStore } from '@/state/store';
import { useToolIds } from './util';

const NO_TODOS: Todo[] = [];

export function useOpenTaskCount(sessionId: string): number {
  return useStore((s) => (s.data[sessionId]?.todos ?? NO_TODOS).filter((t) => t.status !== 'completed').length);
}

export function TasksTab({ sessionId }: { sessionId: string }) {
  const todos = useStore((s) => s.data[sessionId]?.todos) ?? NO_TODOS;
  const agentIds = useToolIds(sessionId, (it) => it.kind === 'agent');
  const agents = [...agentIds].reverse();

  if (!todos.length && !agents.length) {
    return (
      <div className="rail-scroll scroll">
        <p className="rail-empty">No tasks or sub-agents in this session yet.</p>
      </div>
    );
  }

  const done = todos.filter((t) => t.status === 'completed').length;

  return (
    <div className="rail-col">
      <div className="rail-bar">
        {todos.length > 0 ? (
          <>
            <span className="rail-bar-title num">
              {done} of {todos.length} done
            </span>
            <span className="tk-progress meter" role="progressbar" aria-valuemin={0} aria-valuemax={todos.length} aria-valuenow={done} aria-label="Tasks done">
              <span className="meter-fill" style={{ '--p': done / todos.length } as CSSProperties} />
            </span>
          </>
        ) : (
          <>
            <span className="rail-bar-title">Sub-agents</span>
            <span className="rail-bar-meta num">{agents.length}</span>
          </>
        )}
      </div>
    <div className="rail-scroll scroll">
      <div className="rail-stack tk-stack">
        {todos.length > 0 && (
          <section className="tk-section" aria-label="Tasks">
            <ol className="tk-list">
              {todos.map((t, i) => (
                <li key={t.id ?? i} className="tk-item" data-status={t.status}>
                  <span className="tk-mark" aria-hidden>
                    {t.status === 'completed' ? <Icon name="check" size={10} /> : t.status === 'in_progress' ? <Ring size={10} /> : null}
                  </span>
                  <span className="tk-text">
                    {t.status === 'in_progress' ? <span className="shimmer">{t.activeForm || t.content}</span> : t.content}
                  </span>
                  <span className="sr-only">{t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'in progress' : 'pending'}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {agents.length > 0 && (
          <section className="tk-section" aria-label="Sub-agents">
            {todos.length > 0 && (
              <div className="rail-h">
                <span>Sub-agents</span>
                <span className="rail-h-meta num">{agents.length}</span>
              </div>
            )}
            <ul className="ag-list">
              {agents.map((id) => (
                <AgentRow key={id} sessionId={sessionId} id={id} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
    </div>
  );
}

function latestLine(sessionId: string, id: string) {
  return (s: ReturnType<typeof useStore.getState>): string => {
    const d = s.data[sessionId];
    const kids = d?.children[id];
    if (!d || !kids?.length) return '';
    const last = d.items[kids[kids.length - 1]];
    if (!last) return '';
    if (last.type === 'tool') return last.title;
    if (last.type === 'thinking') return 'Thinking';
    if (last.type === 'text') return 'Writing the report';
    return '';
  };
}

function toolCount(sessionId: string, id: string) {
  return (s: ReturnType<typeof useStore.getState>): number => {
    const d = s.data[sessionId];
    const kids = d?.children[id];
    if (!d || !kids) return 0;
    let n = 0;
    for (const k of kids) if (d.items[k]?.type === 'tool') n++;
    return n;
  };
}

const AgentRow = memo(function AgentRow({ sessionId, id }: { sessionId: string; id: string }) {
  const item = useStore((s) => s.data[sessionId]?.items[id]) as ToolItem | undefined;
  const [lineSel] = useState(() => latestLine(sessionId, id));
  const [countSel] = useState(() => toolCount(sessionId, id));
  const line = useStore(lineSel);
  const tools = useStore(countSel);
  const [open, setOpen] = useState(false);
  const live = !!item && (item.status === 'running' || item.status === 'pending' || item.status === 'awaiting');
  const now = useNow(live, 1000);

  if (!item) return null;
  const failed = item.status === 'error';
  const quiet = item.status === 'denied' || item.status === 'cancelled';
  const tone = failed ? 'var(--red)' : quiet ? 'var(--text-3)' : 'var(--text-2)';
  const status =
    item.status === 'awaiting'
      ? 'Needs your approval'
      : live
        ? line || 'Starting'
        : failed
          ? 'Failed'
          : item.status === 'denied'
            ? 'Denied'
            : item.status === 'cancelled'
              ? 'Cancelled'
              : tools
                ? `Finished after ${plural(tools, 'tool call')}`
                : 'Finished';
  // Its own running time: waiting for approvals does not count.
  const dur = (item.endedAt ?? (live ? now : item.ts)) - item.ts - (item.endedAt ? (item.waitedMs ?? 0) : 0);

  return (
    <li className="ag-item" data-open={open || undefined} data-status={item.status}>
      <button type="button" className="ag-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Glyph name="robot" tone={tone} size={26} />
        <span className="ag-titles">
          <span className="ag-title">
            <span className="truncate">{item.detail.description || item.title}</span>
          </span>
          <span className={live ? 'ag-line truncate shimmer' : 'ag-line truncate'}>{status}</span>
        </span>
        <span className="ag-meta">
          {item.detail.subagent && <span>{item.detail.subagent}</span>}
          {dur > 0 && <span className="num">{formatDuration(dur)}</span>}
        </span>
        <Icon name="caret-right" size={10} className="ch-caret" />
      </button>
      <Collapse open={open}>
        <div className="ag-body">
          {item.detail.prompt ? <p className="ag-prompt">{item.detail.prompt}</p> : <p className="ag-prompt faint">No prompt recorded.</p>}
          <button type="button" className="btn btn-sm" onClick={() => revealItem(sessionId, id)}>
            <Icon name="arrow-left" size={13} />
            Show in conversation
          </button>
        </div>
      </Collapse>
    </li>
  );
});
