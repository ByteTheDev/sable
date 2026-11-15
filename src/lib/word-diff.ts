/** Word-level diff between a removed line and the added line that replaced it. */

export type Range = [start: number, end: number];

const TOKEN = /\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g;

function tokens(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

/** Merges touching ranges, and ranges separated only by whitespace, into one. */
function merge(ranges: Range[], text: string): Range[] {
  const out: Range[] = [];
  for (const r of ranges) {
    const prev = out[out.length - 1];
    if (prev && (r[0] <= prev[1] || !text.slice(prev[1], r[0]).trim())) prev[1] = r[1];
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * Character ranges that differ in each line. Returns null when the lines have too
 * little in common for inline marks to help (the whole line is the change).
 */
export function wordDiff(a: string, b: string): { a: Range[]; b: Range[] } | null {
  if (a === b || !a.trim() || !b.trim()) return null;
  const ta = tokens(a);
  const tb = tokens(b);
  let pre = 0;
  while (pre < ta.length && pre < tb.length && ta[pre] === tb[pre]) pre++;
  let endA = ta.length;
  let endB = tb.length;
  while (endA > pre && endB > pre && ta[endA - 1] === tb[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - pre;
  const m = endB - pre;
  const keepA = new Uint8Array(ta.length).fill(1, 0, pre).fill(1, endA);
  const keepB = new Uint8Array(tb.length).fill(1, 0, pre).fill(1, endB);
  if (n && m && n * m <= 160_000) {
    // LCS over the differing middle.
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = ta[pre + i] === tb[pre + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ta[pre + i] === tb[pre + j]) {
        // Shared whitespace between two changes is not a meaningful anchor.
        keepA[pre + i] = keepB[pre + j] = 1;
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else j++;
    }
  }
  const ranges = (toks: string[], keep: Uint8Array): [Range[], number, number] => {
    const out: Range[] = [];
    let pos = 0;
    let changed = 0;
    let total = 0;
    for (let k = 0; k < toks.length; k++) {
      const len = toks[k].length;
      const solid = toks[k].trim().length > 0;
      if (solid) total += len;
      if (!keep[k]) {
        out.push([pos, pos + len]);
        if (solid) changed += len;
      }
      pos += len;
    }
    return [out, changed, total];
  };
  const [ra, ca, la] = ranges(ta, keepA);
  const [rb, cb, lb] = ranges(tb, keepB);
  if (!ca && !cb) return null;
  // Mostly rewritten: marking nearly everything says nothing the line colour doesn't.
  if ((ca + cb) / Math.max(1, la + lb) > 0.62) return null;
  const trim = (rs: Range[], text: string) =>
    merge(rs, text)
      .map(([s, e]): Range => {
        while (s < e && /\s/.test(text[s])) s++;
        while (e > s && /\s/.test(text[e - 1])) e--;
        return [s, e];
      })
      .filter(([s, e]) => e > s);
  return { a: trim(ra, a), b: trim(rb, b) };
}
