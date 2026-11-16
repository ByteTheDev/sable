import { memo, useState, type ReactNode } from 'react';
import type { TimelineItem, ToolItem } from '@shared/protocol';
import { Collapse } from '@/components/Collapse';
import { Markdown } from '@/components/Markdown';
import { Icon, TOOL_ICON } from '@/icons';
import { formatDuration, plural, relPath } from '@/lib/format';
import { useNow } from '@/lib/view-hooks';
import { useStore } from '@/state/store';
import { PathLabel } from '@/ui';
import { EMPTY, useTimeline } from './ctx';
import { ItemList } from './items';
import { ToolDetails, hasDetails } from './ToolDetails';
import { isActive, partialJsonString, shortDuration } from './util';

/** Live seconds for a running call. Hidden for the first two seconds: most calls are done by then. */
export function Elapsed({ since }: { since: number }) {
  const now = useNow(true);
  const ms = now - since;
  if (ms < 2000) return null;
  return <span className="num">{shortDuration(ms)}</span>;
}

/** A finished call's own running time: time it spent waiting for the user (approvals) does not count. */
export const ownMs = (item: ToolItem): number => (item.endedAt ? Math.max(0, item.endedAt - item.ts - (item.waitedMs ?? 0)) : 0);

function duration(item: ToolItem, min = 1000): string | null {
  if (!item.endedAt) return null;
  const ms = ownMs(item);
  return ms >= min ? formatDuration(ms) : null;
}

/** The result at the right edge of a row, in tabular figures. Only the two marks carry colour. */
function ToolMeta({ item }: { item: ToolItem }) {
  const s = item.status;
  // Said once, in amber, by the turn's live line; the row only names what it waits for.
  if (s === 'awaiting') return <span>{item.kind === 'question' ? 'Waiting for your answer' : 'Needs your approval'}</span>;
  if (s === 'pending' || s === 'running') return <Elapsed since={item.ts} />;
  if (s === 'denied') return <span>Denied</span>;
  if (s === 'cancelled') return item.result?.interrupted ? <span>Interrupted</span> : <span>Cancelled</span>;
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
      if (r?.exitCode) parts.push(<span className="tool-fail">exit {r.exitCode}</span>);
      break;
  }
  if (s === 'error' && item.kind !== 'bash') parts.unshift(<span className="tool-fail">Failed</span>);
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

/**
 * What the row says: the verb, then its target. A file is a path in the interface face (folder dim,
 * name regular); a command or a folder follows as a quieter phrase.
 */
function rowText(item: ToolItem, cwd: string, home: string): { verb: string; path?: string; sub?: string } {
  const d = item.detail;
  switch (item.kind) {
    case 'read':
    case 'edit':
    case 'write': {
      if (!d.path) return { verb: item.title };
      const rel = relPath(d.path, cwd, home);
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      const verb = item.title.endsWith(base) ? item.title.slice(0, -base.length).trim() : '';
      return verb ? { verb, path: rel } : { verb: item.title };
    }
    case 'bash': {
      if (!d.command) return { verb: item.title };
      const text = d.command.split('\n')[0];
      const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
      // Codex titles a command with the command itself: say it once.
      return norm(text) && norm(text) !== norm(item.title) ? { verb: item.title, sub: text } : { verb: item.title };
    }
    case 'search': {
      const where = d.glob ?? (d.path ? relPath(d.path, cwd, home) : '');
      return { verb: item.title, sub: where && where !== '.' ? `in ${where}` : undefined };
    }
    // The task strip over the composer carries the live task; the trail only records the list's count.
    case 'todo':
      return { verb: 'Tasks' };
    case 'skill':
      return { verb: item.title, sub: d.description };
    case 'mcp':
      return { verb: item.title, sub: d.server && d.tool && !item.title.includes(d.tool) ? `${d.server} · ${d.tool}` : undefined };
    default:
      return { verb: item.title };
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
  return lines.length > 3 ? lines.slice(0, 3).join('\n') + '\n…' : text;
}

/** The last lines a running command printed, in a window of fixed height: the trail never jumps. */
function Peek({ text }: { text: string }) {
  const end = text.replace(/\s+$/, '');
  const lines = end.slice(Math.max(0, end.length - 600)).split('\n').slice(-3);
  return (
    <div className="peek" aria-hidden>
      <pre>{lines.join('\n')}</pre>
    </div>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  const { cwd, home } = useTimeline();
  const [choice, setChoice] = useState<boolean | null>(null);
  const expandable = hasDetails(item);
  const open = expandable && (choice ?? autoOpen(item));
  const active = isActive(item);
  const icon = TOOL_ICON[item.kind] ?? TOOL_ICON.other;
  const t = rowText(item, cwd, home);
  const error = errorText(item);
  const peek = item.kind === 'bash' && active && !open && !!item.output?.trim();

  return (
    <div className="tool" data-status={item.status} data-open={open || undefined}>
      <button type="button" className="row-btn tool-row" aria-expanded={expandable ? open : undefined} data-static={!expandable || undefined} tabIndex={expandable ? undefined : -1} onClick={() => expandable && setChoice(!open)}>
        <span className="tool-icon">
          <Icon name={icon.icon} size={14} />
        </span>
        <span className={active ? 'tool-title shimmer' : 'tool-title'}>{t.verb}</span>
        {t.path && <PathLabel path={t.path} className="tool-target truncate" />}
        {t.sub && <span className="tool-sub truncate">{t.sub}</span>}
        <span className="tool-meta">
          <ToolMeta item={item} />
        </span>
        {expandable && <Icon name="caret-right" size={10} className="row-caret" />}
      </button>
      {error && !open && <pre className="tool-error">{error}</pre>}
      <Collapse open={peek}>
        <Peek text={item.output ?? ''} />
      </Collapse>
      <Collapse open={open}>
        <div className="tool-details">
          <ToolDetails item={item} />
        </div>
      </Collapse>
    </div>
  );
}

// ───────────────────────────────── sub-agent ─────────────────────────────────

/** What a sub-agent is doing right now, and how many steps it has taken: `${steps}|${line}`. */
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

/** A sub-agent: one line with its own count, opening to its trail and its report. */
function AgentRow({ item }: { item: ToolItem }) {
  const { sessionId } = useTimeline();
  const [open, setOpen] = useState(false);
  const children = useStore((s) => s.data[sessionId]?.children[item.id]) ?? EMPTY;
  const summary = useStore(agentSummary(sessionId, item.id));
  const cut = summary.indexOf('|');
  const tools = Number(summary.slice(0, cut));
  const line = summary.slice(cut + 1);
  const active = isActive(item);
  const failed = item.status === 'error';
  const report = item.result?.text?.trim();
  // The report usually repeats the agent's last message; show it once.
  const lastText = useStore((s) => {
    const d = s.data[sessionId];
    const last = d?.items[children[children.length - 1]];
    return last?.type === 'text' ? last.text.trim() : '';
  });
  const showReport = !!report && report !== lastText;
  const title = item.detail.description || item.title;

  return (
    <div className="agent" data-status={item.status} data-open={open || undefined}>
      <button type="button" className="row-btn tool-row agent-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tool-icon">
          <Icon name="robot" size={14} />
        </span>
        <span className="tool-title truncate">{title}</span>
        {active ? <span className="tool-sub agent-now shimmer truncate">{item.status === 'awaiting' ? '' : line || 'Starting'}</span> : tools > 0 && <span className="tool-sub num">{plural(tools, 'step')}</span>}
        <span className="tool-meta">
          {item.status === 'awaiting' ? (
            <span>Needs your approval</span>
          ) : active ? (
            <>
              {tools > 0 && <span className="num">{plural(tools, 'step')}</span>}
              <Elapsed since={item.ts} />
            </>
          ) : failed ? (
            <span className="tool-fail">Failed</span>
          ) : item.status === 'denied' ? (
            <span>Denied</span>
          ) : item.status === 'cancelled' ? (
            <span>Interrupted</span>
          ) : item.endedAt ? (
            <span className="num">{shortDuration(ownMs(item))}</span>
          ) : null}
        </span>
        <Icon name="caret-right" size={10} className="row-caret" />
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
        <span className="tool-meta">{state && <span className={item.status === 'error' ? 'tool-fail' : undefined}>{state}</span>}</span>
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

/** Any tool call. Plans are cards; everything else, sub-agents included, is one compact row. */
export const ToolView = memo(function ToolView({ item }: { item: ToolItem }) {
  if (item.kind === 'agent') return <AgentRow item={item} />;
  if (item.kind === 'plan') return <PlanCard item={item} />;
  return <ToolRow item={item} />;
});
