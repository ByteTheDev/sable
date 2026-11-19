import { Fragment, memo, useMemo, useRef, useState, type ReactNode } from 'react';
import { hashCode } from '@/features/genui/partial';
import { WidgetFrame } from '@/features/genui/WidgetFrame';
import { Icon } from '@/icons';
import { langLabel as baseLabel, useHighlight } from '@/lib/highlight';

/** SVG is coloured as XML but named for what it is. */
const langLabel = (lang?: string) => (lang?.trim().toLowerCase() === 'svg' ? 'SVG' : baseLabel(lang));
import { useNearViewport } from '@/lib/view-hooks';
import { hlLine } from './code-render';
import { CopyButton } from './CopyButton';
import { LazyTip } from './LazyTip';
import './code.css';

export interface CodeBlockProps {
  code: string;
  /** Language id or alias ("ts", "typescript", "sh"…). Unknown languages render as plain text. */
  lang?: string;
  /** Shown in the header instead of the language name (a file path, a label). */
  title?: string;
  /** Height in px after which the block is clipped behind "Show all N lines". Default 380; `Infinity` never clips. */
  maxHeight?: number;
  /** Start with long lines wrapped. */
  wrap?: boolean;
  /** The code is still arriving: stay plain and never clip. */
  streaming?: boolean;
  /** Show a line-number gutter starting at this number. */
  startLine?: number;
  className?: string;
  /** More buttons for the header, before wrap and copy. */
  actions?: ReactNode;
}

/** HTML and SVG can be previewed (in the widget sandbox); the code stays the default view. */
function previewable(lang: string | undefined, text: string): boolean {
  const l = (lang ?? '').toLowerCase();
  if (l === 'svg') return /<svg\b/i.test(text);
  if (l === 'html' || l === 'htm' || l === 'xhtml') return /<[a-z][\s\S]*>/i.test(text);
  if (l === 'xml') return /^\s*(<\?xml[^>]*>\s*)?<svg\b/i.test(text);
  return false;
}

const LINE_H = 18;
const PAD = 14;

function countLines(text: string): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * Code in a recessed well: a slim header (language, wrap, copy) over the text.
 * Colours arrive in idle time and never change the layout.
 */
export const CodeBlock = memo(function CodeBlock({ code, lang, title, maxHeight = 380, wrap = false, streaming = false, startLine, className, actions }: CodeBlockProps) {
  const text = code.endsWith('\n') ? code.slice(0, -1) : code;
  const root = useRef<HTMLDivElement>(null);
  const near = useNearViewport(root, streaming);
  const tokens = useHighlight(text, lang, near && !streaming);
  const lineCount = useMemo(() => countLines(text), [text]);
  const [wrapped, setWrapped] = useState(wrap);
  // A block the reader watched arrive stays open: clipping it at the end would make the page jump.
  const watched = useRef(streaming);
  const [expanded, setExpanded] = useState(false);
  const canPreview = !streaming && previewable(lang, text);
  const [preview, setPreview] = useState(false);
  const showPreview = canPreview && preview;
  const previewKey = useMemo(() => (canPreview ? `cb:${hashCode(text)}` : ''), [canPreview, text]);

  const full = lineCount * LINE_H + PAD;
  const long = Number.isFinite(maxHeight) && full > maxHeight + 120 && !watched.current && !streaming;
  const clipped = long && !expanded;
  const numbered = startLine !== undefined;
  const ok = tokens && tokens.length === lineCount ? tokens : null;

  const body = useMemo(() => {
    if (numbered) {
      const lines = ok ? null : text.split('\n');
      return Array.from({ length: lineCount }, (_, i) => (
        <span className="cb-line" key={i} data-n={startLine! + i}>
          {ok ? hlLine(ok[i]) : lines![i]}
          {'\n'}
        </span>
      ));
    }
    if (!ok) return text;
    return ok.map((line, i) => (
      <Fragment key={i}>
        {hlLine(line)}
        {i < ok.length - 1 ? '\n' : null}
      </Fragment>
    ));
  }, [ok, text, numbered, startLine, lineCount]);

  return (
    <div
      ref={root}
      className={`cb ${className ?? ''}`}
      data-spot
      data-wrap={wrapped || undefined}
      data-clipped={clipped || undefined}
      data-numbered={numbered || undefined}
      style={numbered ? ({ '--cb-digits': String(startLine! + lineCount - 1).length } as React.CSSProperties) : undefined}
    >
      <div className="cb-head">
        {/* Paths and commands read as code; plain labels stay in the interface face. */}
        <span className={`cb-label truncate ${title && /[\/.:]/.test(title) ? 'cb-title' : ''}`}>{title ?? langLabel(lang)}</span>
        {canPreview && (
          <button type="button" className="cb-toggle" aria-pressed={showPreview} onClick={() => setPreview((p) => !p)}>
            {showPreview ? 'Code' : 'Preview'}
          </button>
        )}
        <span className="cb-actions">
          {actions}
          {!showPreview && (
            <LazyTip label={wrapped ? 'Stop wrapping lines' : 'Wrap lines'} side="top">
              <button type="button" className="icon-btn cb-btn" aria-label="Wrap lines" aria-pressed={wrapped} data-active={wrapped || undefined} onClick={() => setWrapped((w) => !w)}>
                <Icon name="enter" size={13} />
              </button>
            </LazyTip>
          )}
          <CopyButton text={code} label="Copy code" size={13} className="cb-btn" />
        </span>
      </div>
      {showPreview ? (
        <div className="cb-preview">
          <WidgetFrame cacheKey={previewKey} code={text} final title={title ?? langLabel(lang)} />
        </div>
      ) : (
        <div className="cb-body hscroll" style={long ? { maxHeight: clipped ? maxHeight : wrapped ? undefined : full } : undefined}>
          <pre className="cb-pre">
            <code>{body}</code>
          </pre>
        </div>
      )}
      {long && !showPreview && (
        <button type="button" className="cb-more" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          {expanded ? 'Show less' : `Show all ${lineCount} lines`}
          <Icon name="caret-down" size={11} />
        </button>
      )}
    </div>
  );
});
