/**
 * Markdown plumbing for streamed text: splitting into top-level blocks without
 * re-reading the settled part, and patching up the unfinished tail so half-arrived
 * syntax (an open fence, a table header, dangling emphasis) never flashes as literals.
 */
import { marked, type Token } from 'marked';

export interface MdBlock {
  raw: string;
  token: Token;
}

export interface LexState {
  text: string;
  /** Every top-level token, `space` included, so raw lengths add up to offsets in `text`. */
  blocks: MdBlock[];
}

/**
 * `breaks: true` keeps single newlines as line breaks (`br` tokens) inside paragraphs and
 * list items, as chat transcripts expect ("1\n2\n3"). Code, tables and headings are untouched.
 */
const lex = (src: string): MdBlock[] => marked.lexer(src, { gfm: true, breaks: true }).map((token) => ({ raw: token.raw, token }));

const closedFence = (raw: string) => /^ {0,3}(`{3,}|~{3,})/.test(raw) && /\n {0,3}(`{3,}|~{3,})[ \t]*\n*$/.test(raw);

/** Whether nothing arriving later can change how `blocks[i]` was read. */
function settled(blocks: MdBlock[], i: number): boolean {
  const t = blocks[i].token;
  const next = blocks[i + 1]?.token.type;
  if (next === undefined) return false;
  if (t.type === 'heading' || t.type === 'hr') return true;
  if (t.type === 'code') return closedFence(t.raw);
  if (t.type === 'paragraph' || t.type === 'table' || t.type === 'blockquote') return next === 'space' && i + 2 < blocks.length;
  return false;
}

/** Link reference definitions affect the whole document, so they rule out partial lexing. */
const REFERENCE = /(^|\n) {0,3}\[[^\]\n]+\]:/;

/**
 * Lexes `text`, reusing the blocks of `prev` that can no longer change. While text
 * streams in this keeps the cost per frame proportional to the tail, not the document.
 */
export function lexBlocks(prev: LexState | null, text: string): LexState {
  if (prev && prev.blocks.length > 2 && text.length >= prev.text.length && !REFERENCE.test(text)) {
    let keep = 0;
    for (let i = prev.blocks.length - 2; i >= 0; i--) {
      if (settled(prev.blocks, i)) {
        keep = i + 1;
        break;
      }
    }
    if (keep > 0) {
      let offset = 0;
      for (let i = 0; i < keep; i++) offset += prev.blocks[i].raw.length;
      if (offset <= prev.text.length && text.startsWith(prev.text.slice(0, offset))) {
        return { text, blocks: [...prev.blocks.slice(0, keep), ...lex(text.slice(offset))] };
      }
    }
  }
  return { text, blocks: lex(text) };
}

// ───────────────────────── repairing the streaming tail ─────────────────────────

/** A placeholder href for a link whose URL has not arrived yet. Rendered without navigation. */
export const PENDING_HREF = 'sable:pending';

function insideFence(text: string): boolean {
  const re = /^ {0,3}(`{3,}|~{3,})(.*)$/gm;
  let open: string | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!open) open = m[1];
    else if (m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = null;
  }
  return open !== null;
}

const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

/** Closes emphasis, code spans and links left open at the end of an unfinished line. */
function closeInline(line: string): string {
  let src = line;
  const stack: string[] = [];
  let i = 0;
  let lineStart = true;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      lineStart = false;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (src[i + run] === '`') run++;
      const ticks = '`'.repeat(run);
      const close = src.indexOf(ticks, i + run);
      if (close < 0) {
        // An unfinished code span: close it, or hide the opener until something follows.
        src = src.slice(i + run).trim() ? src + ticks : src.slice(0, i);
        break;
      }
      i = close + run;
      lineStart = false;
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 1;
      while (src[i + run] === ch) run++;
      const before = src[i - 1];
      const after = src[i + run];
      const atEnd = after === undefined;
      const bullet = lineStart && ch !== '~' && run === 1 && (after === ' ' || atEnd);
      const rule = lineStart && run >= 3 && atEnd;
      const intraword = ch === '_' && isWord(before) && isWord(after);
      if (!bullet && !rule && !intraword && !(ch === '~' && run !== 2)) {
        const canOpen = !atEnd && !/\s/.test(after);
        const canClose = before !== undefined && !/\s/.test(before);
        const marks = ch === '~' ? ['~~'] : run >= 3 ? [ch + ch, ch] : run === 2 ? [ch + ch] : [ch];
        const opened: string[] = [];
        for (const mark of marks) {
          const at = stack.lastIndexOf(mark);
          if (at >= 0 && canClose) stack.splice(at, 1);
          else if (canOpen || atEnd) opened.push(mark);
        }
        if (atEnd && opened.length) {
          // An opener (or half of a closer) with nothing after it: hide it for now.
          src = src.slice(0, i);
          break;
        }
        stack.push(...opened);
      }
      i += run;
      lineStart = false;
      continue;
    }
    if (ch !== ' ' && ch !== '\t' && ch !== '>' && !(lineStart && /[-+\d.)]/.test(ch))) lineStart = false;
    i++;
  }

  // Links render as links from the first frame; images wait until they are whole.
  const image = /!\[[^\]\n]*(\]\([^)\n]*)?$/.exec(src);
  if (image) src = src.slice(0, image.index);
  else {
    const link = /\[([^\]\n[]*)\]\([^)\s]*$/.exec(src) ?? /\[([^\]\n[]+)\]?$/.exec(src);
    if (link && link[1].trim() && !/^[ xX]$/.test(link[1]) && src[link.index - 1] !== '\\') {
      src = `${src.slice(0, link.index)}[${link[1]}](${PENDING_HREF})`;
    }
  }

  for (let k = stack.length - 1; k >= 0; k--) src += stack[k];
  return src;
}

const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Makes unfinished streamed markdown safe to render. Only the last block is touched,
 * so the result always extends what earlier frames rendered.
 */
export function repairTail(text: string): string {
  if (!text) return text;
  if (insideFence(text)) {
    // Half of the closing fence has arrived: keep it out of the code until it is whole.
    return text.replace(/\n {0,3}(`{1,2}|~{1,2})$/, '\n');
  }
  const cut = text.lastIndexOf('\n\n');
  const start = cut < 0 ? 0 : cut + 2;
  const head = text.slice(0, start);
  // The first backticks of an opening fence are not content.
  const tail = text.slice(start).replace(/(^|\n) {0,3}(`{1,2}|~{1,2})$/, '$1');
  if (!tail) return head;

  const lines = tail.split('\n');
  if (/^\s*\|/.test(lines[0])) {
    // A table needs its header and a finished delimiter row before it reads as one.
    if (lines.length === 1) return head;
    if (lines.length === 2 && /^[\s|:-]*$/.test(lines[1])) return head;
  }
  const last = lines.length - 1;
  const table = lines.length > 2 && DELIMITER_ROW.test(lines[1]);
  // A lone "|" would open an empty row; wait for its first cell.
  if (table && /^\s*\|?\s*$/.test(lines[last])) lines.pop();
  else lines[last] = closeInline(lines[last]);
  return head + lines.join('\n');
}
