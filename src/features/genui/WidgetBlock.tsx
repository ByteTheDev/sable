import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import type { ToolItem } from '@shared/protocol';
import { CodeBlock } from '@/components/CodeBlock';
import { CopyButton } from '@/components/CopyButton';
import { LazyTip } from '@/components/LazyTip';
import { Icon } from '@/icons';
import { useFresh } from '@/features/timeline/ctx';
import { useStore } from '@/state/store';
import { Modal } from '@/ui';
import { guessTitle, isSvg, prepareCode, slug, widgetSource } from './partial';
import { standaloneHtml } from './theme';
import { WidgetFrame, type FrameReport } from './WidgetFrame';

/** Saves the widget as a file the user can open anywhere: a page with Sable's look, or the bare SVG. */
export function saveWidget(title: string, code: string) {
  const svg = isSvg(code);
  const blob = new Blob([svg ? code : standaloneHtml(title, code)], { type: svg ? 'image/svg+xml' : 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug(title)}.${svg ? 'svg' : 'html'}`;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

interface WidgetViewProps {
  cacheKey: string;
  title: string;
  code: string;
  final: boolean;
  sessionId?: string;
  /** A short note under the widget (an error or an interruption). */
  note?: string;
  /** What "Copy code" copies (default: the code). */
  copyText?: string;
  /** More buttons for the bar, before the standard ones. */
  actions?: ReactNode;
  /** Height cap at rest. */
  cap?: number;
  /** Play the reveal when it completes (default: when it streamed in). */
  reveal?: boolean;
}

/**
 * A widget in the conversation: the frame with a hairline, and on hover or focus a small bar with
 * its title and what can be done with it (copy the code, save it, open it larger).
 */
export const WidgetView = memo(function WidgetView({ cacheKey, title, code, final, sessionId, note, copyText, actions, cap, reveal }: WidgetViewProps) {
  const [report, setReport] = useState<FrameReport | null>(null);
  const [large, setLarge] = useState(false);
  const name = title || (final ? guessTitle(code) : '');
  const onReport = useCallback((r: FrameReport) => setReport(r), []);

  return (
    <figure className="gw" data-final={final || undefined}>
      <WidgetFrame cacheKey={cacheKey} code={code} final={final} title={name} sessionId={sessionId} onReport={onReport} cap={cap} reveal={reveal} />
      {final ? (
        <div className="gw-bar" role="toolbar" aria-label={name || 'Widget'}>
          <span className="gw-title truncate">{name}</span>
          <Flags report={report} />
          {actions}
          <CopyButton text={copyText ?? code} label="Copy code" size={14} className="gw-btn" />
          <LazyTip label="Save as file" side="top">
            <button type="button" className="icon-btn gw-btn" aria-label="Save as file" onClick={() => saveWidget(name, code)}>
              <Icon name="download" size={14} />
            </button>
          </LazyTip>
          <LazyTip label="Open larger" side="top">
            <button type="button" className="icon-btn gw-btn" aria-label="Open larger" onClick={() => setLarge(true)}>
              <Icon name="expand" size={14} />
            </button>
          </LazyTip>
        </div>
      ) : null}
      {note && <figcaption className="gw-caption">{note}</figcaption>}
      {large && (
        <Modal open={large} onOpenChange={setLarge} title={name || 'Widget'} bare className="gw-dialog" width="min(1120px, calc(var(--vw) * 100 - 48px))">
          <div className="gw-dialog-head">
            <span className="gw-dialog-title truncate">{name || 'Widget'}</span>
            <CopyButton text={copyText ?? code} label="Copy code" size={14} tipSide="bottom" />
            <LazyTip label="Save as file" side="bottom">
              <button type="button" className="icon-btn" aria-label="Save as file" onClick={() => saveWidget(name, code)}>
                <Icon name="download" size={14} />
              </button>
            </LazyTip>
            <LazyTip label="Close" side="bottom">
              <button type="button" className="icon-btn" aria-label="Close" onClick={() => setLarge(false)}>
                <Icon name="x" size={14} />
              </button>
            </LazyTip>
          </div>
          <div className="gw-dialog-body scroll">
            <WidgetFrame cacheKey={`${cacheKey}:large`} code={code} final title={name} sessionId={sessionId} cap={Infinity} />
          </div>
        </Modal>
      )}
    </figure>
  );
});

/** Quiet facts about what the frame stopped, shown only when there is something to say. */
function Flags({ report }: { report: FrameReport | null }) {
  if (!report) return null;
  const parts: { label: string; tip?: string }[] = [];
  if (report.errors) parts.push({ label: plural(report.errors, 'Script error', 'Script errors'), tip: report.lastError });
  if (report.blocked) parts.push({ label: `Blocked ${report.blocked} ${plural(report.blocked, 'request', 'requests')}`, tip: report.lastBlocked ? `Widgets cannot use the network: ${report.lastBlocked}` : 'Widgets cannot use the network' });
  if (report.refused) parts.push({ label: `Refused ${report.refused} ${plural(report.refused, 'message', 'messages')}`, tip: 'A widget can only send a message right after you click in it' });
  return (
    <>
      {parts.map((p) => (
        <LazyTip key={p.label} label={p.tip ?? p.label} side="top">
          <span className="gw-flag" tabIndex={0}>
            {p.label}
          </span>
        </LazyTip>
      ))}
    </>
  );
}

/** The `show_widget` tool call as it appears in the conversation: the widget itself, not a step. */
export const WidgetBlock = memo(function WidgetBlock({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const enabled = useStore((s) => s.settings.generativeUi !== false);
  // Just arrived (not history): it gets the reveal, also when the call came complete in one piece.
  const fresh = useFresh(item.ts);
  const src = useMemo(() => widgetSource(item.input, item.inputText, item.title === 'Widget' ? '' : item.title), [item.input, item.inputText, item.title]);
  const stoppedEarly = !src.final && (item.status === 'cancelled' || item.status === 'error' || item.status === 'denied');
  const final = src.final || stoppedEarly;
  const code = stoppedEarly ? prepareCode(src.code, false) : src.code;
  let note: string | undefined;
  if (item.status === 'error' && item.result?.text) note = item.result.text.slice(0, 240);
  else if (stoppedEarly) note = 'Stopped before it was finished.';

  if (!enabled) {
    return code ? <CodeBlock code={code} lang="html" title={src.title || 'Widget'} streaming={!final} /> : null;
  }
  return <WidgetView cacheKey={item.id} title={src.title} code={code} final={final} sessionId={sessionId} note={note} reveal={fresh || undefined} />;
});
