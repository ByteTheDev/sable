import { memo, useState } from 'react';
import type { ThinkingItem } from '@shared/protocol';
import { Collapse } from '@/components/Collapse';
import { Markdown } from '@/components/Markdown';
import { Icon } from '@/icons';
import { useStore } from '@/state/store';
import { shortDuration } from './util';

/** The last few hundred characters of a thought, with markdown marks removed. */
function previewOf(text: string): string {
  return text
    .slice(-420)
    .replace(/[`*_#>]+/g, '')
    .replace(/\s*\n\s*/g, ' ');
}

/**
 * Reasoning: one quiet line. While it streams, the latest thought shows through a small
 * window that fades at the top; afterwards the full text is one click away.
 */
export const Thinking = memo(function Thinking({ item }: { item: ThinkingItem }) {
  const show = useStore((s) => s.settings.showThinking);
  const [open, setOpen] = useState(false);
  const label = item.streaming ? 'Thinking' : item.endedAt ? `Thought for ${shortDuration(item.endedAt - item.ts)}` : 'Thought';
  const canOpen = show && !item.streaming && item.text.trim().length > 0;

  const head = (
    <>
      <span className="row-slot think-icon">
        <Icon name="brain" size={15} />
      </span>
      <span className={item.streaming ? 'think-label shimmer' : 'think-label'}>{label}</span>
      {canOpen && <Icon name="caret-right" size={11} className="row-caret" />}
    </>
  );

  return (
    <div className="think" data-open={open || undefined}>
      {canOpen ? (
        <button type="button" className="row-btn think-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {head}
        </button>
      ) : (
        <div className="row-btn think-row" data-static>
          {head}
        </div>
      )}
      {show && (
        <Collapse open={item.streaming && item.text.length > 0}>
          <div className="think-preview" aria-hidden>
            <p>{previewOf(item.text)}</p>
          </div>
        </Collapse>
      )}
      {show && (
        <Collapse open={open && !item.streaming}>
          <div className="think-body">
            <Markdown text={item.text} />
          </div>
        </Collapse>
      )}
    </div>
  );
});
