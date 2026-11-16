/**
 * Reading a widget out of a tool call while its input still streams in, and preparing code for
 * the frame. Pure functions: tested in tests/genui.test.ts.
 */

/** Code larger than this is cut (a frame is not the place for a megabyte of markup). */
export const MAX_CODE = 300_000;

export interface PartialField {
  value: string;
  /** The closing quote has arrived. */
  complete: boolean;
}

const ESC: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * Decodes the JSON string that starts right after the opening quote at `start`. Stops cleanly at
 * the end of the text, before an escape that has not fully arrived.
 */
function readString(json: string, start: number): { value: string; end: number; complete: boolean } {
  let out = '';
  let i = start;
  for (;;) {
    let j = i;
    // Copy the run up to the next quote or backslash in one slice.
    while (j < json.length) {
      const c = json.charCodeAt(j);
      if (c === 34 || c === 92) break;
      j++;
    }
    out += json.slice(i, j);
    if (j >= json.length) return { value: out, end: j, complete: false };
    if (json.charCodeAt(j) === 34) return { value: out, end: j + 1, complete: true };
    // A backslash.
    const n = json[j + 1];
    if (n === undefined) return { value: out, end: j, complete: false };
    if (n === 'u') {
      const hex = json.slice(j + 2, j + 6);
      if (hex.length < 4) return { value: out, end: j, complete: false };
      const code = parseInt(hex, 16);
      if (Number.isNaN(code)) {
        i = j + 6;
        continue;
      }
      // A high surrogate waits for its pair.
      if (code >= 0xd800 && code <= 0xdbff) {
        if (json.length < j + 12) return { value: out, end: j, complete: false };
        if (json.slice(j + 6, j + 8) === '\\u') {
          const low = parseInt(json.slice(j + 8, j + 12), 16);
          if (low >= 0xdc00 && low <= 0xdfff) {
            out += String.fromCharCode(code, low);
            i = j + 12;
            continue;
          }
        }
      }
      out += String.fromCharCode(code);
      i = j + 6;
      continue;
    }
    out += ESC[n] ?? n;
    i = j + 2;
  }
}

function skipWs(json: string, i: number): number {
  while (i < json.length && (json[i] === ' ' || json[i] === '\n' || json[i] === '\r' || json[i] === '\t')) i++;
  return i;
}

/** Skips a non-string JSON value (number, literal, object, array). Returns -1 if it has not ended yet. */
function skipValue(json: string, i: number): number {
  let depth = 0;
  while (i < json.length) {
    const c = json[i];
    if (c === '"') {
      const s = readString(json, i + 1);
      if (!s.complete) return -1;
      i = s.end;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (depth === 0) return i;
      depth--;
      if (depth === 0) return i + 1;
    } else if (c === ',' && depth === 0) return i;
    i++;
  }
  return -1;
}

/**
 * The top-level string fields of a JSON object that may still be arriving: `{"title":"Rev`
 * gives `{ title: { value: 'Rev', complete: false } }`. Non-string values are skipped.
 */
export function readPartialObject(json: string | undefined): Record<string, PartialField> {
  const out: Record<string, PartialField> = {};
  if (!json) return out;
  let i = skipWs(json, 0);
  if (json[i] !== '{') return out;
  i++;
  for (;;) {
    i = skipWs(json, i);
    if (json[i] === ',') i = skipWs(json, i + 1);
    if (i >= json.length || json[i] === '}') return out;
    if (json[i] !== '"') return out;
    const key = readString(json, i + 1);
    if (!key.complete) return out;
    i = skipWs(json, key.end);
    if (json[i] !== ':') return out;
    i = skipWs(json, i + 1);
    if (i >= json.length) return out;
    if (json[i] === '"') {
      const v = readString(json, i + 1);
      out[key.value] = { value: v.value, complete: v.complete };
      if (!v.complete) return out;
      i = v.end;
    } else {
      const end = skipValue(json, i);
      if (end < 0) return out;
      i = end;
    }
  }
}

export interface WidgetSource {
  title: string;
  code: string;
  /** The whole input has arrived: scripts may run. */
  final: boolean;
}

/** The widget a `show_widget` tool item describes, complete or still streaming. */
export function widgetSource(input: unknown, inputText: string | undefined, fallbackTitle = ''): WidgetSource {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const code = typeof o.code === 'string' ? o.code : typeof o.html === 'string' ? o.html : typeof o.svg === 'string' ? o.svg : '';
    return { title: typeof o.title === 'string' ? o.title : fallbackTitle, code, final: true };
  }
  const p = readPartialObject(inputText);
  const code = p.code ?? p.html ?? p.svg;
  return { title: p.title?.value ?? fallbackTitle, code: code?.value ?? '', final: false };
}

/**
 * What the frame is given. A partial render loses an unfinished tag at the end and an unclosed
 * script (it would never run anyway: partial renders run nothing). Everything is capped.
 */
export function prepareCode(code: string, final: boolean): string {
  let out = code.length > MAX_CODE ? code.slice(0, MAX_CODE) : code;
  if (final) return out;
  const lt = out.lastIndexOf('<');
  if (lt > out.lastIndexOf('>')) out = out.slice(0, lt);
  const script = out.toLowerCase().lastIndexOf('<script');
  if (script >= 0 && out.toLowerCase().indexOf('</script>', script) < 0) out = out.slice(0, script);
  // An entity cut in half shows as stray text for a moment.
  const amp = out.lastIndexOf('&');
  if (amp >= 0 && amp > out.length - 10 && !out.slice(amp).includes(';')) out = out.slice(0, amp);
  return out;
}

/** Whether partial markup already has something to look at (a closed element outside style and script). */
export function hasVisibleMarkup(code: string): boolean {
  const stripped = code.replace(/<style[\s\S]*?(<\/style>|$)/gi, '').replace(/<script[\s\S]*?(<\/script>|$)/gi, '');
  return /<\/(?!style|script)[a-z][\w-]*\s*>|\/>/i.test(stripped);
}

/** A short title for a widget that has none: its first heading or <title>, else a plain word. */
export function guessTitle(code: string): string {
  const m = code.match(/<(h[1-3]|title)\b[^>]*>([\s\S]*?)<\/\1>/i) ?? code.match(/<svg\b[^>]*aria-label="([^"]+)"/i);
  const raw = m ? (m.length > 2 ? m[2] : m[1]) : '';
  const text = raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 60 ? text.slice(0, 58) + '…' : text;
  return /^\s*(<\?xml[^>]*>\s*)?<svg\b/i.test(code) ? 'Diagram' : 'Widget';
}

/** Is this code a standalone SVG image (saved as .svg rather than .html)? */
export function isSvg(code: string): boolean {
  return /^\s*(<\?xml[^>]*>\s*)?<svg\b[\s\S]*<\/svg>\s*$/i.test(code);
}

/** A small stable hash for keys (fenced widgets have no item id). */
export function hashCode(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** A file name from a title: "Revenue by quarter" → "revenue-by-quarter". */
export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'widget'
  );
}
