/** Minimal ANSI handling for command output: basic SGR colours become classes, everything else is dropped. */

export interface AnsiSpan {
  text: string;
  /** Space-separated classes: `a-red`, `a-bold`, `a-dim`… */
  cls?: string;
}

const ESC = '\u001b';
// CSI sequences, OSC sequences (terminated by BEL or ST) and lone two-byte escapes.
const ANY = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;

const COLORS = ['gray', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

/** Applies carriage returns the way a terminal would: the text after the last one wins the line. */
function applyCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text;
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n');
}

export function stripAnsi(text: string): string {
  const clean = applyCarriageReturns(text);
  return clean.includes(ESC) ? clean.replace(ANY, '') : clean;
}

export function parseAnsi(input: string): AnsiSpan[] {
  const text = applyCarriageReturns(input);
  if (!text.includes(ESC)) return text ? [{ text }] : [];
  const out: AnsiSpan[] = [];
  let fg: string | undefined;
  let bold = false;
  let dim = false;
  let italic = false;
  let last = 0;
  const push = (chunk: string) => {
    if (!chunk) return;
    const cls = [fg && `a-${fg}`, bold && 'a-bold', dim && 'a-dim', italic && 'a-italic'].filter(Boolean).join(' ') || undefined;
    const prev = out[out.length - 1];
    if (prev && prev.cls === cls) prev.text += chunk;
    else out.push({ text: chunk, cls });
  };
  ANY.lastIndex = 0;
  for (let m = ANY.exec(text); m; m = ANY.exec(text)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const seq = m[0];
    if (!seq.endsWith('m') || seq[1] !== '[') continue;
    const codes = seq.slice(2, -1).split(';').map((c) => (c === '' ? 0 : Number(c)));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        fg = undefined;
        bold = dim = italic = false;
      } else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 3) italic = true;
      else if (c === 22) bold = dim = false;
      else if (c === 23) italic = false;
      else if (c >= 30 && c <= 37) fg = COLORS[c - 30];
      else if (c >= 90 && c <= 97) fg = COLORS[c - 90];
      else if (c === 39) fg = undefined;
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0; // extended colours: skip
    }
  }
  push(text.slice(last));
  return out;
}
