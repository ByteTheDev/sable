import { memo, useState, type ReactNode } from 'react';
import type { TimelineItem, ToolItem } from '@shared/protocol';
import { Collapse } from '@/components/Collapse';
import { Markdown } from '@/components/Markdown';
import { Icon, TOOL_ICON } from '@/icons';
import { dirName, formatDuration, plural, relPath } from '@/lib/format';
import { useNow } from '@/lib/view-hooks';
import { useStore } from '@/state/store';
import { EMPTY, useTimeline } from './ctx';
import { ItemList } from './items';
import { ToolDetails, hasDetails } from './ToolDetails';
import { isActive, partialJsonString, shortDuration } from './util';

/** Live seconds for a running call. Hidden for the first two seconds: most calls are done by then. */
function Elapsed({ since }: { since: number }) {
  const now = useNow(true);
  const ms = now - since;
  if (ms < 2000) return null;
  return <span className="num">{shortDuration(ms)}</span>;
}

function duration(item: ToolItem, min = 1000): string | null {
  if (!item.endedAt) return null;
  const ms = item.endedAt - item.ts;
  return ms >= min ? formatDuration(ms) : null;
}

/** The quiet facts on the right of a row. */
function ToolMeta({ item, open }: { item: ToolItem; open: boolean }) {
  const s = item.status;
  if (s === 'awaiting') return <span className="tool-await">{item.kind === 'question' ? 'Waiting for your answer' : 'Needs your approval'}</span>;
  if (s === 'pending' || s === 'running') return <Elapsed since={item.ts} />;
  if (s === 'denied') return <span>Denied</span>;
  if (s === 'cancelled') return <span>{item.result?.interrupted ? 'Interrupted' : 'Cancelled'}</span>;
  const r = item.result;
  const parts: ReactNode[] = [];
  switch (item.kind) {
    case 'edit':
    case 'write': {
      const add = r?.diff?.reduce((n, d) => n + d.additions, 0) ?? 0;
      const del = r?.diff?.reduce((n, d) => n + d.deletions, 0) ?? 0;
      if (add) parts.push(<span className="t-add">+{add}</span>);
      if (del) parts.push(<span className="t-del">−{del}</span>);
      break;
    }
    case 'read':
      if (r?.file?.numLines) parts.push(plural(r.file.numLines, 'line'));
      break;
    case 'search':
      if (r?.count != null) parts.push(r.count ? plural(r.count, 'match', 'matches') : 'No matches');
      break;
    case 'glob':
      if (r?.count != null) parts.push(r.count ? plural(r.count, 'file') : 'No files');
      break;
    case 'websearch':
      if (r?.links) parts.push(plural(r.links.length, 'result'));
      break;
    case 'todo': {
      const todos = item.detail.todos;
      if (todos?.length) parts.push(`${todos.filter((t) => t.status === 'completed').length} of ${todos.length}`);
      break;
    }
    case 'bash':
      // The open terminal shows its own exit badge.
      if (r?.exitCode && !open) parts.push(<span className="tool-exit">exit {r.exitCode}</span>);
      break;
  }
  const d = duration(item, item.kind === 'bash' ? 100 : 1000);
  if (d && item.kind !== 'todo' && item.kind !== 'question') parts.push(d);
  if (!parts.length) return null;
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className="num">
          {p}
        </span>
      ))}
    </>
  );
}

/** A second, quieter phrase after the title: the command, the folder, the task in progress. */
function subline(item: ToolItem, cwd: string, home: string): { text: string } | null {
  const d = item.detail;
  switch (item.kind) {
    case 'bash': {
      if (!d.command) return null;
      const text = d.command.split('\n')[0];
      const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
      // Codex titles a command with the command itself: say it once.
      return norm(text) && norm(text) !== norm(item.title) ? { text } : null;
    }
    case 'read':
    case 'edit':
    case 'write': {
      if (!d.path) return null;
      const dir = dirName(relPath(d.path, cwd, home));
      return dir && dir !== '.' ? { text: dir } : null;
    }
    case 'search': {
      const where = d.glob ?? (d.path ? relPath(d.path, cwd, home) : '');
      return where && where !== '.' ? { text: `in ${where}` } : null;
    }
    case 'todo': {
      const cur = d.todos?.find((t) => t.status === 'in_progress');
      return cur ? { text: cur.activeForm ?? cur.content } : null;
    }
    case 'skill':
      return d.description ? { text: d.description } : null;
    case 'mcp':
      return d.server && d.tool ? { text: `${d.server} · ${d.tool}` } : null;
    default:
      return null;
  }
}

/** Rows start folded; an answered question shows its answers, since that is the whole point of it. */
function autoOpen(item: ToolItem): boolean {
  return item.kind === 'question' && item.status === 'done';
}

/** First lines of what went wrong, shown under the row without opening it. */
function errorText(item: ToolItem): string | null {
  if (item.status !== 'error' || item.kind === 'bash') return null;
  const text = (item.result?.stderr || item.result?.text || '').trim();
  if (!text) return null;
  const lines = text.split('\n');
  return lines.length > 4 ? lines.slice(0, 4).join('\n') + '\n…' : text;
}

function ToolRow({ item }: { item: ToolItem }) {
  const { cwd, home } = useTimeline();
  // null = follow the tool's own state (a command opens while it runs, closes when it passes).
  const [choice, setChoice] = useState<boolean | null>(null);
  const expandable = hasDetails(item);
  const open = expandable && (choice ?? autoOpen(item));
  const active = isActive(item);
  const quiet = item.status === 'denied' || item.status === 'cancelled';
  const icon = TOOL_ICON[item.kind] ?? TOOL_ICON.other;
  const sub = subline(item, cwd, home);
  const error = errorText(item);

  return (
    <div className="tool" data-status={item.status} data-open={open || undefined}>
      <button type="button" className="row-btn tool-row" aria-expanded={expandable ? open : undefined} data-static={!expandable || undefined} onClick={() => expandable && setChoice(!open)}>
        <span className="tool-icon" data-quiet={quiet || undefined}>
          <Icon name={icon.icon} size={14} />
        </span>
        <span className={active ? 'tool-title truncate shimmer' : 'tool-title truncate'}>{item.title}</span>
        {sub && <span className="tool-sub truncate">{sub.text}</span>}
        <span className="tool-meta">
          <ToolMeta item={item} open={open} />
        </span>
        {expandable && <Icon name="caret-right" size={10} className="row-caret" />}
      </button>
      {error && !open && <pre className="tool-error">{error}</pre>}
      <Collapse open={open}>
        <div className="tool-details">
          <ToolDetails item={item} />
        </div>
      </Collapse>
    </div>
  );
}

// ───────────────────────────────── sub-agent ─────────────────────────────────

/** One line saying what a sub-agent is doing right now, and how many tools it has used. */
function agentSummary(sessionId: string, id: string) {
  return (s: ReturnType<typeof useStore.getState>): string => {
    const data = s.data[sessionId];
    const ids = data?.children[id];
    if (!data || !ids?.length) return '0|';
    let tools = 0;
    let latest: TimelineItem | undefined;
    for (const cid of ids) {
      const it = data.items[cid];
      if (!it) continue;
      if (it.type === 'tool') tools++;
      latest = it;
    }
    const line = !latest ? '' : latest.type === 'tool' ? latest.title : latest.type === 'thinking' ? 'Thinking' : latest.type === 'text' ? 'Writing the report' : '';
    return `${tools}|${line}`;
  };
}

function AgentCard({ item }: { item: ToolItem }) {
  const { sessionId } = useTimeline();
  const [open, setOpen] = useState(false);
  const children = useStore((s) => s.data[sessionId]?.children[item.id]) ?? EMPTY;
  const summary = useStore(agentSummary(sessionId, item.id));
  const cut = summary.indexOf('|');
  const tools = Number(summary.slice(0, cut));
  const line = summary.slice(cut + 1);
  const active = isActive(item);
  const failed = item.status === 'error';
  const quiet = item.status === 'denied' || item.status === 'cancelled';
  const report = item.result?.text?.trim();
  // The report usually repeats the agent's last message; show it once.
  const lastText = useStore((s) => {
    const d = s.data[sessionId];
    const last = d?.items[children[children.length - 1]];
    return last?.type === 'text' ? last.text.trim() : '';
  });
  const showReport = !!report && report !== lastText;

  return (
    <div className="agent" data-status={item.status} data-open={open || undefined} data-spot>
      <button type="button" className="agent-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="agent-icon">
          <Icon name="robot" size={16} />
        </span>
        <span className="agent-titles">
          <span className="agent-title">
            <span className="truncate">{item.detail.description || item.title}</span>
            {item.detail.subagent && <span className="badge">{item.detail.subagent}</span>}
          </span>
          <span className={active ? 'agent-line truncate shimmer' : 'agent-line truncate'}>
            {item.status === 'awaiting'
              ? 'Needs your approval'
              : active
                ? line || 'Starting'
                : failed
                  ? 'Failed'
                  : quiet
                    ? item.status === 'denied'
                      ? 'Denied'
                      : 'Cancelled'
                    : [tools ? plural(tools, 'tool call') : 'Finished', item.endedAt ? shortDuration(item.endedAt - item.ts) : null].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="tool-meta">{active && <Elapsed since={item.ts} />}</span>
        <Icon name="caret-right" size={11} className="row-caret" />
      </button>
      <Collapse open={open}>
        <div className="agent-body">
          {item.detail.prompt && <p className="agent-prompt">{item.detail.prompt}</p>}
          {children.length > 0 && (
            <div className="agent-thread">
              <ItemList ids={children} nested />
            </div>
          )}
          {showReport && (
            <div className="agent-report">
              <Markdown text={report} />
            </div>
          )}
          {failed && !report && item.result?.stderr && <pre className="tool-error">{item.result.stderr}</pre>}
        </div>
      </Collapse>
    </div>
  );
}

// ─────────────────────────────────── plan ───────────────────────────────────

function PlanCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(true);
  const typing = !item.detail.plan && item.input === undefined;
  const plan = item.detail.plan ?? partialJsonString(item.inputText, 'plan') ?? '';
  const state =
    item.status === 'awaiting'
      ? 'Needs your approval'
      : item.status === 'done'
        ? 'Approved'
        : item.status === 'denied'
          ? 'Kept planning'
          : item.status === 'cancelled'
            ? 'Cancelled'
            : item.status === 'error'
              ? 'Failed'
              : null;

  return (
    <div className="plan" data-status={item.status} data-spot>
      <button type="button" className="plan-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="agent-icon">
          <Icon name="compass" size={15} />
        </span>
        <span className={typing ? 'plan-title shimmer' : 'plan-title'}>{typing ? 'Writing the plan' : 'Plan'}</span>
        <span className="tool-meta">{state && <span className={item.status === 'awaiting' ? 'tool-await' : undefined}>{state}</span>}</span>
        <Icon name="caret-right" size={11} className="row-caret" />
      </button>
      <Collapse open={open && !!plan}>
        <div className="plan-body">
          <Markdown text={plan} streaming={typing} />
        </div>
      </Collapse>
    </div>
  );
}

/** Any tool call. Sub-agents and plans are cards; everything else is one compact row. */
export const ToolView = memo(function ToolView({ item }: { item: ToolItem }) {
  if (item.kind === 'agent') return <AgentCard item={item} />;
  if (item.kind === 'plan') return <PlanCard item={item} />;
  return <ToolRow item={item} />;
});
