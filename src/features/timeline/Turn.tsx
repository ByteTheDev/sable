import { memo, useMemo, useState } from 'react';
import type { TimelineItem, TurnItem, UserItem } from '@shared/protocol';
import { CopyButton } from '@/components/CopyButton';
import { LazyTip } from '@/components/LazyTip';
import { Icon } from '@/icons';
import { formatCost, formatTokens, isMac } from '@/lib/format';
import { openPreview, previewTargets } from '@/lib/links';
import { forkAt, sendMessage } from '@/state/actions';
import { useStore } from '@/state/store';
import { IconButton } from '@/ui';
import { useItem, useTimeline } from './ctx';
import type { TurnGroup } from './turns';

const textOf = (it: TimelineItem | undefined) => (it?.type === 'text' ? it.text.trim() : '');

/** What a copy of the response holds: the answers of every segment, or failing that every text. */
function responseText(items: Record<string, TimelineItem>, turn: TurnGroup): string {
  const answers = turn.segments.map((s) => textOf(s.answer ? items[s.answer] : undefined)).filter(Boolean);
  if (answers.length) return answers.join('\n\n');
  return turn.ids
    .map((id) => textOf(items[id]))
    .filter(Boolean)
    .join('\n\n');
}

/** Local pages the turn mentions: in its answers first, then in what its commands printed. */
function previewsOf(items: Record<string, TimelineItem>, turn: TurnGroup) {
  const texts: (string | undefined)[] = turn.segments.map((s) => textOf(s.answer ? items[s.answer] : undefined));
  for (let i = turn.ids.length - 1; i >= 0; i--) {
    const it = items[turn.ids[i]];
    if (it?.type === 'tool' && it.kind === 'bash') texts.push(it.output, it.result?.text);
  }
  return previewTargets(texts);
}

/**
 * Under a turn's answer: Preview controls for local pages it started or mentioned, "Try again"
 * after a failure, and on hover what the turn cost and a copy of the response.
 */
export const TurnFoot = memo(function TurnFoot({ turn }: { turn: TurnGroup }) {
  const { sessionId } = useTimeline();
  const end = useItem<TurnItem>(turn.end ?? '');
  const settled = turn.state !== 'running';
  const previews = useMemo(() => (settled ? previewsOf(useStore.getState().data[sessionId]?.items ?? {}, turn) : []), [settled, sessionId, turn]);
  const [forking, setForking] = useState(false);
  if (!settled) return null;

  const fork = async () => {
    const last = turn.ids[turn.ids.length - 1];
    if (!last || forking) return;
    setForking(true);
    await forkAt(sessionId, last);
    setForking(false);
  };

  const items = () => useStore.getState().data[sessionId]?.items ?? {};
  const failed = turn.state === 'failed';
  const errorShown = turn.segments.some((s) => s.errors.length > 0);
  const hasAnswer = turn.segments.some((s) => s.answer);

  const retry = () => {
    const all = items();
    const user = turn.ids.map((id) => all[id]).find((it): it is UserItem => it?.type === 'user');
    if (user) void sendMessage(sessionId, user.text, user.attachments ?? []);
  };

  const parts: string[] = [];
  const tokens = end?.type === 'turn' ? end.outputTokens || end.inputTokens : 0;
  if (tokens) parts.push(`${formatTokens(tokens)} tokens`);
  if (end?.type === 'turn' && end.costUsd) parts.push(formatCost(end.costUsd));
  const breakdown = end?.type === 'turn' && (end.inputTokens || end.outputTokens) ? `${formatTokens(end.inputTokens)} tokens read, ${formatTokens(end.outputTokens)} written` : undefined;

  if (!previews.length && !failed && !hasAnswer && !parts.length && turn.state !== 'interrupted') return null;

  return (
    <div className="tl-item turn" data-state={turn.state}>
      {failed && end?.type === 'turn' && end.error && !errorShown && (
        <div className="notice-error" role="alert">
          <Icon name="error" size={16} />
          <div className="notice-error-body">
            <div className="notice-error-text">The turn ended with an error</div>
            <div className="notice-error-detail">{end.error}</div>
          </div>
        </div>
      )}
      <div className="turn-line">
        {/* One page: "Preview" and its address. Several: each named by its address alone. */}
        {previews.map((p) => (
          <LazyTip key={p.url} label={`Opens in the Browser tab. ${isMac ? 'Cmd' : 'Ctrl'}+click opens your browser`} side="top">
            <button type="button" className="preview-btn" onClick={(e) => openPreview(p.url, e.ctrlKey || e.metaKey)} aria-label={`Preview ${p.label}`}>
              <Icon name="browser" size={14} className="preview-icon" />
              {previews.length === 1 && <span className="preview-name">Preview</span>}
              <span className={previews.length === 1 ? 'preview-host truncate' : 'preview-name truncate'}>{p.label}</span>
            </button>
          </LazyTip>
        ))}
        {failed && (
          <button type="button" className="btn btn-sm" onClick={retry}>
            <Icon name="refresh" size={13} />
            Try again
          </button>
        )}
        {turn.state === 'interrupted' && (
          <span className="turn-note">
            <Icon name="hand" size={12} />
            Interrupted
          </span>
        )}
        {hasAnswer && (
          // Always there under an answer: quiet at rest, brighter on hover.
          <span className="turn-acts">
            <CopyButton text={() => responseText(items(), turn)} label="Copy response" size={13} className="turn-copy" />
            <IconButton icon="fork" label="Fork from here" size={13} tipSide="top" className="turn-fork" disabled={forking} onClick={fork} />
          </span>
        )}
        <span className="turn-hover">
          {parts.length > 0 && (
            <LazyTip label={breakdown ?? parts.join(' · ')} side="top">
              <span className="turn-meta num">{parts.join(' · ')}</span>
            </LazyTip>
          )}
        </span>
      </div>
    </div>
  );
});
