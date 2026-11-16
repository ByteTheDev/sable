import { useEffect, useRef, useState } from 'react';
import { reducedMotion } from '@/lib/motion';

/** After the stream ends, the rest drains in about this long (ms), still flowing. */
const END_LAG_MS = 90;
/** How quickly the pace follows a change (ms): a burst speeds the flow up, never makes it jump. */
const ACCEL_MS = 120;
/** How quickly a backlog away from the target is worked off (ms). */
const CORRECT_MS = 320;
/** The buffer the reveal keeps, in arrival intervals: enough to bridge the gap to the next chunk. */
const BUFFER_INTERVALS = 1.25;
/** The buffer, whatever the network does (ms of text at the arrival rate). */
const MIN_BUFFER_MS = 50;
const MAX_BUFFER_MS = 420;
/** Never slower than this (characters per ms) while there is text to show. */
const MIN_RATE = 0.02;
/** Further behind than this (ms of text, plus a margin) and the reveal skips ahead: a reconnect, a huge paste. */
const MAX_BEHIND_MS = 1200;
const MAX_BEHIND_MARGIN = 240;
/** A word is shown whole if it ends within this many characters; longer runs grow in place. */
const WORD_AHEAD = 24;

/**
 * Evens out streamed text. Chunks arrive in bursts at uneven intervals; this reveals them at the
 * rate they arrive on average, so the words flow at an even cadence across the gaps instead of
 * dumping a burst and pausing. The reveal keeps a small buffer that adapts to the arrival interval
 * (about one interval, 50 to 420 ms) and works any difference from it off gently; it never falls
 * more than about a second behind. Whole words at a time. When the stream ends the remainder
 * drains quickly rather than snapping in; when the reader has scrolled away (`follow.current`
 * false) it catches up at once. Returns how many characters of `text` to show.
 */
export function useSmoothLength(text: string, streaming: boolean, follow: { current: boolean }, id?: string): number {
  // Mounting mid-stream (opening a running session) shows what is there; only new text is paced.
  // A text that moves to another place in the turn while it is still being revealed (a step arrived
  // and it became part of the story) carries its reveal over instead of completing at once.
  const [carried] = useState(() => (id ? takeCarry(id, text.length) : undefined));
  const start = carried?.shown ?? text.length;
  const [len, setLen] = useState(start);
  const target = useRef(text);
  target.current = text;
  const live = useRef(streaming);
  live.current = streaming;
  const pos = useRef(carried?.pos ?? start);
  const shown = useRef(start);
  const v = useRef(carried?.v ?? 0);
  const raf = useRef(0);
  const last = useRef(0);
  // Arrival statistics: the average rate (chars/ms) and interval (ms) of the chunks.
  const arrival = useRef(carried?.arrival ?? { at: 0, size: text.length, rate: 0, interval: 120 });

  useEffect(() => {
    if (reducedMotion()) {
      pos.current = shown.current = text.length;
      setLen(text.length);
      return;
    }
    // A text that shrank or was replaced (rewind, reset): start from what is there.
    if (text.length < shown.current) {
      pos.current = shown.current = text.length;
      v.current = 0;
      arrival.current = { at: 0, size: text.length, rate: 0, interval: 120 };
      setLen(text.length);
      return;
    }
    const a = arrival.current;
    const now = performance.now();
    const added = text.length - a.size;
    if (added > 0) {
      if (a.at) {
        const gap = Math.min(1500, Math.max(8, now - a.at));
        a.interval += (gap - a.interval) * 0.25;
        const sample = added / Math.max(gap, a.interval * 0.5);
        a.rate = a.rate ? a.rate + (sample - a.rate) * 0.3 : sample;
      }
      a.at = now;
      a.size = text.length;
    }
    if (raf.current || pos.current >= text.length) return;
    last.current = now;
    const tick = (t: number) => {
      raf.current = 0;
      const txt = target.current;
      const full = txt.length;
      const dt = Math.min(48, Math.max(1, t - last.current));
      last.current = t;
      let backlog = full - pos.current;
      if (backlog <= 0) {
        v.current = 0;
        return;
      }
      if (!follow.current) {
        pos.current = shown.current = full;
        v.current = 0;
        setLen(full);
        return;
      }
      const s = arrival.current;
      const rate = s.rate || backlog / 200;
      const behind = rate * MAX_BEHIND_MS + MAX_BEHIND_MARGIN;
      if (backlog > behind) {
        pos.current = full - behind;
        backlog = behind;
      }
      let want: number;
      if (live.current) {
        // Flow at the arrival rate, and drift toward a buffer of about one arrival interval.
        const buffer = rate * Math.min(MAX_BUFFER_MS, Math.max(MIN_BUFFER_MS, s.interval * BUFFER_INTERVALS));
        want = rate + (backlog - buffer) / CORRECT_MS;
      } else want = Math.max(rate, backlog / END_LAG_MS);
      v.current += (want - v.current) * (1 - Math.exp(-dt / ACCEL_MS));
      pos.current = Math.min(full, pos.current + Math.max(v.current, MIN_RATE) * dt);
      // Show whole words: run on to the end of the word the position landed in.
      let n = Math.floor(pos.current);
      let e = n;
      while (e < full && e - n < WORD_AHEAD && txt.charCodeAt(e) > 32) e++;
      if (e - n < WORD_AHEAD) n = e;
      if (n > shown.current) {
        shown.current = n;
        if (n > pos.current) pos.current = n;
        setLen(n);
      }
      // Dev builds expose the pacing so the lag behind the stream can be measured (scripts, console).
      if (import.meta.env.DEV) (window as unknown as { __smooth?: object }).__smooth = { full, shown: shown.current, rate: s.rate, interval: s.interval };
      if (pos.current < full) {
        raf.current = requestAnimationFrame(tick);
        // Where the reveal is, for a remount of this text in the same moment (see takeCarry).
        if (id) carry.set(id, { shown: shown.current, pos: pos.current, v: v.current, arrival: s, at: t });
      } else {
        v.current = 0;
        if (id) carry.delete(id);
      }
    };
    raf.current = requestAnimationFrame(tick);
  }, [text, streaming, follow, id]);

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [],
  );

  return Math.min(len, text.length);
}

interface Carry {
  shown: number;
  pos: number;
  v: number;
  arrival: { at: number; size: number; rate: number; interval: number };
  at: number;
}

/** Reveals in progress, by item id: a text mounted again elsewhere (answer to story) picks up from here. */
const carry = new Map<string, Carry>();

function takeCarry(id: string, length: number): Carry | undefined {
  const c = carry.get(id);
  if (!c) return undefined;
  // Only a move within the same moment carries over; a text opened later shows whole.
  if (performance.now() - c.at > 250 || c.shown > length) return undefined;
  return c;
}

const MARKER_ONLY = /^ {0,3}(#{1,6}|[-*+]|\d{1,3}[.)]|>)\s*$/;

/**
 * The part of a streaming text that is safe to show: a last line that is only a list, heading or
 * quote marker waits for its words (or the block would change type under the reader), and a table
 * shows once its header and divider are in, then grows a whole row at a time.
 */
export function steadyTail(text: string): string {
  const cut = text.lastIndexOf('\n') + 1;
  const tail = text.slice(cut);
  if (tail && MARKER_ONLY.test(tail)) return text.slice(0, cut);
  const pipe = (line: string) => line.trimStart().startsWith('|');
  const partialRow = pipe(tail);
  if (tail && !partialRow) return text;
  // The complete lines at the end that start with a pipe: a table in progress.
  let start = cut;
  let rows = 0;
  while (start > 0) {
    const prev = text.lastIndexOf('\n', start - 2) + 1;
    if (!pipe(text.slice(prev, start - 1))) break;
    start = prev;
    rows++;
  }
  if (!rows && !partialRow) return text;
  // Until the header and its divider are in, the table waits; then it grows a whole row at a time.
  if (rows < 2) return text.slice(0, start);
  return text.slice(0, cut);
}
