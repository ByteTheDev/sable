import type { FileDiff } from '@shared/protocol';
import { wordDiff, type Range } from '@desk/lib/word-diff';
import { hunksOf, type DiffRowLike } from '@desk/features/review/model';

/**
 * A diff as rows, the way the desktop's DiffView builds them (components/DiffView.tsx `build`):
 * each line with its number before and after the change, the gaps between hunks as rows of their
 * own, and in a removed line and the added line that replaced it the words that changed. The rows
 * are what a review comment quotes (`linesOf` in the desktop's review model), so a comment written
 * on the phone names the same lines the desktop would.
 */

export interface LineRow {
  t: ' ' | '+' | '-';
  text: string;
  old?: number;
  neu?: number;
  /** The words that changed inside a paired line. */
  marks?: Range[];
}
export type DiffRow = LineRow | { t: 'sep'; text: string };

export interface DiffModel {
  rows: DiffRow[];
  /** Lines (not gaps). */
  lines: number;
  /** Digits of the largest line number. */
  digits: number;
}

export function diffRows(diff: FileDiff): DiffModel {
  const rows: DiffRow[] = [];
  let prevEnd = 1;
  let prevNewEnd = 1;
  let maxNo = 1;
  let lines = 0;
  // The gaps are counted in the numbers the gutter shows: the file after the change (before it, for a file that is gone).
  const byOld = diff.status === 'deleted';
  for (const h of diff.hunks) {
    const gap = h.oldStart - prevEnd;
    if (gap > 0 && h.oldLines > 0) {
      const [a, b] = byOld ? [prevEnd, h.oldStart - 1] : [prevNewEnd, Math.max(prevNewEnd, h.newStart - 1)];
      rows.push({ t: 'sep', text: a === b ? `Line ${a} unchanged` : `Lines ${a}–${b} unchanged` });
    }
    prevEnd = h.oldStart + h.oldLines;
    prevNewEnd = h.newStart + h.newLines;
    let o = h.oldStart;
    let n = h.newStart;
    const start = rows.length;
    for (const raw of h.lines) {
      const sign = raw[0];
      if (sign === '\\') continue;
      const text = raw.slice(1);
      if (sign === '+') rows.push({ t: '+', text, neu: n++ });
      else if (sign === '-') rows.push({ t: '-', text, old: o++ });
      else rows.push({ t: ' ', text, old: o++, neu: n++ });
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
  return { rows, lines, digits: String(maxNo).length };
}

/** Each row's hunk for picking a range (a range never crosses a gap); without real numbers the gaps are not shown and it is one. */
export const hunkIndex = (rows: readonly DiffRowLike[], numbered: boolean) => (numbered ? hunksOf(rows) : rows.map((r) => (r.t === 'sep' ? -1 : 0)));

/** The number a row shows in the phone's one gutter: the line after the change, or before it for a removed line. */
export const rowNumber = (r: LineRow) => (r.t === '-' ? r.old : r.neu);
