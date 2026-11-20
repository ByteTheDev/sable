import { describe, expect, it } from 'vitest';
import {
  REVIEW_HEAD,
  addComment,
  clampToHunk,
  clearReview,
  editComment,
  hunksOf,
  linesOf,
  locate,
  orderComments,
  parseReview,
  pruneReviews,
  quoteLines,
  rangeLabel,
  removeComment,
  reviewMessage,
  type DiffRowLike,
  type ReviewComment,
  type Reviews,
} from '@/features/review/model';
import { packReviews, unpackReviews } from '@/features/review/persist';

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: 'c1',
  scope: 'git:src/a.ts',
  path: 'src/a.ts',
  lines: [{ t: '+', text: 'const a = 1;', neu: 12 }],
  text: 'Name this better.',
  at: 1,
  ...over,
});

// A diff as DiffView builds it: two hunks with a gap between.
const rows: DiffRowLike[] = [
  { t: ' ', text: 'import x;', old: 1, neu: 1 },
  { t: '-', text: 'let a = 1;', old: 2 },
  { t: '+', text: 'const a = 1;', neu: 2 },
  { t: ' ', text: '', old: 3, neu: 3 },
  { t: 'sep', text: 'Lines 4–9 unchanged' },
  { t: ' ', text: 'function f() {', old: 10, neu: 10 },
  { t: '+', text: '  return a;', neu: 11 },
  { t: ' ', text: '}', old: 11, neu: 12 },
];

describe('a chat’s pending review', () => {
  it('adds, edits and removes comments per session, leaving other sessions alone', () => {
    let r: Reviews = { other: [comment({ id: 'x' })] };
    r = addComment(r, 's1', comment());
    r = addComment(r, 's1', comment({ id: 'c2', text: 'And this.' }));
    expect(r.s1.map((c) => c.id)).toEqual(['c1', 'c2']);
    r = editComment(r, 's1', 'c1', 'Better words.');
    expect(r.s1[0].text).toBe('Better words.');
    r = removeComment(r, 's1', 'c2');
    expect(r.s1.map((c) => c.id)).toEqual(['c1']);
    expect(r.other).toHaveLength(1);
  });

  it('keeps the same object when nothing changes, and refuses empty comments', () => {
    const r: Reviews = { s1: [comment()] };
    expect(addComment(r, 's1', comment({ id: 'c3', text: '  ' }))).toBe(r);
    expect(addComment(r, 's1', comment({ id: 'c3', lines: [] }))).toBe(r);
    expect(editComment(r, 's1', 'nope', 'x')).toBe(r);
    expect(editComment(r, 's1', 'c1', 'Name this better.')).toBe(r);
    expect(removeComment(r, 's1', 'nope')).toBe(r);
    expect(clearReview(r, 'nobody')).toBe(r);
  });

  it('removes a comment edited down to nothing, and drops a session left without comments', () => {
    const r = editComment({ s1: [comment()] }, 's1', 'c1', '   ');
    expect(r).toEqual({});
  });

  it('clears what was sent and keeps what was added meanwhile', () => {
    const r: Reviews = { s1: [comment(), comment({ id: 'late' })] };
    expect(clearReview(r, 's1', new Set(['c1'])).s1.map((c) => c.id)).toEqual(['late']);
    expect(clearReview(r, 's1')).toEqual({});
  });

  it('drops the reviews of sessions that are gone', () => {
    const r: Reviews = { a: [comment()], b: [comment()] };
    expect(Object.keys(pruneReviews(r, (id) => id === 'a'))).toEqual(['a']);
    expect(pruneReviews(r, () => true)).toBe(r);
  });

  it('reads in file order (first commented first), then top to bottom', () => {
    const list = [
      comment({ id: '1', path: 'b.ts', at: 1, lines: [{ t: '+', text: 'x', neu: 30 }] }),
      comment({ id: '2', path: 'a.ts', at: 2, lines: [{ t: '+', text: 'y', neu: 5 }] }),
      comment({ id: '3', path: 'b.ts', at: 3, lines: [{ t: '+', text: 'z', neu: 4 }] }),
    ];
    expect(orderComments(list).map((c) => c.id)).toEqual(['3', '1', '2']);
  });
});

describe('lines in a diff', () => {
  it('names a range by the new numbers, or the old ones for removed lines only', () => {
    expect(rangeLabel([{ t: '+', text: '', neu: 12 }])).toBe('line 12');
    expect(rangeLabel([{ t: '-', text: '', old: 3 }, { t: '+', text: '', neu: 3 }, { t: ' ', text: '', old: 4, neu: 4 }])).toBe('lines 3–4');
    expect(rangeLabel([{ t: '-', text: '', old: 7 }, { t: '-', text: '', old: 8 }])).toBe('removed lines 7–8');
    expect(rangeLabel([{ t: '+', text: '' }])).toBeUndefined();
  });

  it('takes the picked rows without the gap, with numbers only when they are real', () => {
    expect(linesOf(rows, 1, 2, true)).toEqual([
      { t: '-', text: 'let a = 1;', old: 2 },
      { t: '+', text: 'const a = 1;', neu: 2 },
    ]);
    expect(linesOf(rows, 3, 5, false)).toEqual([
      { t: ' ', text: '' },
      { t: ' ', text: 'function f() {' },
    ]);
  });

  it('finds the lines again, by number first and by words when the numbers moved', () => {
    const lines = linesOf(rows, 5, 6, true);
    expect(locate(rows, lines)).toEqual([5, 6]);
    const moved = rows.map((r) => (r.t === 'sep' ? r : { ...r, old: r.old && r.old + 3, neu: r.neu && r.neu + 3 }));
    expect(locate(moved, lines)).toEqual([5, 6]);
    expect(locate(rows, [{ t: '+', text: 'gone' }])).toBeNull();
  });

  it('keeps a picked range inside one hunk', () => {
    const h = hunksOf(rows);
    expect(h).toEqual([0, 0, 0, 0, -1, 1, 1, 1]);
    expect(clampToHunk(h, 1, 7)).toBe(3);
    expect(clampToHunk(h, 6, 0)).toBe(5);
    expect(clampToHunk(h, 5, 7)).toBe(7);
  });
});

describe('the review message', () => {
  const a = comment({
    id: 'a',
    path: 'src/server/session.ts',
    at: 1,
    lines: [
      { t: '-', text: '  open(id) {', old: 26 },
      { t: '+', text: '  openSession(id: string) {', neu: 36 },
    ],
    text: 'Match the other exports.',
  });
  const b = comment({ id: 'b', path: 'src/app.ts', at: 2, lines: [{ t: ' ', text: 'const x = 1;', old: 40, neu: 40 }], text: 'Why is this here?\nIt was removed last week.' });

  it('lists every comment with its file, lines, quote and words', () => {
    expect(reviewMessage([b, a])).toBe(
      [
        REVIEW_HEAD,
        '',
        '1. src/server/session.ts, line 36',
        '```diff',
        '-  open(id) {',
        '+  openSession(id: string) {',
        '```',
        'Match the other exports.',
        '',
        '2. src/app.ts, line 40',
        '```diff',
        ' const x = 1;',
        '```',
        'Why is this here?',
        'It was removed last week.',
      ].join('\n'),
    );
  });

  it('puts what was typed in the composer first', () => {
    expect(reviewMessage([a], '  Two notes:  ').startsWith(`Two notes:\n\n${REVIEW_HEAD}\n\n1. `)).toBe(true);
  });

  it('quotes a long range by its first and last lines, and cuts very long lines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ t: '+' as const, text: `line ${i}`, neu: i + 1 }));
    expect(quoteLines(lines)).toEqual(['+line 0', '+line 1', '+line 2', '… 5 more lines', '+line 8', '+line 9']);
    const long = quoteLines([{ t: ' ', text: 'x'.repeat(500) }])[0];
    expect(long.length).toBe(201);
    expect(long.endsWith('…')).toBe(true);
  });

  it('fences quotes that hold backticks with a longer fence', () => {
    const md = comment({ lines: [{ t: '+', text: 'Run ```npm test``` first' }] });
    const text = reviewMessage([md]);
    expect(text).toContain('\n````diff\n+Run ```npm test``` first\n````\n');
    expect(parseReview(text)?.comments[0].quote).toEqual(['+Run ```npm test``` first']);
  });

  it('names no lines when the diff had no real numbers', () => {
    const text = reviewMessage([comment({ lines: [{ t: '+', text: 'x' }] })]);
    expect(text.split('\n')[2]).toBe('1. src/a.ts');
  });

  it('reads back as the comments for the timeline', () => {
    const parsed = parseReview(reviewMessage([a, b], 'Two notes:'));
    expect(parsed).toEqual({
      lead: 'Two notes:',
      comments: [
        { path: 'src/server/session.ts', range: 'line 36', text: 'Match the other exports.', quote: ['-  open(id) {', '+  openSession(id: string) {'] },
        { path: 'src/app.ts', range: 'line 40', text: 'Why is this here?\nIt was removed last week.', quote: [' const x = 1;'] },
      ],
    });
    const removed = parseReview(reviewMessage([comment({ path: 'a, b.ts', lines: [{ t: '-', text: 'x', old: 3 }, { t: '-', text: 'y', old: 4 }] })]));
    expect(removed?.comments[0]).toMatchObject({ path: 'a, b.ts', range: 'removed lines 3–4' });
  });

  it('leaves every other message alone', () => {
    expect(parseReview('Fix the tests')).toBeNull();
    expect(parseReview(`${REVIEW_HEAD}\nnothing after it`)).toBeNull();
    expect(parseReview(`Please read this:\n${REVIEW_HEAD} is what I would write`)).toBeNull();
    expect(parseReview(`${REVIEW_HEAD}\n\n1. a.ts\n\`\`\`diff\n+x`)).toBeNull();
  });
});

describe('a review kept across a restart', () => {
  it('round-trips through storage', () => {
    const r: Reviews = { s1: [comment(), comment({ id: 'c2', lines: [{ t: '-', text: 'gone', old: 4 }] })] };
    expect(unpackReviews(packReviews(r))).toEqual(r);
  });

  it('drops what is malformed instead of failing', () => {
    expect(unpackReviews(null)).toEqual({});
    expect(unpackReviews('not json')).toEqual({});
    expect(unpackReviews('[1]')).toEqual({});
    const raw = JSON.stringify({ s1: [comment(), { id: 3 }, comment({ id: 'bad', lines: [{ t: '?' as never, text: 'x' }] }), comment({ id: 'empty', text: ' ' })], s2: 'nope' });
    expect(unpackReviews(raw)).toEqual({ s1: [comment()] });
  });

  it('writes nothing for sessions without comments', () => {
    expect(packReviews({ s1: [] })).toBe('{}');
  });
});
