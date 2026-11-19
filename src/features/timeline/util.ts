import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { TimelineItem, ToolItem } from '@shared/protocol';

// One clock for every live figure in the conversation (the live line's time, each running step's
// seconds): one timer, and they all tick in the same frame instead of each on its own beat.
const ticking = new Set<() => void>();
let tickTimer = 0;
let tickNow = Date.now();
function subscribeTick(fn: () => void): () => void {
  if (!ticking.size) {
    tickNow = Date.now();
    tickTimer = window.setInterval(() => {
      tickNow = Date.now();
      for (const f of ticking) f();
    }, 1000);
  }
  ticking.add(fn);
  return () => {
    ticking.delete(fn);
    if (!ticking.size) {
      window.clearInterval(tickTimer);
      tickTimer = 0;
    }
  };
}
const still = () => () => {};
const readTick = () => tickNow;

/**
 * Holds each value on screen for at least `ms`: a burst of quick steps reads as a calm sequence of
 * titles instead of a flicker of them. The newest value always wins; nothing is ever more than `ms` late.
 */
export function useHeld<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const at = useRef(0);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const show = () => {
      at.current = performance.now();
      setShown(value);
    };
    const wait = at.current + ms - performance.now();
    if (wait <= 0) return show();
    const t = window.setTimeout(show, wait);
    return () => window.clearTimeout(t);
  }, [value, shown, ms]);
  return shown;
}

/** The current time, refreshed once a second while `active`, on the conversation's one shared timer. */
export function useTick(active = true): number {
  return useSyncExternalStore(active ? subscribeTick : still, readTick);
}

/**
 * A reasoning summary's own heading ("**Checking the store**", as Codex writes them): what the
 * thinking is about, in plain words, for the live line. The newest heading wins; none, empty.
 */
export function thinkingHeadline(text: string): string {
  const tail = text.length > 3000 ? text.slice(-3000) : text;
  const re = /(?:^|\n)\s*\*\*([^*\n]{3,80})\*\*\s*(?:\n|$)/g;
  let last = '';
  for (let m = re.exec(tail); m; m = re.exec(tail)) last = m[1].trim();
  return last;
}

/** "8s", "1m 12s": whole seconds, for labels like "Thought for 8s". */
export function shortDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// English day and month names with the computer's own clock style, as the shell writes dates
// (features/usage/format.ts, lib/format.ts): a German system must not put "Nov." or "Sa" into English copy.
const DATE_LOCALE = 'en-GB';
const HOUR12 = (() => {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 ?? false;
  } catch {
    return false;
  }
})();
const TIME = new Intl.DateTimeFormat(DATE_LOCALE, { hour: '2-digit', minute: '2-digit', hour12: HOUR12 });
const DAY = new Intl.DateTimeFormat(DATE_LOCALE, { month: 'short', day: 'numeric' });
const DAY_YEAR = new Intl.DateTimeFormat(DATE_LOCALE, { year: 'numeric', month: 'short', day: 'numeric' });

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
