import { memo, useState, type ReactNode } from 'react';
import { LazyTip } from '@/components/LazyTip';
import { Icon, type IconName } from '@/icons';
import { focusComposer } from '@/state/hooks';
import { fuzzy } from '@/lib/fuzzy';
import { useStore } from '@/state/store';

export interface UseItem {
  key: string;
  /** Shown as the row's title, e.g. "/review". */
  title: string;
  description?: string;
  /** One quiet word after the title (an agent's model), plain text rather than a tag. */
  meta?: string;
  /** Text placed in the composer by "Use". */
  insert: string;
}

let pending: string | null = null;

/** Closes Settings and hands text to the composer when the dialog gives focus back (see `takeComposerFocus`). */
export function sendToComposer(text: string) {
  pending = text;
  useStore.getState().setUi({ settings: null });
}

/** The Settings dialog's onCloseAutoFocus: send focus to the composer instead of the trigger when text is waiting. */
export function takeComposerFocus(e: Event) {
  if (pending === null) return;
  e.preventDefault();
  focusComposer(pending);
  pending = null;
}

export function UseList({ items, icon, title, count }: { items: UseItem[]; icon: IconName; title?: ReactNode; count?: number }) {
  return (
    <section className="set-group">
      {title && (
        <header className="set-group-head">
          <h3 className="set-group-title">
            {title}
            {count !== undefined && <span className="set-group-count num">{count}</span>}
          </h3>
        </header>
      )}
      <div className="card set-card">
        <div className="xlist">
          {items.map((it) => (
            <UseRow key={it.key} item={it} icon={icon} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** One quiet line: icon, name, description (truncated; full text in a tooltip, and wrapped when the row is opened). */
const UseRow = memo(function UseRow({ item: it, icon }: { item: UseItem; icon: IconName }) {
  const [open, setOpen] = useState(false);
  const head = (
    <button type="button" className="xrow-head use-head" aria-expanded={it.description ? open : undefined} onClick={() => it.description && setOpen(!open)}>
      <Icon name={icon} size={15} className="use-icon" />
      <span className="use-name">{it.title}</span>
      {it.meta && <span className="xrow-meta">{it.meta}</span>}
      {it.description && <span className="use-desc">{it.description}</span>}
    </button>
  );
  return (
    <div className="xrow use-row" data-open={open || undefined}>
      {it.description ? (
        <LazyTip label={<span className="use-tip">{it.description}</span>} side="top">
          {head}
        </LazyTip>
      ) : (
        head
      )}
      <button type="button" className="btn btn-sm use-btn" aria-label={`Use ${it.title}`} onClick={() => sendToComposer(it.insert)}>
        Use
      </button>
    </div>
  );
});

/** Filters and orders items by a fuzzy query over title and description. */
export function rank<T extends UseItem>(items: T[], query: string): T[] {
  if (!query.trim()) return items;
  return items
    .map((it) => ({ it, m: fuzzy(query, `${it.title} ${it.description ?? ''}`) }))
    .filter((x) => x.m)
    .sort((a, b) => b.m!.score - a.m!.score)
    .map((x) => x.it);
}
