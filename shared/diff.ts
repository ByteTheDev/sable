import type { DiffHunk, FileDiff } from './protocol';

/** Line-based diff (Myers, O(ND)) producing unified hunks. Small and dependency-free. */

type Op = { t: ' ' | '+' | '-'; line: string };

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Upper bound on stored trace entries (Int32) before falling back to "replace everything". */
const MAX_TRACE = 12_000_000;

function replaceAll(a: string[], b: string[]): Op[] {
  return [...a.map((line) => ({ t: '-' as const, line })), ...b.map((line) => ({ t: '+' as const, line }))];
}

function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  if (n === 0 || m === 0) return replaceAll(a, b);
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  // trace[d] holds v[-d..d] as it was *before* round d (only that window is ever read back).
  const trace: Int32Array[] = [];
  let stored = 0;
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    stored += 2 * d + 1;
    if (stored > MAX_TRACE) return replaceAll(a, b);
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d];
    const at = (k: number) => vv[k + d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: ' ', line: a[x - 1] });
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push({ t: '+', line: b[y - 1] });
      y--;
    } else {
      ops.push({ t: '-', line: a[x - 1] });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ t: ' ', line: a[x - 1] });
    x--;
    y--;
  }
  return ops.reverse();
}

/** Myers on the middle part only: common prefix/suffix are trimmed first (cheap and very effective). */
function diffOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  const lim = Math.min(a.length, b.length);
  while (pre < lim && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < lim - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const mid = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf));
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', line: a[i] });
  for (const op of mid) ops.push(op);
  for (let i = a.length - suf; i < a.length; i++) ops.push({ t: ' ', line: a[i] });
  return ops;
}

/**
 * Unified-diff hunks between two texts (CRLF and LF compare equal). Headers follow the git
 * convention: a zero-length range starts at the line *before* it (`@@ -0,0 +1,3 @@`).
 * Changes separated by at most 2*context unchanged lines share one hunk.
 */
export function diffLines(oldText: string, newText: string, context = 3, startLine = 1): DiffHunk[] {
  const ops = diffOps(splitLines(oldText), splitLines(newText));
  const total = ops.length;
  const ctx = Math.max(0, Math.floor(context));
  // oldAt[i] / newAt[i]: number of old / new lines consumed before ops[i].
  const oldAt = new Int32Array(total + 1);
  const newAt = new Int32Array(total + 1);
  for (let i = 0; i < total; i++) {
    oldAt[i + 1] = oldAt[i] + (ops[i].t === '+' ? 0 : 1);
    newAt[i + 1] = newAt[i] + (ops[i].t === '-' ? 0 : 1);
  }
  const hunks: DiffHunk[] = [];
  let prevEnd = 0;
  let i = 0;
  while (i < total) {
    if (ops[i].t === ' ') {
      i++;
      continue;
    }
    const start = Math.max(prevEnd, i - ctx);
    // Extend over changes, swallowing context gaps of at most 2*ctx lines.
    let end = i; // exclusive end of the last change op
    let j = i;
    while (j < total) {
      if (ops[j].t !== ' ') {
        end = ++j;
        continue;
      }
      let k = j;
      while (k < total && ops[k].t === ' ') k++;
      if (k >= total || k - j > 2 * ctx) break;
      j = k;
    }
    const stop = Math.min(total, end + ctx);
    const oldLines = oldAt[stop] - oldAt[start];
    const newLines = newAt[stop] - newAt[start];
    hunks.push({
      oldStart: startLine + oldAt[start] - (oldLines === 0 ? 1 : 0),
      oldLines,
      newStart: startLine + newAt[start] - (newLines === 0 ? 1 : 0),
      newLines,
      lines: ops.slice(start, stop).map((op) => op.t + op.line),
    });
    prevEnd = stop;
    i = stop;
  }
  return hunks;
}

export function countChanges(hunks: DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l[0] === '+') additions++;
      else if (l[0] === '-') deletions++;
    }
  }
  return { additions, deletions };
}

export function makeFileDiff(
  path: string,
  oldText: string | null,
  newText: string | null,
  opts: { startLine?: number; context?: number } = {},
): FileDiff {
  const hunks = diffLines(oldText ?? '', newText ?? '', opts.context ?? 3, opts.startLine ?? 1);
  const { additions, deletions } = countChanges(hunks);
  return {
    path,
    status: oldText === null ? 'added' : newText === null ? 'deleted' : 'modified',
    additions,
    deletions,
    hunks,
  };
}

/** Decodes a C-style quoted git path (`"a/t\303\251st\tx"`); returns unquoted input unchanged. */
function unquote(p: string): string {
  if (p.length < 2 || p[0] !== '"' || p[p.length - 1] !== '"') return p;
  const bytes: number[] = [];
  const esc: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const enc = new TextEncoder();
  for (let i = 1; i < p.length - 1; i++) {
    const c = p[i];
    if (c !== '\\') {
      for (const byte of enc.encode(c)) bytes.push(byte);
      continue;
    }
    const nx = p[++i];
    if (/[0-7]/.test(nx)) {
      const oct = p.slice(i, i + 3).match(/^[0-7]{1,3}/)![0];
      bytes.push(parseInt(oct, 8));
      i += oct.length - 1;
    } else bytes.push(esc[nx] ?? nx.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Strips a header path (`a/x`, `"b/x"`, `x\t<timestamp>`) down to the bare path. */
function headerPath(raw: string): string {
  let p = raw;
  if (p.startsWith('"')) {
    const m = p.match(/^"(?:[^"\\]|\\.)*"/);
    p = m ? unquote(m[0]) : p;
  } else p = p.replace(/\t.*$/, '');
  return p.replace(/^[ab]\//, '');
}

/** Paths from `diff --git a/X b/Y` (best effort; later headers override). */
function gitHeaderPaths(rest: string): { a: string; b: string } {
  if (rest.startsWith('"')) {
    const m = rest.match(/^("(?:[^"\\]|\\.)*")\s+(.+)$/);
    if (m) return { a: headerPath(m[1]), b: headerPath(m[2]) };
  }
  // Unquoted: same path on both sides is the common case, so split in the middle when that works.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === ' ') {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.slice(2) === b.slice(2)) return { a: headerPath(a), b: headerPath(b) };
  }
  const m = rest.match(/^(.+?) ("?b\/.+)$/);
  if (m) return { a: headerPath(m[1]), b: headerPath(m[2]) };
  return { a: rest, b: rest };
}

/** Parses `git diff` / unified patch text into file diffs. */
export function parseUnifiedDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let remOld = 0;
  let remNew = 0;
  let sawMinus = false; // a "--- " header was seen for `cur`
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const start = (path: string) => {
    cur = { path, status: 'modified', additions: 0, deletions: 0, hunks: [] };
    files.push(cur);
    hunk = null;
    remOld = remNew = 0;
    sawMinus = false;
    return cur;
  };
  for (const line of lines) {
    // Inside a hunk the header counts decide what a line is: "--- x" may be a removed "-- x".
    if (hunk && cur && (remOld > 0 || remNew > 0)) {
      const c = line[0];
      const h: DiffHunk = hunk;
      const f: FileDiff = cur;
      if (c === ' ' || line === '') {
        h.lines.push(' ' + line.slice(1));
        remOld--;
        remNew--;
        continue;
      }
      if (c === '-') {
        h.lines.push(line);
        f.deletions++;
        remOld--;
        continue;
      }
      if (c === '+') {
        h.lines.push(line);
        f.additions++;
        remNew--;
        continue;
      }
      if (c === '\\') continue; // "\ No newline at end of file"
      hunk = null; // malformed / truncated hunk: fall through and treat as a header line
    }
    if (line.startsWith('diff --git ')) {
      const { b } = gitHeaderPaths(line.slice(11));
      start(b);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/\t.*$/, '');
      const isMinus = line.startsWith('--- ');
      let f: FileDiff = cur ?? start('');
      if (isMinus && (sawMinus || f.hunks.length > 0)) f = start('');
      if (isMinus) {
        sawMinus = true;
        if (target === '/dev/null') f.status = 'added';
        else if (!f.path) f.path = headerPath(line.slice(4));
      } else if (target === '/dev/null') f.status = 'deleted';
      else f.path = headerPath(line.slice(4));
      continue;
    }
    // Bare hunks with no file header (Codex sends these for updates) belong to one unnamed file.
    if (!cur && line.startsWith('@@ ')) start('');
    if (!cur) continue;
    const f: FileDiff = cur;
    if (line.startsWith('new file mode')) f.status = 'added';
    else if (line.startsWith('deleted file mode')) f.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      f.oldPath = unquote(line.slice(12));
      f.status = 'renamed';
    } else if (line.startsWith('rename to ')) f.path = unquote(line.slice(10));
    else if (line.startsWith('copy from ')) {
      f.oldPath = unquote(line.slice(10));
      f.status = 'added';
    } else if (line.startsWith('copy to ')) f.path = unquote(line.slice(8));
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') f.binary = true;
    else if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const h: DiffHunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunk = h;
      remOld = h.oldLines;
      remNew = h.newLines;
      f.hunks.push(h);
    }
  }
  return files;
}
