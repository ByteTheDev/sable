import { memo, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import type { ToolItem } from '@shared/protocol';
import { Collapse } from '@/components/Collapse';
import { Markdown } from '@/components/Markdown';
import { Icon, TOOL_ICON } from '@/icons';
import { formatDuration, plural } from '@/lib/format';
import { reducedMotion } from '@/lib/motion';
import { useNow } from '@/lib/view-hooks';
import { revealItem } from '@/features/timeline/reveal';
import { useStore } from '@/state/store';
import { useToolIds } from './util';

type State = ReturnType<typeof useStore.getState>;

const isAgent = (it: ToolItem) => it.kind === 'agent';
const isLive = (it: ToolItem | undefined) => !!it && (it.status === 'running' || it.status === 'pending' || it.status === 'awaiting');

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

/** Every sub-agent of the session as a live card: working ones first, then the newest. */
export function AgentsTab({ sessionId }: { sessionId: string }) {
  const ids = useToolIds(sessionId, isAgent);
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
        <ul className="agc-list">
          {order.ids.map((id, i) => (
            <AgentCard key={id} sessionId={sessionId} id={id} index={i} />
          ))}
        </ul>
      </div>
    </div>
  );
}

/** How many steps the card's trail shows while folded: the latest ones. */
const TAIL = 4;

/** `${steps}|${the last few step ids}|${what it does now}`: one string, so a card renders only when one of them changes. */
function trailOf(sessionId: string, id: string) {
  return (s: State): string => {
    const d = s.data[sessionId];
    const kids = d?.children[id];
    if (!d || !kids?.length) return '0||';
    const tools: string[] = [];
    let latest = '';
    for (const k of kids) {
      const it = d.items[k];
      if (!it) continue;
      if (it.type === 'tool') {
        tools.push(k);
        latest = it.title;
      } else if (it.type === 'thinking') latest = 'Thinking';
      else if (it.type === 'text') latest = 'Writing the report';
    }
    return `${tools.length}|${tools.slice(-TAIL).join(',')}|${latest}`;
  };
}

const NO_IDS: string[] = [];

const AgentCard = memo(function AgentCard({ sessionId, id, index }: { sessionId: string; id: string; index: number }) {
  const item = useStore((s) => s.data[sessionId]?.items[id]) as ToolItem | undefined;
  const [trailSel] = useState(() => trailOf(sessionId, id));
  const trail = useStore(trailSel);
  const [open, setOpen] = useState(false);
  const live = isLive(item);
  const now = useNow(live, 1000);
  // The last thing it wrote, when the tool result carries no report of its own.
  const lastText = useStore((s) => {
    if (live) return '';
    const d = s.data[sessionId];
    const kids = d?.children[id];
    const last = kids?.length ? d?.items[kids[kids.length - 1]] : undefined;
    return last?.type === 'text' ? last.text.trim() : '';
  });
  const allSteps = useStore((s) => (open ? s.data[sessionId]?.children[id] : undefined)) ?? NO_IDS;

  if (!item) return null;
  const a = trail.indexOf('|');
  const b = trail.indexOf('|', a + 1);
  const steps = Number(trail.slice(0, a));
  const tail = trail.slice(a + 1, b) ? trail.slice(a + 1, b).split(',') : NO_IDS;
  const doing = trail.slice(b + 1);
  const failed = item.status === 'error';
  const awaiting = item.status === 'awaiting';
  const report = item.result?.text?.trim() || lastText;
  // Its own running time: waiting for approvals does not count.
  const ms = (item.endedAt ?? (live ? now : item.ts)) - item.ts - (item.endedAt ? (item.waitedMs ?? 0) : 0);
  const state = awaiting
    ? 'Needs your approval'
    : live
      ? doing || 'Starting'
      : failed
        ? 'Failed'
        : item.status === 'denied'
          ? 'Denied'
          : item.status === 'cancelled'
            ? 'Interrupted'
            : 'Done';
  const title = item.detail.description || item.title;
  const shown = open ? allSteps : tail;
  const hidden = open ? 0 : steps - tail.length;
  const hasMore = steps > TAIL || !!report || !!item.detail.prompt;

  return (
    <motion.li
      className="agc"
      data-spot=""
      data-status={item.status}
      data-live={live || undefined}
      layout={reducedMotion() ? false : 'position'}
      transition={{ type: 'spring', stiffness: 460, damping: 38 }}
      style={{ animationDelay: `${Math.min(index, 6) * 36}ms` }}
    >
      <div className="agc-head">
        <button type="button" className="agc-go" onClick={() => revealItem(sessionId, id)} aria-label={`${title}. Show in conversation`}>
          <span className="agc-mark" aria-hidden>
            <Icon name="robot" size={15} />
          </span>
          <span className="agc-titles">
            <span className="agc-title truncate">{title}</span>
            <span className="agc-state truncate" data-tone={failed ? 'error' : awaiting ? 'waiting' : undefined}>
              {live && !awaiting ? <span className="shimmer">{state}</span> : state}
            </span>
          </span>
          <span className="agc-meta num">
            {ms >= 1000 && <span>{formatDuration(ms)}</span>}
            {steps > 0 && <span>{plural(steps, 'step')}</span>}
          </span>
        </button>
        {hasMore && (
          <button type="button" className="agc-fold" aria-expanded={open} aria-label={open ? 'Fold details' : 'Show details'} onClick={() => setOpen((o) => !o)}>
            <Icon name="caret-right" size={10} className="ch-caret" />
          </button>
        )}
      </div>

      <Collapse open={open && !!item.detail.prompt}>
        <p className="agc-prompt">{item.detail.prompt}</p>
      </Collapse>

      {(live || open) && shown.length > 0 && (
        <ol className="agc-trail" aria-label="Steps">
          {hidden > 0 && <li className="agc-earlier num">{plural(hidden, 'earlier step')}</li>}
          {shown.map((sid) => (
            <Step key={sid} sessionId={sessionId} id={sid} />
          ))}
        </ol>
      )}

      {!live && report && (
        <div className="agc-report" data-open={open || undefined}>
          {open ? <Markdown text={report} /> : <p className="agc-excerpt">{excerpt(report)}</p>}
        </div>
      )}
    </motion.li>
  );
});

/** The report's first lines as plain text, for the folded card. */
function excerpt(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/[*`]|^s*[>-]s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
}

const Step = memo(function Step({ sessionId, id }: { sessionId: string; id: string }) {
  const item = useStore((s) => s.data[sessionId]?.items[id]);
  if (!item || item.type !== 'tool') return null;
  const running = item.status === 'running' || item.status === 'pending';
  return (
    <li className="agc-step" data-status={item.status}>
      <Icon name={TOOL_ICON[item.kind]?.icon ?? 'robot'} size={13} />
      <span className={running ? 'truncate shimmer' : 'truncate'}>{item.title}</span>
    </li>
  );
});
