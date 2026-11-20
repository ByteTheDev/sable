/**
 * Review comments on diffs: what one comment holds, the pure changes to a chat's pending review,
 * where a comment sits in a diff, and the one message a review becomes (and how the timeline reads
 * that message back). No store and no DOM here, so all of it is tested directly.
 */

export type LineSign = ' ' | '+' | '-';

/** One line of a diff as the comment quotes it. Numbers only when the diff showed real ones. */
export interface ReviewLine {
  t: LineSign;
  text: string;
  /** The line's number before the change (absent for an added line). */
  old?: number;
  /** The line's number after the change (absent for a removed line). */
  neu?: number;
}

export interface ReviewComment {
  id: string;
  /**
   * The diff it was written on: `git:<path>` (the Changes tab in a repository), `edits:<path>`
   * (the Changes tab outside one), `step:<itemId>:<n>` (the n-th diff of an edit step).
   */
  scope: string;
  /** The file, as the agent knows it (relative to the chat's folder where it can be). */
  path: string;
  /** The commented lines, first to last. */
  lines: ReviewLine[];
  text: string;
  /** When it was written (ms). */
  at: number;
}

/** Pending comments per session id. */
export type Reviews = Record<string, ReviewComment[]>;

/** A row of a diff as DiffView builds it: a line, or the gap between two hunks. */
export interface DiffRowLike {
  t: LineSign | 'sep';
  text: string;
  old?: number;
  neu?: number;
}

export const newCommentId = () => `rv${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// ───────────────────────────── a chat's pending review ─────────────────────────────

export function addComment(r: Reviews, sessionId: string, c: ReviewComment): Reviews {
  if (!c.text.trim() || !c.lines.length) return r;
  return { ...r, [sessionId]: [...(r[sessionId] ?? []).filter((x) => x.id !== c.id), c] };
}

/** New words for a comment; empty words remove it. */
export function editComment(r: Reviews, sessionId: string, id: string, text: string): Reviews {
  const list = r[sessionId];
  const cur = list?.find((c) => c.id === id);
  if (!cur || cur.text === text) return r;
  if (!text.trim()) return removeComment(r, sessionId, id);
  return { ...r, [sessionId]: list!.map((c) => (c.id === id ? { ...c, text } : c)) };
}

export function removeComment(r: Reviews, sessionId: string, id: string): Reviews {
  const list = r[sessionId];
  if (!list?.some((c) => c.id === id)) return r;
  return withList(r, sessionId, list.filter((c) => c.id !== id));
}

/** Drops the given comments (all of them without `ids`): after a send, or Discard. */
export function clearReview(r: Reviews, sessionId: string, ids?: ReadonlySet<string>): Reviews {
  const list = r[sessionId];
  if (!list) return r;
  const left = ids ? list.filter((c) => !ids.has(c.id)) : [];
  return left.length === list.length ? r : withList(r, sessionId, left);
}

/** Keeps only the sessions that still exist. */
export function pruneReviews(r: Reviews, alive: (sessionId: string) => boolean): Reviews {
  const gone = Object.keys(r).filter((id) => !alive(id));
  if (!gone.length) return r;
  const next = { ...r };
  for (const id of gone) delete next[id];
  return next;
}

function withList(r: Reviews, sessionId: string, list: ReviewComment[]): Reviews {
  const next = { ...r };
  if (list.length) next[sessionId] = list;
  else delete next[sessionId];
  return next;
}

/** The first line number a comment names, for ordering. */
const firstNumber = (c: ReviewComment) => {
  for (const l of c.lines) if (l.neu != null || l.old != null) return l.neu ?? l.old!;
  return Number.MAX_SAFE_INTEGER;
};

/** The order a review reads in: files in the order they were first commented on, lines top to bottom. */
export function orderComments(list: readonly ReviewComment[]): ReviewComment[] {
  const fileRank = new Map<string, number>();
  for (const c of [...list].sort((a, b) => a.at - b.at)) if (!fileRank.has(c.path)) fileRank.set(c.path, fileRank.size);
  return [...list].sort((a, b) => fileRank.get(a.path)! - fileRank.get(b.path)! || firstNumber(a) - firstNumber(b) || a.at - b.at);
}

// ───────────────────────────── lines ─────────────────────────────

/** "line 12", "lines 12–14", "removed lines 3–4"; nothing when the diff had no real numbers. */
export function rangeLabel(lines: readonly ReviewLine[]): string | undefined {
  const span = (ns: number[]) => {
    const a = Math.min(...ns);
    const b = Math.max(...ns);
    return a === b ? `line ${a}` : `lines ${a}–${b}`;
  };
  const neu = lines.flatMap((l) => (l.neu != null ? [l.neu] : []));
  if (neu.length) return span(neu);
  const old = lines.flatMap((l) => (l.old != null ? [l.old] : []));
  if (old.length) return `removed ${span(old)}`;
  return undefined;
}

/** The lines `a`..`b` of a diff's rows as a comment keeps them (gaps between hunks left out). */
export function linesOf(rows: readonly DiffRowLike[], a: number, b: number, numbered: boolean): ReviewLine[] {
  const out: ReviewLine[] = [];
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
    const r = rows[i];
    if (!r || r.t === 'sep') continue;
    const line: ReviewLine = { t: r.t, text: r.text };
    if (numbered && r.old != null) line.old = r.old;
    if (numbered && r.neu != null) line.neu = r.neu;
    out.push(line);
  }
  return out;
}

/**
 * Where a comment's lines are in a diff now: `[first, last]` row indexes. The same lines with the
 * same numbers first; failing that the same words in the same order (the file moved under them);
 * null when they are gone.
 */
export function locate(rows: readonly DiffRowLike[], lines: readonly ReviewLine[]): [number, number] | null {
  const n = lines.length;
  if (!n) return null;
  const same = (r: DiffRowLike | undefined, l: ReviewLine, numbers: boolean) =>
    !!r && r.t === l.t && r.text === l.text && (!numbers || ((l.old == null || r.old === l.old) && (l.neu == null || r.neu === l.neu)));
  for (const numbers of [true, false]) {
    outer: for (let s = 0; s + n <= rows.length; s++) {
      for (let k = 0; k < n; k++) if (!same(rows[s + k], lines[k], numbers)) continue outer;
      return [s, s + n - 1];
    }
  }
  return null;
}

/** Each row's hunk (rows between two gaps share one), so a picked range never crosses a gap. */
export function hunksOf(rows: readonly DiffRowLike[]): number[] {
  const out: number[] = [];
  let h = 0;
  for (const r of rows) {
    if (r.t === 'sep') {
      out.push(-1);
      h++;
    } else out.push(h);
  }
  return out;
}

/** `to` kept inside the hunk of `from`. */
export function clampToHunk(hunks: readonly number[], from: number, to: number): number {
  const h = hunks[from];
  let i = from;
  const step = to > from ? 1 : -1;
  while (i !== to && hunks[i + step] === h) i += step;
  return i;
}

// ───────────────────────────── the message ─────────────────────────────

export const REVIEW_HEAD = 'Review of your changes:';

/** Quoted lines per comment: all of a short range; the first and last few of a long one. */
const QUOTE_MAX = 6;
const QUOTE_HEAD = 3;
const QUOTE_TAIL = 2;
const QUOTE_WIDTH = 200;

const cut = (s: string) => (s.length > QUOTE_WIDTH ? s.slice(0, QUOTE_WIDTH - 1) + '…' : s);

/** A comment's lines in unified-diff form (`+`, `-`, space), shortened when long. */
export function quoteLines(lines: readonly ReviewLine[]): string[] {
  const fmt = (l: ReviewLine) => `${l.t}${cut(l.text)}`;
  if (lines.length <= QUOTE_MAX) return lines.map(fmt);
  const skipped = lines.length - QUOTE_HEAD - QUOTE_TAIL;
  return [...lines.slice(0, QUOTE_HEAD).map(fmt), `… ${skipped} more lines`, ...lines.slice(-QUOTE_TAIL).map(fmt)];
}

/** A fence longer than any run of backticks in the quote. */
function fenceFor(quote: readonly string[]): string {
  let longest = 0;
  for (const q of quote) for (const m of q.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The review as one message: what the person typed first, then "Review of your changes:" and per
 * comment its file and lines, the quoted lines and the comment.
 */
export function reviewMessage(comments: readonly ReviewComment[], lead = ''): string {
  const blocks = orderComments(comments).map((c, i) => {
    const range = rangeLabel(c.lines);
    const quote = quoteLines(c.lines);
    const fence = fenceFor(quote);
    return [`${i + 1}. ${c.path}${range ? `, ${range}` : ''}`, `${fence}diff`, ...quote, fence, c.text.trim()].join('\n');
  });
  const review = [REVIEW_HEAD, ...blocks].join('\n\n');
  return lead.trim() ? `${lead.trim()}\n\n${review}` : review;
}

export interface ParsedComment {
  path: string;
  range?: string;
  text: string;
  quote: string[];
}

export interface ParsedReview {
  /** What the person typed above the review. */
  lead: string;
  comments: ParsedComment[];
}

/** A message made by `reviewMessage`, read back for the timeline; null for any other message. */
export function parseReview(text: string): ParsedReview | null {
  let at: number;
  if (text.startsWith(REVIEW_HEAD)) at = 0;
  else {
    const i = text.indexOf(`\n\n${REVIEW_HEAD}\n`);
    if (i < 0) return null;
    at = i + 2;
  }
  const lead = text.slice(0, at).trim();
  const lines = text.slice(at + REVIEW_HEAD.length).split('\n');
  const fenceAt = (k: number) => /^(`{3,})diff$/.exec(lines[k] ?? '')?.[1];
  const isHead = (k: number) => /^\d+\. \S/.test(lines[k] ?? '') && !!fenceAt(k + 1);
  const comments: ParsedComment[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isHead(i)) {
      if (lines[i].trim() === '') {
        i++;
        continue;
      }
      return null;
    }
    const head = lines[i].replace(/^\d+\. /, '');
    const fence = fenceAt(i + 1)!;
    i += 2;
    const quote: string[] = [];
    while (i < lines.length && lines[i] !== fence) quote.push(lines[i++]);
    if (i >= lines.length) return null;
    i++;
    const body: string[] = [];
    while (i < lines.length && !isHead(i)) body.push(lines[i++]);
    const m = /^(.*), ((?:removed )?lines? \d+(?:–\d+)?)$/.exec(head);
    comments.push({ path: m ? m[1] : head, range: m?.[2], text: body.join('\n').trim(), quote });
  }
  return comments.length ? { lead, comments } : null;
}
