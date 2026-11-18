import { Fragment, memo, useMemo, useState, type ReactNode } from 'react';
import type { ToolItem } from '@shared/protocol';
import { ProviderMark } from '@/art/Logo';
import { Collapse } from '@/components/Collapse';
import { Markdown } from '@/components/Markdown';
import { Icon } from '@/icons';
import { plural } from '@/lib/format';
import { useStore } from '@/state/store';
import { agentLine, agentProvider, agentTask, agentTrail, agentType, isAgentLive, readTrail } from './agent-line';
import { EMPTY, useItem, useTimeline } from './ctx';
import { foldKey, useFold } from './fold';
import { ItemList } from './items';
import { Elapsed, ToolView } from './Tool';

/** How many of its latest steps a working sub-agent shows under its line. */
const TAIL = 3;

type Store = ReturnType<typeof useStore.getState>;

/**
 * A sub-agent, in the conversation and in the Agents tab: one line with its kind and its task.
 * While it works its latest steps hang under it on a hairline; when it is done they gather into
 * one line (state, steps, tokens when the agent reported them, time). Opening it shows the task
 * it was given, every step and its report.
 */
/** `scope`: where it is shown, so the conversation and the Agents tab each remember what the reader opened. */
export const AgentBlock = memo(function AgentBlock({ item, tail = TAIL, extra, scope = 'agent' }: { item: ToolItem; tail?: number; extra?: ReactNode; scope?: string }) {
  const { sessionId } = useTimeline();
  const [open, setOpen] = useFold(foldKey(sessionId, item.id, scope), false);
  const live = isAgentLive(item);
  // One string: the block renders when a step arrives or what it does changes, never on a streamed word.
  const trail = useStore(useMemo(() => (s: Store) => agentTrail(s.data[sessionId]?.items, s.data[sessionId]?.children[item.id], tail), [sessionId, item.id, tail]));
  const { steps, ids, now } = readTrail(trail);
  const provider = agentProvider(item);
  const type = agentType(item);
  const task = agentTask(item);
  const awaiting = item.status === 'awaiting';
  const line = live ? null : agentLine(item, steps);
  const error = !open && item.status === 'error' ? firstLines(item.result?.stderr || item.result?.text) : '';
  const shown = ids.length + (now ? 1 : 0);

  return (
    <div className="agent" data-status={item.status} data-live={live || undefined} data-open={open || undefined}>
      <div className="agent-head">
        <button type="button" className="row-btn tool-row agent-row" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="tool-icon">{provider ? <ProviderMark provider={provider} size={13} /> : <Icon name="robot" size={14} />}</span>
          {type && (
            <>
              <span className="agent-type">{type}</span>
              <span className="agent-dot" aria-hidden>
                ·
              </span>
            </>
          )}
          <span className="agent-task truncate">{task}</span>
          <span className="tool-meta">
            {awaiting ? (
              <span>Needs your approval</span>
            ) : live ? (
              <>
                {steps > 0 && <span className="num">{plural(steps, 'step')}</span>}
                <Elapsed since={item.ts} />
              </>
            ) : null}
          </span>
          <Icon name="caret-right" size={10} className="row-caret" />
        </button>
        {extra}
      </div>
      <div className="agent-under">
        <Collapse open={!!line}>
          {line && (
            <div className="agent-line num">
              <span className={line.tone === 'error' ? 'tool-fail' : undefined}>{line.state}</span>
              {line.parts.map((p) => (
                <Fragment key={p}>
                  <span className="agent-dot" aria-hidden>
                    ·
                  </span>
                  <span>{p}</span>
                </Fragment>
              ))}
            </div>
          )}
          {error && <pre className="tool-error agent-error">{error}</pre>}
        </Collapse>
        <Collapse open={live && !open && shown > 0}>
          <div className="agent-trail" aria-label="Latest steps">
            {steps > ids.length && <div className="agent-more num">+{steps - ids.length} earlier</div>}
            {ids.map((id) => (
              <TrailStep key={id} id={id} />
            ))}
            {now && (
              <div key={now} className="agent-now">
                <span className="shimmer">{now}</span>
              </div>
            )}
          </div>
        </Collapse>
        <Collapse open={open}>
          <AgentBody item={item} live={live} />
        </Collapse>
      </div>
    </div>
  );
});

function firstLines(text: string | undefined): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  const lines = t.split('\n');
  return lines.length > 3 ? lines.slice(0, 3).join('\n') + '\n…' : t;
}

/** One of the latest steps: the conversation's own step row, a size down. */
const TrailStep = memo(function TrailStep({ id }: { id: string }) {
  const item = useItem<ToolItem>(id);
  if (!item || item.type !== 'tool') return null;
  return (
    <div className="agent-step" data-item-id={id}>
      <ToolView item={item} />
    </div>
  );
});

/** Opened: the task it was given, every step, and its report. */
function AgentBody({ item, live }: { item: ToolItem; live: boolean }) {
  const { sessionId } = useTimeline();
  const [whole, setWhole] = useState(false);
  const children = useStore((s) => s.data[sessionId]?.children[item.id]) ?? EMPTY;
  // The last thing it wrote is its report; the tool's result usually repeats it. Read once it is settled.
  const lastText = useStore((s) => {
    if (live) return '';
    const d = s.data[sessionId];
    const last = d?.items[children[children.length - 1]];
    return last?.type === 'text' ? last.text.trim() : '';
  });
  const failed = item.status === 'error';
  const result = item.result?.text?.trim() ?? '';
  const report = failed ? '' : result || lastText;
  const fold = !live && !!lastText && (!result || result === lastText);
  const thread = useMemo(() => (fold ? children.slice(0, -1) : children), [children, fold]);
  const prompt = item.detail.prompt?.trim();
  const errorText = failed ? (item.result?.stderr || item.result?.text || '').trim() : '';

  return (
    <div className="agent-body">
      {prompt && (
        <button type="button" className="agent-prompt" aria-expanded={whole} aria-label={whole ? 'Show less of the task' : 'Show the whole task'} onClick={() => setWhole((w) => !w)}>
          {prompt}
        </button>
      )}
      {thread.length > 0 && (
        <div className="agent-thread">
          <ItemList ids={thread} nested />
        </div>
      )}
      {errorText && <pre className="tool-error agent-error">{errorText}</pre>}
      {report && (
        <div className="agent-report">
          <Markdown text={report} />
        </div>
      )}
    </div>
  );
}
