import { useEffect, useRef, useState } from 'react';
import { reducedMotion } from '@/lib/motion';

/** How far behind the stream the reveal aims to run (ms of backlog at the current pace). */
const LAG_MS = 110;
/** After the stream ends, the rest drains faster than that, but still flows. */
const END_LAG_MS = 55;
/** How quickly the pace follows a change in the backlog (ms): a burst speeds up, never jumps. */
const ACCEL_MS = 70;
/** Never slower than this (characters per ms), so the last words of a burst do not crawl. */
const MIN_RATE = 0.06;
/** Further behind than this (characters) and the reveal skips ahead: a reconnect, a huge paste. */
const MAX_BACKLOG = 900;
/** A word is shown whole if it ends within this many characters; longer runs grow in place. */
const WORD_AHEAD = 24;

/**
 * Evens out streamed text. Chunks arrive in bursts; this reveals them as a steady flow. The pace
 * is a velocity that eases toward "clear the backlog in about 110 ms", so a burst accelerates the
 * reveal smoothly instead of dumping its first part at once, and a pause lets it coast to a stop.
 * Whole words at a time. When the stream ends the remainder drains quickly rather than snapping
 * in; when the reader has scrolled away (`follow.current` false) it catches up at once.
 * Returns how many characters of `text` to show.
 */
export function useSmoothLength(text: string, streaming: boolean, follow: { current: boolean }): number {
  // Mounting mid-stream (opening a running session) shows what is there; only new text is paced.
  const [len, setLen] = useState(text.length);
  const target = useRef(text);
  target.current = text;
  const live = useRef(streaming);
  live.current = streaming;
  const pos = useRef(text.length);
  const shown = useRef(text.length);
  const v = useRef(0);
  const raf = useRef(0);
  const last = useRef(0);

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
      setLen(text.length);
      return;
    }
    if (raf.current || pos.current >= text.length) return;
    last.current = performance.now();
    const tick = (now: number) => {
      raf.current = 0;
      const t = target.current;
      const full = t.length;
      const dt = Math.min(48, Math.max(1, now - last.current));
      last.current = now;
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
      if (backlog > MAX_BACKLOG) {
        pos.current = full - MAX_BACKLOG;
        backlog = MAX_BACKLOG;
      }
      const want = backlog / (live.current ? LAG_MS : END_LAG_MS);
      v.current += (want - v.current) * (1 - Math.exp(-dt / ACCEL_MS));
      pos.current = Math.min(full, pos.current + Math.max(v.current, MIN_RATE) * dt);
      // Show whole words: run on to the end of the word the position landed in.
      let n = Math.floor(pos.current);
      let e = n;
      while (e < full && e - n < WORD_AHEAD && t.charCodeAt(e) > 32) e++;
      if (e - n < WORD_AHEAD) n = e;
      if (n > shown.current) {
        shown.current = n;
        if (n > pos.current) pos.current = n;
        setLen(n);
      }
      // Dev builds expose the pacing so the lag behind the stream can be measured (scripts, console).
      if (import.meta.env.DEV) (window as unknown as { __smooth?: object }).__smooth = { full, shown: shown.current };
      if (pos.current < full) raf.current = requestAnimationFrame(tick);
      else v.current = 0;
    };
    raf.current = requestAnimationFrame(tick);
  }, [text, streaming, follow]);

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [],
  );

  return Math.min(len, text.length);
}
