import type { ReviewComment, ReviewLine, Reviews } from './model';

/*
 * How a chat's pending review is written to storage and read back (keep.ts does the keeping):
 * within limits, and anything malformed is dropped rather than trusted.
 */

const MAX_PER_SESSION = 200;
const MAX_TEXT = 20_000;
const MAX_LINES = 2_000;

const isLine = (v: unknown): v is ReviewLine => {
  const l = v as ReviewLine;
  return (
    !!l &&
    typeof l === 'object' &&
    (l.t === ' ' || l.t === '+' || l.t === '-') &&
    typeof l.text === 'string' &&
    (l.old === undefined || typeof l.old === 'number') &&
    (l.neu === undefined || typeof l.neu === 'number')
  );
};

const isComment = (v: unknown): v is ReviewComment => {
  const c = v as ReviewComment;
  return (
    !!c &&
    typeof c === 'object' &&
    typeof c.id === 'string' &&
    typeof c.scope === 'string' &&
    typeof c.path === 'string' &&
    typeof c.text === 'string' &&
    !!c.text.trim() &&
    c.text.length <= MAX_TEXT &&
    typeof c.at === 'number' &&
    Array.isArray(c.lines) &&
    c.lines.length > 0 &&
    c.lines.length <= MAX_LINES &&
    c.lines.every(isLine)
  );
};

/** The reviews worth keeping, as text: sessions with comments, each within limits. */
export function packReviews(r: Reviews): string {
  const out: Reviews = {};
  for (const [id, list] of Object.entries(r)) {
    const keep = list.filter(isComment).slice(-MAX_PER_SESSION);
    if (keep.length) out[id] = keep;
  }
  return JSON.stringify(out);
}

/** Reviews read back from storage; anything malformed is dropped. */
export function unpackReviews(raw: string | null): Reviews {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Reviews = {};
    for (const [id, list] of Object.entries(v as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const keep = list.filter(isComment).slice(-MAX_PER_SESSION);
      if (keep.length) out[id] = keep;
    }
    return out;
  } catch {
    return {};
  }
}
