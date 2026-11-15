import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiffHunk } from '@shared/protocol';
import { countChanges, diffLines, makeFileDiff, parseUnifiedDiff } from '../shared/diff';

// ───────────────────────────── helpers ─────────────────────────────

function lines(text: string): string[] {
  if (text === '') return [];
  const l = text.replace(/\r\n/g, '\n').split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

/**
 * Applies unified hunks to `oldText` strictly: every header must agree with its lines,
 * context/removed lines must match the old text, and hunks must be ordered and disjoint.
 */
function applyHunks(oldText: string, hunks: DiffHunk[]): string[] {
  const src = lines(oldText);
  const out: string[] = [];
  let pos = 0; // 0-based index into src
  let delta = 0; // newStart - oldStart drift so far
  for (const h of hunks) {
    let o = 0;
    let n = 0;
    for (const l of h.lines) {
      if (l[0] === ' ') (o++, n++);
      else if (l[0] === '-') o++;
      else if (l[0] === '+') n++;
      else throw new Error(`bad line prefix: ${JSON.stringify(l)}`);
    }
    expect(o, 'oldLines matches body').toBe(h.oldLines);
    expect(n, 'newLines matches body').toBe(h.newLines);
    // Unified convention: a zero-length range points at the line *before* it.
    const oldIdx = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    const newIdx = h.newLines === 0 ? h.newStart : h.newStart - 1;
    expect(oldIdx, 'hunks are ordered and disjoint').toBeGreaterThanOrEqual(pos);
    expect(newIdx - oldIdx, 'newStart consistent with earlier hunks').toBe(delta);
    while (pos < oldIdx) out.push(src[pos++]);
    for (const l of h.lines) {
      const body = l.slice(1);
      if (l[0] === ' ') {
        expect(src[pos], `context at old line ${pos + 1}`).toBe(body);
        out.push(body);
        pos++;
      } else if (l[0] === '-') {
        expect(src[pos], `removal at old line ${pos + 1}`).toBe(body);
        pos++;
      } else out.push(body);
    }
    delta += h.newLines - h.oldLines;
  }
  while (pos < src.length) out.push(src[pos++]);
  return out;
}

function roundTrip(a: string, b: string, context = 3) {
  const hunks = diffLines(a, b, context);
  expect(applyHunks(a, hunks)).toEqual(lines(b));
  return hunks;
}

const num = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${i + from}`);
const text = (arr: string[]) => arr.join('\n') + '\n';

// ───────────────────────────── diffLines ─────────────────────────────

describe('diffLines', () => {
  it('returns no hunks for identical text', () => {
    expect(diffLines('a\nb\n', 'a\nb\n')).toEqual([]);
    expect(diffLines('', '')).toEqual([]);
  });

  it('single change in the middle has exact headers and 3 lines of context', () => {
    const a = num(10);
    const b = [...a];
    b[4] = 'changed';
    const hunks = roundTrip(text(a), text(b));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 2, oldLines: 7, newStart: 2, newLines: 7 });
    expect(hunks[0].lines).toEqual([
      ' line 2',
      ' line 3',
      ' line 4',
      '-line 5',
      '+changed',
      ' line 6',
      ' line 7',
      ' line 8',
    ]);
  });

  it('clips context at file start and end', () => {
    const a = num(4);
    const first = roundTrip(text(a), text(['X', ...a.slice(1)]));
    expect(first[0]).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4 });
    const last = roundTrip(text(a), text([...a.slice(0, 3), 'Y']));
    expect(last[0]).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4 });
  });

  it('splits far-apart changes into multiple hunks', () => {
    const a = num(30);
    const b = [...a];
    b[2] = 'A';
    b[25] = 'B';
    const hunks = roundTrip(text(a), text(b));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 6, newStart: 1, newLines: 6 });
    expect(hunks[1]).toMatchObject({ oldStart: 23, oldLines: 7, newStart: 23, newLines: 7 });
  });

  it('merges changes whose gap is <= 2*context and splits at 2*context+1', () => {
    const a = num(40);
    const merged = [...a];
    merged[10] = 'A';
    merged[17] = 'B'; // gap of 6 unchanged lines
    expect(roundTrip(text(a), text(merged))).toHaveLength(1);
    const split = [...a];
    split[10] = 'A';
    split[18] = 'B'; // gap of 7 unchanged lines
    const hunks = roundTrip(text(a), text(split));
    expect(hunks).toHaveLength(2);
    expect(hunks[0].oldStart + hunks[0].oldLines).toBeLessThanOrEqual(hunks[1].oldStart);
  });

  it('adjacent changes form one hunk', () => {
    const a = num(10);
    const b = [...a];
    b[4] = 'x';
    b[5] = 'y';
    const hunks = roundTrip(text(a), text(b));
    expect(hunks).toHaveLength(1);
    expect(countChanges(hunks)).toEqual({ additions: 2, deletions: 2 });
  });

  it('handles empty old text (all additions) with a 0,0 old range', () => {
    const hunks = roundTrip('', 'a\nb\nc\n');
    expect(hunks).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ['+a', '+b', '+c'] }]);
  });

  it('handles empty new text (all deletions) with a 0,0 new range', () => {
    const hunks = roundTrip('a\nb\n', '');
    expect(hunks).toEqual([{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ['-a', '-b'] }]);
  });

  it('pure insertion without context points at the preceding line (git convention)', () => {
    const a = num(5);
    const b = [...a.slice(0, 3), 'new1', 'new2', ...a.slice(3)];
    const hunks = roundTrip(text(a), text(b), 0);
    expect(hunks).toEqual([{ oldStart: 3, oldLines: 0, newStart: 4, newLines: 2, lines: ['+new1', '+new2'] }]);
    const del = roundTrip(text(a), text([...a.slice(0, 2), ...a.slice(3)]), 0);
    expect(del).toEqual([{ oldStart: 3, oldLines: 1, newStart: 2, newLines: 0, lines: ['-line 3'] }]);
  });

  it('treats CRLF and LF as equal and strips CR from output lines', () => {
    expect(diffLines('a\r\nb\r\n', 'a\nb\n')).toEqual([]);
    const hunks = roundTrip('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n');
    expect(hunks[0].lines).toEqual([' a', '-b', '+B', ' c']);
  });

  it('honours startLine offsets', () => {
    const hunks = diffLines('a\nb\n', 'a\nc\n', 3, 41);
    expect(hunks[0]).toMatchObject({ oldStart: 41, newStart: 41, oldLines: 2, newLines: 2 });
  });

  it('round-trips randomized edits', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let iter = 0; iter < 200; iter++) {
      const a = Array.from({ length: Math.floor(rnd() * 40) }, () => String.fromCharCode(97 + Math.floor(rnd() * 5)));
      const b: string[] = [];
      for (const l of a) {
        const r = rnd();
        if (r < 0.15) continue;
        if (r < 0.3) b.push('z' + Math.floor(rnd() * 3));
        else b.push(l);
        if (rnd() < 0.1) b.push('n' + Math.floor(rnd() * 3));
      }
      const ctx = Math.floor(rnd() * 4);
      roundTrip(a.length ? text(a) : '', b.length ? text(b) : '', ctx);
    }
  });

  it('stays fast and correct on large files with few changes', () => {
    const a = num(20_000);
    const b = [...a];
    b[100] = 'x';
    b[19_900] = 'y';
    const t = Date.now();
    const hunks = roundTrip(text(a), text(b));
    expect(hunks).toHaveLength(2);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('makeFileDiff reports status and counts', () => {
    expect(makeFileDiff('f', null, 'a\n')).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
    expect(makeFileDiff('f', 'a\n', null)).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 });
    expect(makeFileDiff('f', 'a\n', 'b\n')).toMatchObject({ status: 'modified', additions: 1, deletions: 1 });
  });
});

// ───────────────────────────── parseUnifiedDiff ─────────────────────────────

describe('parseUnifiedDiff (synthetic)', () => {
  it('does not mistake removed "-- x" / added "++ x" lines for file headers', () => {
    const patch = [
      'diff --git a/q.sql b/q.sql',
      'index 111..222 100644',
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1,2 +1,2 @@',
      '--- old comment',
      '+++ new comment',
      ' select 1;',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'q.sql', additions: 1, deletions: 1 });
    expect(files[0].hunks[0].lines).toEqual(['--- old comment', '+++ new comment', ' select 1;']);
  });

  it('parses plain unified diffs (no diff --git line) with several files', () => {
    const patch = [
      '--- a/one.txt\t2024-01-01',
      '+++ b/one.txt\t2024-01-02',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -1,0 +1,1 @@',
      '+c',
    ].join('\n');
    const files = parseUnifiedDiff(patch);
    expect(files.map((f) => f.path)).toEqual(['one.txt', 'two.txt']);
    expect(files[0].hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
  });

  it('accepts blank context lines without the leading space and CRLF patches', () => {
    const patch = 'diff --git a/x b/x\r\n--- a/x\r\n+++ b/x\r\n@@ -1,3 +1,3 @@\r\n a\r\n\r\n-b\r\n+c\r\n';
    const [f] = parseUnifiedDiff(patch);
    expect(f.hunks[0].lines).toEqual([' a', ' ', '-b', '+c']);
  });

  it('handles paths with spaces and quoted paths', () => {
    const patch = [
      'diff --git a/my file.txt b/my file.txt',
      'new file mode 100644',
      'index 0000000..1111111',
      'Binary files /dev/null and b/my file.txt differ',
      'diff --git "a/tab\\there.txt" "b/tab\\there.txt"',
      'deleted file mode 100644',
      '--- "a/tab\\there.txt"',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
    ].join('\n');
    const files = parseUnifiedDiff(patch);
    expect(files[0]).toMatchObject({ path: 'my file.txt', status: 'added', binary: true });
    expect(files[1]).toMatchObject({ path: 'tab\there.txt', status: 'deleted', deletions: 1 });
  });
});

// Real `git diff` output from a temp repository.
describe('parseUnifiedDiff (real git output)', () => {
  let dir = '';
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sable-diff-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(path.join(dir, 'keep.txt'), text(num(20)));
    writeFileSync(path.join(dir, 'gone.txt'), 'bye\nnow\n');
    writeFileSync(path.join(dir, 'old name.txt'), text(num(30, 100)));
    writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'sub', 'crlf.txt'), 'a\r\nb\r\nc\r\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    const k = num(20);
    k[1] = 'changed 2';
    k[15] = 'changed 16';
    writeFileSync(path.join(dir, 'keep.txt'), text(k));
    rmSync(path.join(dir, 'gone.txt'));
    git('mv', 'old name.txt', 'new name.txt');
    writeFileSync(path.join(dir, 'new name.txt'), text([...num(30, 100), 'appended']));
    writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 9, 9, 9, 0]));
    writeFileSync(path.join(dir, 'added.txt'), 'hello\nworld\n');
    writeFileSync(path.join(dir, 'sub', 'crlf.txt'), 'a\r\nB\r\nc\r\n');
    git('add', '-A');
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('parses added, deleted, renamed, binary and modified files', () => {
    const out = git('-c', 'core.quotePath=false', 'diff', '--cached', '-M', '--no-color', '--no-ext-diff');
    const files = parseUnifiedDiff(out);
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(Object.keys(by).sort()).toEqual(['added.txt', 'img.bin', 'keep.txt', 'new name.txt', 'sub/crlf.txt'].concat('gone.txt').sort());

    expect(by['added.txt']).toMatchObject({ status: 'added', additions: 2, deletions: 0 });
    expect(by['added.txt'].hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
    expect(by['gone.txt']).toMatchObject({ status: 'deleted', additions: 0, deletions: 2 });
    expect(by['new name.txt']).toMatchObject({ status: 'renamed', oldPath: 'old name.txt', additions: 1, deletions: 0 });
    expect(by['img.bin']).toMatchObject({ binary: true, hunks: [] });
    expect(by['keep.txt']).toMatchObject({ status: 'modified', additions: 2, deletions: 2 });
    expect(by['keep.txt'].hunks).toHaveLength(2);
    expect(by['sub/crlf.txt'].hunks[0].lines).toEqual([' a', '-b', '+B', ' c']);

    // Parsed hunks must be internally consistent (applyHunks validates the headers).
    expect(applyHunks(text(num(20)), by['keep.txt'].hunks)[1]).toBe('changed 2');
    expect(applyHunks('', by['added.txt'].hunks)).toEqual(['hello', 'world']);
  });

  it('agrees with diffLines on headers for the same change', () => {
    const out = git('diff', '--cached', '--no-color', '--', 'keep.txt');
    const [parsed] = parseUnifiedDiff(out);
    const k = num(20);
    k[1] = 'changed 2';
    k[15] = 'changed 16';
    const ours = diffLines(text(num(20)), text(k));
    expect(ours).toEqual(parsed.hunks);
  });
});
