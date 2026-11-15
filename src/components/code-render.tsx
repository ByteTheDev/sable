import type { CSSProperties, ReactNode } from 'react';
import type { HlToken } from '@/lib/highlight';
import type { Range } from '@/lib/word-diff';

function styleOf(t: HlToken): CSSProperties | undefined {
  if (!t.color && !t.style) return undefined;
  const s: CSSProperties = {};
  if (t.color) s.color = t.color;
  if (t.style) {
    if (t.style & 1) s.fontStyle = 'italic';
    if (t.style & 2) s.fontWeight = 700;
    if (t.style & 4) s.textDecoration = 'underline';
  }
  return s;
}

/** One line of highlighted tokens as spans. Uncoloured runs stay bare text nodes. */
export function hlLine(tokens: HlToken[]): ReactNode[] {
  return tokens.map((t, i) => {
    const style = styleOf(t);
    return style ? (
      <span key={i} style={style}>
        {t.content}
      </span>
    ) : (
      t.content
    );
  });
}

/**
 * A line with character ranges marked (word-level diff), on top of syntax tokens when
 * there are any. Tokens are split where a range starts or ends.
 */
export function markedLine(text: string, tokens: HlToken[] | undefined, ranges: Range[] | undefined, markClass: string): ReactNode {
  if (!ranges?.length) return tokens ? hlLine(tokens) : text;
  const toks: HlToken[] = tokens ?? [{ content: text }];
  const out: ReactNode[] = [];
  let pos = 0;
  let r = 0;
  let group: ReactNode[] | null = null;
  let key = 0;
  const flush = () => {
    if (group) {
      out.push(
        <mark key={`m${key++}`} className={markClass}>
          {group}
        </mark>,
      );
      group = null;
    }
  };
  const emit = (t: HlToken, content: string, inside: boolean) => {
    if (!content) return;
    const style = styleOf(t);
    const node = style ? (
      <span key={key++} style={style}>
        {content}
      </span>
    ) : (
      content
    );
    if (inside) (group ??= []).push(node);
    else {
      flush();
      out.push(node);
    }
  };
  for (const t of toks) {
    let rest = t.content;
    while (rest) {
      while (r < ranges.length && ranges[r][1] <= pos) {
        r++;
        flush();
      }
      const cur = ranges[r];
      if (!cur) {
        emit(t, rest, false);
        pos += rest.length;
        break;
      }
      if (pos < cur[0]) {
        const take = Math.min(rest.length, cur[0] - pos);
        emit(t, rest.slice(0, take), false);
        rest = rest.slice(take);
        pos += take;
      } else {
        const take = Math.min(rest.length, cur[1] - pos);
        emit(t, rest.slice(0, take), true);
        rest = rest.slice(take);
        pos += take;
      }
    }
  }
  flush();
  return out;
}
