import { memo, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { FileDiff } from '@shared/protocol';
import { Icon } from '@/icons';
import { langFromPath } from '@/lib/format';
import { useHighlight } from '@/lib/highlight';
import { useNearViewport } from '@/lib/view-hooks';
import { wordDiff, type Range } from '@/lib/word-diff';
import { useDiffReview, type ReviewTarget } from '@/features/review/diff-review';
import { markedLine } from './code-render';
import { Collapse } from './Collapse';
import './code.css';
import './diff.css';

export interface DiffViewProps {
  diff: FileDiff;
  /** Start expanded. Default true. */
  defaultOpen?: boolean;
  /** Show at most this many lines, with a "Show N more lines" control. */
  maxLines?: number;
  /** Render the file header (path, counts, collapse). Default true; without it the body is always open. */
  showHeader?: boolean;
  /** Show the old/new line-number gutter. Default true; turn off for previews whose numbers are not real. */
  lineNumbers?: boolean;
  /** Build the lines before the first paint when already on screen (default). Off while a transcript is being laid out, so the lines build in a task of their own behind a same-height box. */
  eager?: boolean;
  /** Lets the person comment on lines for the chat's review (features/review): which chat, which diff, which file. */
  review?: ReviewTarget;
  className?: string;
}

interface LineRow {
  t: ' ' | '+' | '-';
  text: string;
  old?: number;
  neu?: number;
  /** Index of this line in the old / new side text handed to the highlighter. */
  oi: number;
  ni: number;
  marks?: Range[];
}
type Row = LineRow | { t: 'sep'; text: string };

interface Model {
  rows: Row[];
  lines: number;
  oldSide: string;
  newSide: string;
  digits: number;
}

function build(diff: FileDiff): Model {
  const rows: Row[] = [];
  const oldSide: string[] = [];
  const newSide: string[] = [];
  let prevEnd = 1;
  let maxNo = 1;
  let lines = 0;
  for (const h of diff.hunks) {
    const gap = h.oldStart - prevEnd;
    if (gap > 0 && h.oldLines > 0) {
      rows.push({ t: 'sep', text: gap === 1 ? `Line ${prevEnd} unchanged` : `Lines ${prevEnd}–${h.oldStart - 1} unchanged` });
    }
    prevEnd = h.oldStart + h.oldLines;
    let o = h.oldStart;
    let n = h.newStart;
    const start = rows.length;
    for (const raw of h.lines) {
      const sign = raw[0];
      if (sign === '\\') continue;
      const text = raw.slice(1);
      if (sign === '+') {
        rows.push({ t: '+', text, neu: n++, oi: -1, ni: newSide.length });
        newSide.push(text);
      } else if (sign === '-') {
        rows.push({ t: '-', text, old: o++, oi: oldSide.length, ni: -1 });
        oldSide.push(text);
      } else {
        rows.push({ t: ' ', text, old: o++, neu: n++, oi: oldSide.length, ni: newSide.length });
        oldSide.push(text);
        newSide.push(text);
      }
      lines++;
    }
    maxNo = Math.max(maxNo, o - 1, n - 1);
    // Pair each removed line with the added line that replaced it and mark what changed inside.
    for (let i = start; i < rows.length; ) {
      if (rows[i].t !== '-') {
        i++;
        continue;
      }
      let d = i;
      while (d < rows.length && rows[d].t === '-') d++;
      let a = d;
      while (a < rows.length && rows[a].t === '+') a++;
      const pairs = Math.min(d - i, a - d);
      if (pairs <= 24) {
        for (let k = 0; k < pairs; k++) {
          const del = rows[i + k] as LineRow;
          const add = rows[d + k] as LineRow;
          if (del.text.length > 600 || add.text.length > 600) continue;
          const wd = wordDiff(del.text, add.text);
          if (wd) {
            del.marks = wd.a;
            add.marks = wd.b;
          }
        }
      }
      i = a;
    }
  }
  return { rows, lines, oldSide: oldSide.join('\n'), newSide: newSide.join('\n'), digits: String(maxNo).length };
}

function splitPath(path: string): [dir: string, base: string] {
  const p = path.replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

const STATUS: Record<string, { label: string; tone: string } | undefined> = {
  added: { label: 'New', tone: 'green' },
  deleted: { label: 'Deleted', tone: 'red' },
  renamed: { label: 'Renamed', tone: 'blue' },
};

const HIGHLIGHT_MAX_LINES = 700;

/** A unified diff for one file: line numbers, word-level marks, syntax colours when cheap. */
export const DiffView = memo(function DiffView({ diff, defaultOpen = true, maxLines, showHeader = true, lineNumbers = true, eager = true, review, className }: DiffViewProps) {
  const [open, setOpen] = useState(defaultOpen || !showHeader);
  const [all, setAll] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const model = useMemo(() => build(diff), [diff]);
  const visible = open || !showHeader;
  const [eagerAtMount] = useState(eager);
  const near = useNearViewport(root, !visible, eagerAtMount);
  const lang = langFromPath(diff.path);
  const cheap = visible && near && model.lines <= HIGHLIGHT_MAX_LINES;
  const oldTokens = useHighlight(model.oldSide, lang, cheap && diff.deletions > 0);
  const newTokens = useHighlight(model.newSide, lang, cheap);

  const [dir, base] = splitPath(diff.path);
  const status = STATUS[diff.status];
  const empty = diff.binary || model.lines === 0;
  const rv = useDiffReview(empty ? undefined : review, model.rows, lineNumbers, base);

  let limit = model.rows.length;
  let hidden = 0;
  if (maxLines && !all && model.lines > maxLines + 8) {
    let seen = 0;
    for (let i = 0; i < model.rows.length; i++) {
      if (model.rows[i].t !== 'sep' && ++seen > maxLines) {
        limit = i;
        break;
      }
    }
    hidden = model.lines - maxLines;
    // A comment (or the field) below the cut: the lines show that far, so it is never hidden.
    if (rv.reach >= limit) {
      limit = model.rows.length;
      hidden = 0;
    }
  }

  // Built once per change of the lines or their colours, so a render for anything else (a comment,
  // a picked range) never draws the rows again.
  const cols = lineNumbers ? (diff.status === 'added' || diff.status === 'deleted' ? 1 : 2) : 0;
  const drawn = visible && near && !empty;
  const rowEls = useMemo(
    () =>
      (drawn ? model.rows.slice(0, limit) : []).map((row, i) => {
        if (row.t === 'sep') {
          if (!lineNumbers) return null;
          return (
            <div className="dv-sep" key={i}>
              <span>{row.text}</span>
            </div>
          );
        }
        const toks = row.t === '-' ? oldTokens?.[row.oi] : newTokens?.[row.ni];
        return (
          <div className="dv-row" data-t={row.t === ' ' ? undefined : row.t} data-i={i} key={i}>
            <span className="dv-gutter" aria-hidden>
              {lineNumbers && diff.status !== 'added' && <span className="dv-n">{row.old}</span>}
              {lineNumbers && diff.status !== 'deleted' && <span className="dv-n">{row.neu}</span>}
            </span>
            <span className="dv-sign" aria-hidden>
              {row.t === ' ' ? '' : row.t === '+' ? '+' : '−'}
            </span>
            <span className="dv-code">{markedLine(row.text, toks, row.marks, 'dv-mark')}</span>
          </div>
        );
      }),
    [drawn, model, limit, lineNumbers, diff.status, oldTokens, newTokens],
  );
  let lines: ReactNode = rowEls;
  if (rv.on) {
    const out: ReactNode[] = [];
    rowEls.forEach((el, i) => {
      out.push(el);
      const s = rv.slot(i);
      if (s) out.push(s);
    });
    lines = out;
  }

  // Far from the viewport the lines are not mounted: a box of the same height stands in.
  const shownLines = hidden > 0 ? maxLines! : model.lines;
  const seps = lineNumbers ? model.rows.slice(0, limit).filter((r) => r.t === 'sep').length : 0;
  const placeholder = 10 + shownLines * 20 + seps * 34 + (hidden > 0 ? 31 : 0);

  const body = empty ? (
    <div className="dv-note">
      {diff.binary
        ? 'Binary file, no preview'
        : diff.status === 'renamed'
          ? 'Renamed without changes'
          : diff.status === 'added'
            ? 'Empty file'
            : diff.status === 'deleted'
              ? 'File deleted'
              : 'No changes'}
    </div>
  ) : !near ? (
    <div style={{ height: placeholder }} aria-hidden />
  ) : (
    <>
      <div className="dv-body hscroll" style={{ '--dv-digits': model.digits, '--rv-cols': cols } as CSSProperties}>
        <div className="dv-lines" {...rv.linesProps}>
          {lines}
        </div>
      </div>
      {hidden > 0 && (
        <button type="button" className="cb-more" onClick={() => setAll(true)}>
          Show {hidden} more lines
          <Icon name="caret-down" size={11} />
        </button>
      )}
    </>
  );

  return (
    <div ref={root} className={`dv ${className ?? ''}`} data-spot data-open={visible || undefined} data-status={diff.status} data-review={rv.on || undefined} data-rv-scope={rv.on ? review!.scope : undefined}>
      {showHeader && (
        <button type="button" className="dv-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name={lang === 'text' || lang === 'markdown' ? 'file-text' : 'file-code'} size={15} className="dv-icon" />
          <span className="dv-path">
            {diff.status === 'renamed' && diff.oldPath && <span className="dv-dir truncate">{diff.oldPath.replace(/\\/g, '/')} → </span>}
            {dir && <span className="dv-dir truncate">{dir}</span>}
            <span className="dv-base">{base}</span>
          </span>
          {status && (
            <span className="badge" data-tone="" style={{ '--tone': `var(--${status.tone})`, '--tone-dim': `var(--${status.tone}-dim)` } as CSSProperties}>
              {status.label}
            </span>
          )}
          <span className="dv-stat num">
            {diff.additions > 0 && <span className="dv-add">+{diff.additions}</span>}
            {diff.deletions > 0 && <span className="dv-del">−{diff.deletions}</span>}
          </span>
          <Icon name="caret-right" size={11} className="dv-caret" />
        </button>
      )}
      {showHeader ? <Collapse open={open}>{body}</Collapse> : body}
    </div>
  );
});
