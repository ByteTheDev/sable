import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton, Kbd } from '@/ui';
import type { ReviewComment } from './model';

/**
 * Opens to its content's height and closes to nothing (grid rows, like components/Collapse), so
 * the diff's lines below move with it instead of jumping. Unlike Collapse it can reveal itself on
 * mount (`appear`), and tells when it has closed (`onClosed`).
 */
export function Grow({ open, appear, onClosed, children }: { open: boolean; appear?: boolean; onClosed?: () => void; children: ReactNode }) {
  const [shown, setShown] = useState(open && !appear);
  const [settled, setSettled] = useState(open && !appear);
  const closed = useRef(onClosed);
  closed.current = onClosed;

  useEffect(() => {
    if (open) {
      if (shown) return;
      // Two frames: one laid out at no height, one to start the transition.
      let b = 0;
      const a = requestAnimationFrame(() => {
        b = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(a);
        cancelAnimationFrame(b);
      };
    }
    setSettled(false);
    setShown(false);
    // In case no transition ends (reduced motion, a hidden window).
    const t = window.setTimeout(() => closed.current?.(), 420);
    return () => window.clearTimeout(t);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!shown || settled) return;
    const t = window.setTimeout(() => setSettled(true), 420);
    return () => window.clearTimeout(t);
  }, [shown, settled]);

  return (
    <div
      className="rv-grow"
      data-open={(shown && open) || undefined}
      data-settled={(settled && open) || undefined}
      inert={!open || undefined}
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget || e.propertyName !== 'grid-template-rows') return;
        if (open) setSettled(true);
        else closed.current?.();
      }}
    >
      <div className="rv-grow-inner">{children}</div>
    </div>
  );
}

const MAX_FIELD_LINES = 8;

/**
 * The inline field under the picked lines: Enter adds the comment, Shift+Enter a new line, Esc
 * cancels. It grows with what is typed, up to eight lines, then scrolls.
 */
export function DraftField({
  placeholder,
  initial,
  editing,
  focus,
  onText,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  initial: string;
  editing?: boolean;
  /** Take the keyboard on mount (a field just opened, not one restored with its diff). */
  focus?: boolean;
  onText: (text: string) => void;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ta = useRef<HTMLTextAreaElement>(null);
  const can = text.trim().length > 0;

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 19;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    el.style.height = 'auto';
    const max = line * MAX_FIELD_LINES + pad;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [text]);

  useEffect(() => {
    if (!focus) return;
    const el = ta.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    // Once it has opened, it is brought into view if it opened below the fold.
    const t = window.setTimeout(() => el.closest('.rv-grow')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 230);
    return () => window.clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    if (can) onSubmit(text.trim());
  };

  return (
    <div className="rv-card rv-draft" data-spot>
      <textarea
        ref={ta}
        className="rv-field scroll"
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck
        onChange={(e) => {
          setText(e.target.value);
          onText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="rv-draft-foot">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm rv-submit" disabled={!can} onClick={submit}>
          {editing ? 'Save' : 'Comment'}
          <Kbd combo="enter" />
        </button>
      </div>
    </div>
  );
}

/** A comment added to the review, under its lines: its words, and Edit and Delete on hover or focus. */
export function CommentCard({
  comment,
  range,
  onEdit,
  onDelete,
  onPeek,
}: {
  comment: ReviewComment;
  /** "Lines 12–14", for a comment on more than one line. */
  range?: string;
  onEdit: () => void;
  onDelete: () => void;
  /** The pointer or the keyboard is on the card: its lines light up in the diff. */
  onPeek: (on: boolean) => void;
}) {
  return (
    <div
      className="rv-card rv-note"
      data-spot
      data-rv-id={comment.id}
      // Focusable from code only: a jump from the review bar's list lands the keyboard here.
      tabIndex={-1}
      aria-label={range ? `Comment on ${range.toLowerCase()}: ${comment.text}` : `Comment: ${comment.text}`}
      onPointerEnter={() => onPeek(true)}
      onPointerLeave={() => onPeek(false)}
      onFocus={() => onPeek(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onPeek(false);
      }}
    >
      <div className="rv-note-body" onDoubleClick={onEdit}>
        {range && <div className="rv-note-range num">{range}</div>}
        <div className="rv-note-text">{comment.text}</div>
      </div>
      <div className="rv-note-acts">
        <IconButton icon="pencil" label="Edit comment" size={13} className="icon-btn-xs" tipSide="top" onClick={onEdit} />
        <IconButton icon="trash" label="Delete comment" size={13} className="icon-btn-xs" tipSide="top" onClick={onDelete} />
      </div>
    </div>
  );
}
