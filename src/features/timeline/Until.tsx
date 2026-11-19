import { memo, useState } from 'react';
import type { NoticeItem, UntilCheck } from '@shared/protocol';
import { Collapse } from '@/components/Collapse';
import { CopyButton } from '@/components/CopyButton';
import { Icon } from '@/icons';
import { formatDuration } from '@/lib/format';
import './until.css';

/**
 * Until green in the conversation. Each check Sable ran is one step-sized row: passed with its
 * count in green figures, failed with the count in red and its output behind the disclosure (what
 * the agent was sent). A failing check is the message that starts the agent's next turn.
 */
export const CheckRow = memo(function CheckRow({ check, sent = false }: { check: UntilCheck; sent?: boolean }) {
  const [open, setOpen] = useState(false);
  const expandable = !!check.output;
  const result = check.passed ? (
    check.passing ? (
      <span className="num t-add">{check.passing} passed</span>
    ) : null
  ) : (
    <span className="num tool-fail">{check.timedOut ? 'Timed out' : check.failing ? `${check.failing} failing` : check.exitCode != null ? `exit ${check.exitCode}` : 'Failed'}</span>
  );

  return (
    <div className="tool ck" data-status={check.passed ? 'done' : 'error'} data-open={open || undefined}>
      <button
        type="button"
        className="row-btn tool-row"
        aria-expanded={expandable ? open : undefined}
        data-static={!expandable || undefined}
        tabIndex={expandable ? undefined : -1}
        onClick={() => expandable && setOpen(!open)}
      >
        <span className="tool-icon">
          <Icon name={check.passed ? 'check-circle' : 'x-circle'} size={14} />
        </span>
        <span className="tool-title">{check.passed ? 'Check passed' : 'Check failed'}</span>
        <span className="tool-sub truncate">{check.command}</span>
        <span className="tool-meta">
          {result}
          <span className="num">
            round {check.round} of {check.rounds}
          </span>
          {check.durationMs >= 100 && <span className="num">{formatDuration(check.durationMs)}</span>}
        </span>
        {expandable && <Icon name="caret-right" size={10} className="row-caret" />}
      </button>
      {expandable && (
        <Collapse open={open}>
          <div className="tool-details">
            <div className="term" data-failed={!check.passed || undefined}>
              <div className="term-cmd">
                <span className="term-ps" aria-hidden>
                  $
                </span>
                <code className="term-line">{check.command}</code>
                <span className="term-side">
                  {sent && <span className="term-note">Sent to the agent</span>}
                  {check.exitCode != null && check.exitCode !== 0 && <span className="tool-exit">exit {check.exitCode}</span>}
                  <CopyButton text={check.output ?? ''} label="Copy output" size={13} className="cb-btn term-copy" />
                </span>
              </div>
              <div className="term-out ck-out vscroll">
                <pre>{check.output}</pre>
              </div>
            </div>
          </div>
        </Collapse>
      )}
    </div>
  );
});

/** The loop's end: its last check (when it ended on one), then one calm line. */
export const UntilEnd = memo(function UntilEnd({ item }: { item: NoticeItem }) {
  const end = item.until?.end;
  const check = item.until?.check;
  return (
    <div className="ck-end" data-end={end}>
      {check && <CheckRow check={check} />}
      <div className="notice ck-line">
        <div className="notice-line">
          <span className="notice-rule" />
          <span className="notice-label">
            <Icon name={end === 'passed' ? 'check-circle' : 'stop'} size={13} />
            <span className="truncate">{item.text}</span>
            {item.detail && <span className="ck-cmd truncate">{item.detail}</span>}
          </span>
          <span className="notice-rule" />
        </div>
      </div>
    </div>
  );
});
