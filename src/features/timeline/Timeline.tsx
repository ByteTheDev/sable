import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '@/icons';
import { EASE_OUT, play, reducedMotion } from '@/lib/motion';
import { interrupt } from '@/state/actions';
import { useStore } from '@/state/store';
import { EMPTY, TimelineCtx, type TimelineCtxValue } from './ctx';
import { REVEAL_EVENT, type RevealDetail } from './reveal';
import { TurnList } from './TurnView';
import './timeline.css';

/** Within this distance of the end, new content keeps the view pinned to it. */
const STICK = 48;
/** Further than this from the end, the "jump to latest" button shows. */
const AWAY = 160;
/** The follower's natural frequency (rad/s): critically damped, so it never overshoots the end. */
const FOLLOW_W = 24;

/**
 * Where the reader left each conversation they had scrolled away from the end of, as the distance
 * from the end (the end is always built, older turns wait behind a spacer of estimated height), so
 * switching back lands where they were reading. For the window's life only.
 */
const keptAt = new Map<string, number>();

/**
 * The conversation. A scroller that stays with the newest content until the reader
 * scrolls away, a centred reading column, and one component per item that subscribes
 * to that item alone, so streaming touches nothing that has settled.
 */
export function Timeline({ sessionId }: { sessionId: string }) {
  const loaded = useStore((s) => s.data[sessionId]?.loaded ?? false);
  const roots = useStore((s) => s.data[sessionId]?.roots) ?? EMPTY;
  const cwd = useStore((s) => s.sessions[sessionId]?.cwd ?? '');
  const home = useStore((s) => s.home);
  const busy = useStore((s) => {
    const st = s.sessions[sessionId]?.status;
    return st === 'running' || st === 'starting';
  });

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const lastTop = useRef(0);
  /** How far the view is from the end, as last measured (by a scroll or a resize): read by input handlers instead of the layout. */
  const room = useRef(0);
  /** When the reader last scrolled (ms): older turns wait to be built ahead until the view is still. */
  const scrolled = useRef(0);
  const live = useRef(false);
  const [away, setAway] = useState(false);

  const ctx = useMemo<TimelineCtxValue>(() => ({ sessionId, cwd, home, live, stuck, scrolled }), [sessionId, cwd, home]);

  const glide = useRef({ raf: 0, pos: 0, v: 0, last: 0 });

  const pin = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
    glide.current.pos = el.scrollTop;
    glide.current.v = 0;
  }, []);

  /**
   * Follows the end with a critically damped motion: content that grows (streamed lines, a new
   * row, a sent message) is scrolled to smoothly instead of in steps. The target is read every
   * frame, so it tracks whatever arrives meanwhile; it stops the moment the reader lets go.
   */
  const follow = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const g = glide.current;
    const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
    // History being laid out, reduced motion, or a jump too large to travel: go straight there.
    if (!live.current || reducedMotion() || gap > el.clientHeight * 1.5) {
      pin();
      return;
    }
    if (g.raf || gap < 0.5) return;
    g.pos = el.scrollTop;
    g.last = performance.now();
    const tick = (now: number) => {
      g.raf = 0;
      if (!stuck.current) {
        g.v = 0;
        return;
      }
      const target = el.scrollHeight - el.clientHeight;
      const dt = Math.min(0.034, Math.max(0.001, (now - g.last) / 1000));
      g.last = now;
      const x = g.pos - target;
      g.v += (-FOLLOW_W * FOLLOW_W * x - 2 * FOLLOW_W * g.v) * dt;
      g.pos += g.v * dt;
      if (g.pos >= target - 0.4) {
        g.pos = target;
        g.v = 0;
        el.scrollTop = target;
        lastTop.current = el.scrollTop;
        return;
      }
      el.scrollTop = g.pos;
      lastTop.current = el.scrollTop;
      g.raf = requestAnimationFrame(tick);
    };
    g.raf = requestAnimationFrame(tick);
  }, [pin]);

  useEffect(() => () => cancelAnimationFrame(glide.current.raf), []);

  // The working line glides to its new place when content appears above it, instead of jumping.
  const tailAt = useRef<{ top: number; anim: Animation | null } | null>(null);
  const glideTail = useCallback(() => {
    const tail = content.current?.querySelector<HTMLElement>(':scope > .tail');
    if (!tail) {
      tailAt.current = null;
      return;
    }
    const top = tail.offsetTop;
    const prev = tailAt.current;
    tailAt.current = { top, anim: prev?.anim ?? null };
    if (!prev || !live.current || tail.hasAttribute('data-quiet')) return;
    // Where it is drawn right now (it may still be travelling from the last change).
    let drawn = prev.top;
    if (prev.anim && prev.anim.playState === 'running') {
      drawn = prev.top + new DOMMatrixReadOnly(getComputedStyle(tail).transform).m42;
      prev.anim.cancel();
    }
    const d = drawn - top;
    if (Math.abs(d) < 2 || Math.abs(d) > 480) {
      tailAt.current.anim = null;
      return;
    }
    tailAt.current.anim = play(tail, [{ transform: `translateY(${d}px)` }, { transform: 'translateY(0px)' }], { duration: 240, easing: EASE_OUT });
  }, []);

  // Where the reader left this conversation, until the content is tall enough to go back there
  // (the last turns build a moment after the view mounts).
  const restoreTo = useRef<number | null>(null);
  const restore = useCallback(() => {
    const el = scroller.current;
    const dist = restoreTo.current;
    if (!el || dist === null) return false;
    const max = el.scrollHeight - el.clientHeight;
    if (max < dist + STICK) return false;
    restoreTo.current = null;
    el.scrollTop = max - dist;
    lastTop.current = el.scrollTop;
    glide.current.pos = el.scrollTop;
    setAway(dist > AWAY);
    return true;
  }, []);

  // Land at the end of an existing transcript before the first paint, or where the reader left it.
  useLayoutEffect(() => {
    if (!loaded) return;
    const dist = keptAt.get(sessionId);
    if (dist === undefined) return pin();
    stuck.current = false;
    restoreTo.current = dist;
    if (restore()) return;
    // The content never grew that tall (it changed meanwhile): the end, as usual.
    const t = window.setTimeout(() => {
      if (restoreTo.current === null) return;
      restoreTo.current = null;
      stuck.current = true;
      pin();
    }, 1500);
    return () => window.clearTimeout(t);
  }, [loaded, pin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the conversation: remember the place when the reader was away from the end.
  useLayoutEffect(() => {
    const el = scroller.current;
    return () => {
      if (!el) return;
      const dist = restoreTo.current ?? el.scrollHeight - el.clientHeight - el.scrollTop;
      if (!stuck.current && dist > STICK) keptAt.set(sessionId, dist);
      else keptAt.delete(sessionId);
    };
  }, [sessionId]);

  // History is laid out without entrance animations; anything arriving after that rises in.
  useEffect(() => {
    if (!loaded) return;
    const t = window.setTimeout(() => (live.current = true), 400);
    return () => window.clearTimeout(t);
  }, [loaded]);

  // Whenever the content or the viewport changes size: stay pinned, or re-evaluate the jump button.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      room.current = el.scrollHeight - el.clientHeight - el.scrollTop;
      glideTail();
      if (restoreTo.current !== null && restore()) return;
      if (stuck.current) follow();
      else setAway(el.scrollHeight - el.scrollTop - el.clientHeight > AWAY);
    });
    // Border box: the end padding follows the dock's height and must re-pin too.
    ro.observe(inner, { box: 'border-box' });
    ro.observe(el);
    return () => ro.disconnect();
  }, [follow, glideTail, restore]);

  // Only the reader lets go of the end. Layout moving the scroll position (rows above built
  // or settling to their real height, scroll anchoring, the dock resizing) never does.
  const intent = useRef(0);
  const dragging = useRef(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const mark = () => (intent.current = performance.now());
    // Scrolling up with the wheel lets go at once, before the scroll event arrives. Nothing here
    // reads the layout or writes to the page: a wheel arrives every few ms during a flick, and a
    // style change on the conversation's root here (it once switched hover off while scrolling)
    // restyled every row twice per gesture, forced at once by the next read. The browser itself
    // leaves hover alone while a scroll runs.
    const onWheel = (e: WheelEvent) => {
      mark();
      restoreTo.current = null;
      if (e.deltaY < 0 && room.current > 1) stuck.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (/^(Arrow(Up|Down)|Page(Up|Down)|Home|End| )$/.test(e.key)) mark();
    };
    const down = () => {
      dragging.current = true;
      mark();
    };
    const up = () => (dragging.current = false);
    // Opening something (a turn's steps, a step's details) grows the content under the pointer:
    // the reader is reading there, so the view stays where it is instead of following the end.
    const onClick = (e: MouseEvent) => {
      const t = (e.target as HTMLElement | null)?.closest('[aria-expanded="false"]');
      if (t && el.contains(t) && el.scrollHeight - el.clientHeight - el.scrollTop <= STICK) stuck.current = false;
    };
    el.addEventListener('click', onClick, true);
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', mark, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointercancel', up);
      el.removeEventListener('click', onClick, true);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', mark);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el || restoreTo.current !== null) return;
    const top = el.scrollTop;
    const dist = el.scrollHeight - top - el.clientHeight;
    room.current = dist;
    scrolled.current = performance.now();
    const byReader = dragging.current || performance.now() - intent.current < 600;
    if (top < lastTop.current - 1 && dist > 1) {
      if (byReader) stuck.current = false;
      else if (stuck.current) {
        // Pulled up by layout while following the end: go straight back.
        pin();
        return;
      }
    } else if (dist <= STICK && top >= lastTop.current) stuck.current = true;
    lastTop.current = top;
    setAway(!stuck.current && dist > AWAY);
  }, [pin]);

  // A plain passive listener: a scroll event arrives every frame of a scroll, and React's synthetic
  // dispatch for it cost more than the handler itself.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [onScroll]);

  const jump = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    stuck.current = true;
    setAway(false);
    lastTop.current = el.scrollTop;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  // Sending a message always returns to the end.
  const count = roots.length;
  const lastId = roots[count - 1];
  useEffect(() => {
    if (!lastId) return;
    const item = useStore.getState().data[sessionId]?.items[lastId];
    if (item?.type === 'user' && live.current) {
      // The view travels to the message: it rises from behind the composer as the scroll catches up.
      stuck.current = true;
      setAway(false);
      follow();
    }
  }, [lastId, sessionId, follow]);

  // Revealing an older item (TurnList builds and scrolls to it) lets go of the end first,
  // or the growth above would pin the view straight back down.
  useEffect(() => {
    const onReveal = (e: Event) => {
      if ((e as CustomEvent<RevealDetail>).detail?.sessionId !== sessionId) return;
      stuck.current = false;
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, [sessionId]);

  // Esc stops the turn, unless something else (a menu, a dialog, a field with its own Esc) wants the key.
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.repeat) return;
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      void interrupt(sessionId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, sessionId]);

  const empty = loaded && count === 0;

  return (
    <TimelineCtx.Provider value={ctx}>
      <div className="tl">
        <div className="tl-scroll scroll" ref={scroller} tabIndex={-1}>
          <div className="tl-content" ref={content} data-empty={empty || undefined}>
            {empty ? <p className="tl-empty">Send a message to start</p> : loaded && <TurnList ids={roots} />}
          </div>
        </div>
        <AnimatePresence>
          {away && (
            <motion.button
              type="button"
              className="tl-jump"
              onClick={jump}
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 460, damping: 34 }}
            >
              <Icon name="arrow-down" size={13} />
              Jump to latest
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </TimelineCtx.Provider>
  );
}
