import { memo, useMemo, useState } from 'react';
import type { UserItem } from '@shared/protocol';
import { taskLabel, taskName, type Synthetic, type SyntheticPart, type TaskNote, type TaskOutcome } from '@shared/synthetic';
import { Collapse } from '@/components/Collapse';
import { Markdown } from '@/components/Markdown';
import { Icon, type IconName } from '@/icons';
import { openFileLink } from '@/lib/file-links';
import { formatDuration, formatTokens, plural, tildePath } from '@/lib/format';
import { PathLabel } from '@/ui';
import { useTimeline } from './ctx';
import { stampParts } from './util';
import './synthetic.css';

/**
 * What the agent's harness wrote in the person's place (shared/synthetic.ts), as quiet lines in
 * the flow instead of message bubbles: a background task or sub-agent that finished, with its
 * result behind the line; a slash command as typed ("/model opus") with what it printed under it;
 * a `!` command; a message from another session; the summary a compacted conversation goes on
 * from. Reminders and caveats are never drawn (ItemRow leaves them out).
 */
export const SyntheticLine = memo(function SyntheticLine({ item, syn }: { item: UserItem; syn: Synthetic }) {
  const parts = syn.parts.filter((p) => p.kind !== 'hidden');
  return (
    <div className="syn" data-role={syn.role}>
      {parts.map((p, i) => (
        <Part key={i} part={p} ts={item.ts} first={i === 0} />
      ))}
    </div>
  );
});

function Part({ part, ts, first }: { part: SyntheticPart; ts: number; first: boolean }) {
  switch (part.kind) {
    case 'task':
      return <TaskLine task={part.task} ts={ts} />;
    case 'command':
      return <CommandLine name={part.name} args={part.args} ts={ts} />;
    case 'bash':
      return <BashLine command={part.command} ts={ts} />;
    case 'output':
      return <OutputLines text={part.text} error={part.error} mono={part.source === 'bash'} lone={first} />;
    case 'message':
      return <OpenLine icon="chat" title={`Message from ${part.from || 'another session'}`} sub={firstLine(part.text)} body={part.text} ts={ts} />;
    case 'summary':
      return <OpenLine icon="collapse" title="Conversation summary" body={part.text.replace(/^This session is being continued[^\n]*\n*/, '')} ts={ts} />;
    default:
      return null;
  }
}

const firstLine = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) ?? '';

/** The caret's place on a line that does not open, so the times of all lines stand in one column. */
const CaretSlot = () => <span className="syn-caret-slot" aria-hidden />;

/** The time a line came in: the time of day, with the day when it is not today. */
function When({ ts }: { ts: number }) {
  if (!ts) return null;
  const { day, time } = stampParts(ts);
  return (
    <time className="syn-time num" dateTime={new Date(ts).toISOString()}>
      {day ? `${day}, ${time}` : time}
    </time>
  );
}

const MARK: Record<TaskOutcome, IconName> = {
  done: 'check-circle',
  failed: 'x-circle',
  stopped: 'prohibit',
  running: 'circle-dashed',
  unknown: 'bell',
};

/** A long result opens cut here (characters), on a paragraph's end; "Show all" gives the rest. */
const RESULT_CUT = 1400;

function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const para = text.lastIndexOf('\n\n', max);
  const at = para > max * 0.5 ? para : text.lastIndexOf('\n', max) > max * 0.5 ? text.lastIndexOf('\n', max) : max;
  return text.slice(0, at).trimEnd();
}

/** "Background task finished · Build the installer", its mark and time; opened, the result, the usage and the output file. */
function TaskLine({ task, ts }: { task: TaskNote; ts: number }) {
  const [open, setOpen] = useState(false);
  const name = taskName(task);
  const result = task.result?.trim() ?? '';
  const facts = useMemo(() => {
    const u = task.usage;
    if (!u) return '';
    return [u.tokens ? `${formatTokens(u.tokens)} tokens` : '', u.toolUses ? plural(u.toolUses, 'tool use') : '', u.durationMs ? formatDuration(u.durationMs) : ''].filter(Boolean).join(' · ');
  }, [task.usage]);
  const more = !!(result || task.outputFile || facts);
  const failed = task.outcome === 'failed';
  const label = taskLabel(task);
  return (
    <div className="tool syn-line" data-status={failed ? 'error' : task.outcome === 'stopped' ? 'cancelled' : 'done'} data-open={open || undefined}>
      <button
        type="button"
        className="row-btn tool-row"
        aria-expanded={more ? open : undefined}
        aria-label={name ? `${label}: ${name}` : label}
        data-static={!more || undefined}
        tabIndex={more ? undefined : -1}
        onClick={() => more && setOpen(!open)}
      >
        <span className="tool-icon syn-mark" data-outcome={task.outcome}>
          <Icon name={MARK[task.outcome]} size={14} />
        </span>
        <span className="tool-title">{label}</span>
        {name && <span className="tool-sub truncate">{name}</span>}
        <span className="tool-meta">
          {failed && task.exitCode != null && task.exitCode !== 0 && <span className="tool-exit num">exit {task.exitCode}</span>}
          <When ts={ts} />
        </span>
        {more ? <Icon name="caret-right" size={10} className="row-caret" /> : <CaretSlot />}
      </button>
      {more && (
        <Collapse open={open}>
          <TaskDetails task={task} result={result} facts={facts} />
        </Collapse>
      )}
    </div>
  );
}

function TaskDetails({ task, result, facts }: { task: TaskNote; result: string; facts: string }) {
  const { cwd, home } = useTimeline();
  const [whole, setWhole] = useState(false);
  const shown = whole ? result : cutText(result, RESULT_CUT);
  const cut = shown.length < result.length;
  return (
    <div className="syn-details">
      {result && (
        <div className="syn-result detail-prose">
          <Markdown text={shown} />
          {(cut || whole) && (
            <button type="button" className="syn-more" onClick={() => setWhole((w) => !w)} aria-expanded={whole}>
              {whole ? 'Show less' : 'Show all'}
              <Icon name={whole ? 'caret-up' : 'caret-down'} size={11} weight="bold" />
            </button>
          )}
        </div>
      )}
      {(facts || task.outputFile) && (
        <div className="syn-facts">
          {facts && <span className="num">{facts}</span>}
          {task.outputFile && (
            <a
              className="syn-file"
              href={`file:///${task.outputFile.replace(/\\/g, '/')}`}
              onClick={(e) => openFileLink(e, task.outputFile!, cwd)}
              onAuxClick={(e) => e.preventDefault()}
              aria-label={`Open the output file ${task.outputFile}`}
            >
              <Icon name="file-text" size={13} />
              <PathLabel path={tildePath(task.outputFile, home)} title={task.outputFile} />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** Icons for the commands people run most; any other is a plain prompt. */
const COMMAND_ICON: Record<string, IconName> = {
  '/model': 'cube',
  '/compact': 'collapse',
  '/context': 'context',
  '/cost': 'coins',
  '/usage': 'gauge',
  '/clear': 'broom',
  '/help': 'question',
  '/mcp': 'mcp',
  '/agents': 'agents',
  '/memory': 'memory',
  '/review': 'eye',
  '/permissions': 'shield',
  '/config': 'settings',
  '/fast': 'fast-forward',
  '/resume': 'history',
  '/rewind': 'rewind',
  '/hooks': 'hook',
  '/skills': 'skill',
};

/** A slash command as it was typed: "/model opus". */
function CommandLine({ name, args, ts }: { name: string; args: string; ts: number }) {
  return (
    <div className="tool syn-line" data-status="done">
      <div className="row-btn tool-row" data-static>
        <span className="tool-icon">
          <Icon name={COMMAND_ICON[name.toLowerCase()] ?? 'prompt'} size={14} />
        </span>
        <span className="tool-title syn-cmd">
          <span className="syn-cmd-name">{name}</span>
          {args && <span className="syn-cmd-args"> {args}</span>}
        </span>
        <span className="tool-meta">
          <When ts={ts} />
        </span>
        <CaretSlot />
      </div>
    </div>
  );
}

/** A `!` command typed in the agent's own terminal. */
function BashLine({ command, ts }: { command: string; ts: number }) {
  return (
    <div className="tool syn-line" data-status="done">
      <div className="row-btn tool-row" data-static>
        <span className="tool-icon">
          <Icon name="terminal" size={14} />
        </span>
        <span className="tool-title syn-cmd truncate" title={command}>
          {command}
        </span>
        <span className="tool-meta">
          <When ts={ts} />
        </span>
        <CaretSlot />
      </div>
    </div>
  );
}

/** Lines of output shown before "N more lines". */
const OUT_LINES = 3;

/** What a command printed: dim lines under it, the first few in view. */
function OutputLines({ text, error, mono, lone }: { text: string; error: boolean; mono: boolean; lone: boolean }) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const hidden = lines.length - OUT_LINES;
  const shown = all || hidden <= 1 ? text : lines.slice(0, OUT_LINES).join('\n');
  return (
    <div className="syn-out" data-error={error || undefined} data-mono={mono || undefined} data-lone={lone || undefined}>
      <div className="syn-out-text">{shown}</div>
      {hidden > 1 && (
        <button type="button" className="syn-more" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          {all ? 'Show less' : `${hidden} more lines`}
          <Icon name={all ? 'caret-up' : 'caret-down'} size={11} weight="bold" />
        </button>
      )}
    </div>
  );
}

/** A line that opens to a body of text (a message from elsewhere, a conversation summary). */
function OpenLine({ icon, title, sub, body, ts }: { icon: IconName; title: string; sub?: string; body: string; ts: number }) {
  const [open, setOpen] = useState(false);
  const [whole, setWhole] = useState(false);
  const text = body.trim();
  const shown = whole ? text : cutText(text, RESULT_CUT);
  const more = !!text;
  return (
    <div className="tool syn-line" data-status="done" data-open={open || undefined}>
      <button type="button" className="row-btn tool-row" aria-expanded={more ? open : undefined} data-static={!more || undefined} tabIndex={more ? undefined : -1} onClick={() => more && setOpen(!open)}>
        <span className="tool-icon">
          <Icon name={icon} size={14} />
        </span>
        <span className="tool-title">{title}</span>
        {sub && <span className="tool-sub truncate">{sub}</span>}
        <span className="tool-meta">
          <When ts={ts} />
        </span>
        {more ? <Icon name="caret-right" size={10} className="row-caret" /> : <CaretSlot />}
      </button>
      {more && (
        <Collapse open={open}>
          <div className="syn-details">
            <div className="syn-result detail-prose">
              <Markdown text={shown} />
              {(whole || shown.length < text.length) && (
                <button type="button" className="syn-more" onClick={() => setWhole((w) => !w)} aria-expanded={whole}>
                  {whole ? 'Show less' : 'Show all'}
                  <Icon name={whole ? 'caret-up' : 'caret-down'} size={11} weight="bold" />
                </button>
              )}
            </div>
          </div>
        </Collapse>
      )}
    </div>
  );
}
