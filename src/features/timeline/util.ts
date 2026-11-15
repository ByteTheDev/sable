import type { TimelineItem, ToolItem } from '@shared/protocol';

/** "8s", "1m 12s": whole seconds, for labels like "Thought for 8s". */
export function shortDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const DAY_YEAR = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** When something was said: the time for today, a date and the time for earlier days. */
export function stampParts(ts: number, now = Date.now()): { day: string; time: string } {
  const d = new Date(ts);
  const n = new Date(now);
  const time = TIME.format(d);
  if (d.toDateString() === n.toDateString()) return { day: '', time };
  return { day: (d.getFullYear() === n.getFullYear() ? DAY : DAY_YEAR).format(d), time };
}

/** Reads a string value out of JSON that is still being typed (a tool's streaming input). */
export function partialJsonString(json: string | undefined, key: string): string | undefined {
  if (!json) return undefined;
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!m) return undefined;
  let out = '';
  for (let i = m.index + m[0].length; i < json.length; i++) {
    const ch = json[i];
    if (ch === '"') break;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const n = json[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '';
    else if (n === 'b' || n === 'f') out += ' ';
    else if (n === 'u') {
      const hex = json.slice(i + 1, i + 5);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += n;
  }
  return out;
}

export function prettyJson(value: unknown): string {
  if (typeof value === 'string') {
    const t = value.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

export const looksJson = (text: string) => /^\s*[[{]/.test(text) && /[\]}]\s*$/.test(text);

export const isActive = (item: ToolItem) => item.status === 'pending' || item.status === 'running';

const EXPLORE_KINDS = new Set(['read', 'search', 'glob', 'fetch']);

/** Tools that only look at things, and went fine: candidates for folding into one "Explored" row. */
export function isExplore(item: TimelineItem | undefined): boolean {
  return !!item && item.type === 'tool' && EXPLORE_KINDS.has(item.kind) && (item.status === 'done' || item.status === 'running' || item.status === 'pending');
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}
