import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { TimelineItem } from '@shared/protocol';
import { parseReview } from '@/features/review/model';
import { plural } from '@/lib/format';
import { reducedMotion, uiZoom } from '@/lib/motion';
import { useStore } from '@/state/store';
import { useTimeline } from './ctx';
import { estimate } from './items';
import { findMarks, onFindMarks, takeSteps, type NavFeed, type NavLayout } from './nav-bus';
import { firstLine, groupAt, groupBoxes, groupHeight, isBuilt, marksOf, nearest, placeMarks, rowsOf, stepTarget, ticksOf, type NavMark } from './nav-model';
import { revealItem, rootOf } from './reveal';
import type { Group, TurnGroup } from './turns';
import { stampParts } from './util';
import './navigator.css';

/** Where a message lands after a jump: its row's top this far below the view's top (its card clears the top fade). */
const LAND = 18;
/** A jump farther than this many views goes most of the way at once and glides the rest. */
const FAR = 1.5;
/** The glide at the end of a far jump (px). */
const GLIDE = 220;
/** The map shows once the conversation is this many views tall, and hides again below `HIDE`. */
const SHOW = 2;
const HIDE = 1.8;
/** A tick answers the pointer within this distance (px on the track). */
const HIT = 8;
/** The reading line, as a share of the view's height from its top: the message above it is the one being read. */
const READ = 0.42;
/** Keys pressed while a jump is on its way step on from where it goes (ms). */
const IN_FLIGHT = 650;
/** The band moves once the scroll has been still this long (ms), and during a long scroll every `BAND_MS`. */
const BAND_QUIET = 140;
const BAND_MS = 500;
/** Marks moved by heights changing above them are measured again this long after (ms), once for a burst. */
const SETTLE_MS = 150;
/** While only the end grows, the scale is followed once the farthest tick would move this far (px). */
const DRIFT = 1.5;

interface Geo {
  /** Content offset of each mark (px from the top of the scroller's content, as `scrollTop`). */
  ys: Float64Array;
  sH: number;
  cH: number;
  track: number;
}

const NO_GEO: Geo = { ys: new Float64Array(0), sH: 0, cH: 0, track: 0 };

const sameYs = (a: Float64Array, b: Float64Array) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.5);

interface Measure {
  boxes: ReturnType<typeof groupBoxes> | null;
  layout: NavLayout | null;
  /** What the marks were measured for: the built ranges, the number of groups, the marks. */
  sig: string;
  marks: NavMark[] | null;
  /** The newest built group's element and its top: when it has not moved, nothing above it has. */
  anchor: HTMLElement | null;
  anchorTop: number;
}

const sigOf = (l: NavLayout) => `${l.built.lead}|${l.built.gapFrom}|${l.built.hidden}|${l.groups.length}`;

/** How long a jump holds its row in place while what is around it settles (ms). */
const PIN_MS = 1500;

/** The scroll position that puts a row at the landing place, within the scroller's range. */
function landing(sc: HTMLElement, el: HTMLElement): number {
  const y = (el.getBoundingClientRect().top - sc.getBoundingClientRect().top) / uiZoom() + sc.scrollTop;
  return Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, y - LAND));
}

interface Props {
  sessionId: string;
  feed: NavFeed;
  scroller: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  /** The reader moves the view: the timeline lets go of the end. */
  hold: () => void;
}

/**
 * The conversation's map, along its right edge: a short tick per message the person sent, where it
 * stands in the conversation, and the view as a quiet band. Hovering a tick previews the message,
 * a click jumps there, a drag scrubs; Alt+Up and Alt+Down step between messages (the find bar
 * hands the keys here). It never makes the timeline render: the turn list hands it its layout after
 * each commit (`feed`), it measures the built turns when the layout or a size changes (one read
 * when only the end grew), and the band moves by transform a few times a second while it scrolls.
 */
export const Navigator = memo(function Navigator({ sessionId, feed, scroller, content, hold }: Props) {
  const layout = useSyncExternalStore(feed.subscribe, feed.get);
  const find = useSyncExternalStore(
    useCallback((l: () => void) => onFindMarks(sessionId, l), [sessionId]),
    useCallback(() => findMarks(sessionId), [sessionId]),
  );
  const waiting = useStore((s) => {
    const d = s.data[sessionId];
    return s.sessions[sessionId]?.status === 'awaiting' || !!d?.permissions.length || !!d?.questions.length;
  });

  // The marks: one per message, kept per turn object, the same array while nothing changed.
  const [turnCache] = useState(() => new WeakMap<TurnGroup, Omit<NavMark, 'group'>[]>());
  const lastMarks = useRef<NavMark[]>([]);
  const marks = useMemo(() => {
    if (!layout) return lastMarks.current;
    const d = useStore.getState().data[sessionId];
    return (lastMarks.current = marksOf(layout.groups, d?.items ?? {}, d?.children ?? {}, turnCache, lastMarks.current));
  }, [layout, sessionId, turnCache]);

  // Estimated heights and offsets inside groups, kept per group object (a settled group never changes).
  const [shapes] = useState(() => new WeakMap<Group, { h: number; at: Map<string, number> }>());
  const shape = useCallback(
    (g: Group) => {
      let s = shapes.get(g);
      if (!s) {
        const items = useStore.getState().data[sessionId]?.items ?? {};
        const at = new Map<string, number>();
        const h = groupHeight(g, items, estimate, (id, y) => at.set(id, y));
        s = { h, at };
        shapes.set(g, s);
      }
      return s;
    },
    [shapes, sessionId],
  );

  const track = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Geo>(NO_GEO);
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const last = useRef<Measure>({ boxes: null, layout: null, sig: '', marks: null, anchor: null, anchorTop: 0 });
  const shownRef = useRef(false);
  const settleTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);
  const [boxesRev, setBoxesRev] = useState(0);

  /** Measures every mark's place: the built groups' boxes, the spacers, the estimates behind them. */
  const measure = useCallback(() => {
    const sc = scroller.current;
    const ct = content.current;
    const L = feed.get();
    if (!sc || !ct || !L) return;
    const base = ct.offsetTop;
    const byKey = new Map<string, HTMLElement>();
    let older: { top: number; height: number } | null = null;
    let gap: { top: number; height: number } | null = null;
    let keyed: HTMLElement | null = null;
    for (let c = ct.firstElementChild as HTMLElement | null; c; c = c.nextElementSibling as HTMLElement | null) {
      if (c.classList.contains('tl-older')) older = { top: c.offsetTop - base, height: c.offsetHeight };
      else if (c.classList.contains('tl-gap')) gap = { top: c.offsetTop - base, height: c.offsetHeight };
      else {
        const key = c.dataset.turn ?? c.dataset.itemId;
        if (key) {
          byKey.set(key, c);
          keyed = c;
        }
      }
    }
    // The newest group (always built): what streams grows below its top, so its top only moves when something above it does.
    const anchor = (L.groups.length ? byKey.get(L.groups[L.groups.length - 1].key) : undefined) ?? keyed;
    const boxes = groupBoxes(
      L.groups,
      L.built,
      {
        older,
        gap,
        box: (i) => {
          const el = byKey.get(L.groups[i].key);
          return el ? { top: el.offsetTop - base, height: el.offsetHeight } : undefined;
        },
      },
      (i) => shape(L.groups[i]).h,
    );
    const ms = marksRef.current;
    const ys = placeMarks(ms, boxes, (gi, id) => {
      const s = shape(L.groups[gi]);
      const at = s.at.get(id);
      return at && s.h > 0 ? at / s.h : undefined;
    });
    last.current = { boxes, layout: L, sig: sigOf(L), marks: ms, anchor, anchorTop: anchor ? anchor.offsetTop : 0 };
    if (findMarks(sessionId)) setBoxesRev((r) => r + 1);
    const next: Geo = { ys, sH: sc.scrollHeight, cH: sc.clientHeight, track: track.current?.clientHeight ?? 0 };
    const g = geoRef.current;
    if (next.sH !== g.sH || next.cH !== g.cH || next.track !== g.track || !sameYs(next.ys, g.ys)) setGeo((geoRef.current = next));
  }, [feed, scroller, content, shape, sessionId]);

  /**
   * After a commit or a size change: measure again only when the built ranges or the marks
   * changed, something above the newest group moved (its top did), or the view or the track
   * resized. When only the end grew (a streamed answer, a step in the running turn) the marks stay
   * where they are: only the scale changes, and only once that moves a tick by `DRIFT`.
   */
  const check = useCallback(() => {
    const sc = scroller.current;
    const L = feed.get();
    if (!sc || !L) return;
    const l = last.current;
    const g = geoRef.current;
    const cH = sc.clientHeight;
    const tr = track.current?.clientHeight ?? 0;
    if (l.sig !== sigOf(L) || l.marks !== marksRef.current || (l.anchor && !l.anchor.isConnected) || cH !== g.cH || tr !== g.track) return measure();
    // Something above the newest group changed height (older turns drawn for the first time as
    // the reader scrolls through them, a fold opened): measured once that settles.
    if (l.anchor && l.anchor.offsetTop !== l.anchorTop) {
      if (!settleTimer.current)
        settleTimer.current = window.setTimeout(() => {
          settleTimer.current = 0;
          requestAnimationFrame(measure);
        }, SETTLE_MS);
      return;
    }
    // The groups changed objects only (a step joined the running turn): find results keep their groups' places.
    l.layout = L;
    const sH = sc.scrollHeight;
    if (sH === g.sH) return;
    // Hidden, only the threshold matters; shown, the scale once the farthest tick would move by `DRIFT`.
    const crosses = sH > SHOW * cH !== g.sH > SHOW * cH || sH > HIDE * cH !== g.sH > HIDE * cH;
    const far = Math.max(g.ys.length ? g.ys[g.ys.length - 1] : 0, g.cH);
    if (crosses || (shownRef.current && Math.abs(far * tr * (1 / sH - 1 / g.sH)) >= DRIFT)) setGeo((geoRef.current = { ...g, sH }));
  }, [feed, scroller, measure]);

  // The turn list committed a new layout: look in the next frame, when the browser lays it out anyway.
  useEffect(() => {
    if (!layout) return;
    const raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, [layout, marks, check]);

  /**
   * The row a jump went to, held in place for a moment: turns around it build and take their real
   * height as they come into view (above it too), which would move it. While the view glides the
   * glide is aimed again; once it rests, the view follows the row in the same frame the layout
   * moved it (before it is painted), so it never visibly moves. Any input of the reader lets go.
   */
  const pin = useRef<{ el: HTMLElement; until: number; gliding: boolean; target: number } | null>(null);
  const { stuck } = useTimeline();
  const follow = useCallback(() => {
    const p = pin.current;
    const sc = scroller.current;
    if (!p || !sc) return;
    // Back to following the end (Jump to latest, a message sent): the jump is over.
    if (!p.el.isConnected || performance.now() > p.until || stuck.current) {
      pin.current = null;
      return;
    }
    const t = landing(sc, p.el);
    if (p.gliding) {
      if (Math.abs(t - p.target) > 1) sc.scrollTo({ top: t, behavior: 'smooth' });
    } else if (Math.abs(t - sc.scrollTop) > 1) sc.scrollTop = t;
    p.target = t;
  }, [scroller, stuck]);

  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const off = () => (pin.current = null);
    const opts = { capture: true, passive: true } as const;
    for (const t of ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const) sc.addEventListener(t, off, opts);
    return () => {
      for (const t of ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const) sc.removeEventListener(t, off, opts);
    };
  }, [scroller]);

  // Sizes: the content (it grows as the agent writes, older turns build), the view, the track.
  useEffect(() => {
    const sc = scroller.current;
    const ct = content.current;
    const tr = track.current;
    if (!sc || !ct || !tr) return;
    const ro = new ResizeObserver(() => {
      follow();
      check();
    });
    ro.observe(ct, { box: 'border-box' });
    ro.observe(sc);
    ro.observe(tr);
    return () => ro.disconnect();
  }, [scroller, content, check, follow]);

  // Shown only when the conversation is long enough to need it.
  const [shown, setShown] = useState(false);
  const tall = geo.cH > 0 && geo.sH > (shown ? HIDE : SHOW) * geo.cH;
  const show = tall && (marks.length >= 2 || !!find?.ids.length);
  useEffect(() => {
    shownRef.current = show;
    setShown(show);
  }, [show]);

  const k = geo.sH > 0 && geo.track > 0 ? geo.track / geo.sH : 0;
  const px = useMemo(() => Array.from(geo.ys, (y) => y * k), [geo.ys, k]);

  const lastMark = marks.length - 1;
  const ticks = useMemo(
    () =>
      show
        ? ticksOf(
            geo.ys,
            (i) => (waiting && i === lastMark ? 'wait' : marks[i]?.files ? 'files' : 'msg'),
            (i) => !!marks[i]?.steered,
            k,
          )
        : [],
    [show, geo.ys, k, marks, waiting, lastMark],
  );

  // Find results: where each matching item stands (its group's box and its place inside it).
  const hits = useMemo(() => {
    const { boxes, layout: lay } = last.current;
    if (!show || !find?.ids.length || !boxes || !lay) return null;
    const items = (useStore.getState().data[sessionId]?.items ?? {}) as Record<string, TimelineItem | undefined>;
    const groupOf = new Map<string, number>();
    lay.groups.forEach((g, i) => {
      if (g.kind === 'item') groupOf.set(g.id, i);
      else {
        for (const id of g.ids) groupOf.set(id, i);
        for (const id of g.checks ?? []) groupOf.set(id, i);
      }
    });
    const yOf = (id: string) => {
      const root = rootOf(items, id);
      const gi = groupOf.get(root);
      if (gi === undefined) return undefined;
      const s = shape(lay.groups[gi]);
      const at = s.at.get(root) ?? 0;
      return boxes.top[gi] + (s.h > 0 ? (at / s.h) * boxes.height[gi] : 0);
    };
    const ys: number[] = [];
    for (const id of find.ids) {
      const y = yOf(id);
      if (y !== undefined) ys.push(y);
    }
    const at = find.current ? yOf(find.current) : undefined;
    return { rows: rowsOf(ys, k), at: at === undefined ? null : at * k };
  }, [show, find, boxesRev, k, sessionId, shape]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── moving the view ──

  /** A jump on its way: where it goes, so keys pressed meanwhile step on from there. */
  const flight = useRef<{ index: number; at: number }>({ index: -1, at: 0 });

  /** Brings a row to the top of the view: straight there when near, most of the way at once and a short glide when far. */
  const land = useCallback(
    (el: HTMLElement) => {
      const sc = scroller.current;
      if (!sc) return;
      const target = landing(sc, el);
      hold();
      const glide = !reducedMotion();
      if (!glide) sc.scrollTop = target;
      else {
        const d = target - sc.scrollTop;
        if (Math.abs(d) > sc.clientHeight * FAR) sc.scrollTop = target - Math.sign(d) * GLIDE;
        sc.scrollTo({ top: target, behavior: 'smooth' });
      }
      const p = { el, until: performance.now() + PIN_MS, gliding: glide, target };
      pin.current = p;
      if (glide)
        sc.addEventListener(
          'scrollend',
          () => {
            if (pin.current !== p) return;
            p.gliding = false;
            follow();
          },
          { once: true },
        );
    },
    [scroller, hold, follow],
  );

  /** Jumps to a message: built already, or built first (with a few turns around it) and then jumped to. */
  const jumpTo = useCallback(
    (index: number) => {
      const m = marksRef.current[index];
      const sc = scroller.current;
      if (!m || !sc) return;
      const rowOf = () =>
        (m.steered ? sc.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(m.id)}"]`) : content.current?.querySelector<HTMLElement>(`:scope > section[data-turn="${CSS.escape(m.id)}"]`)) ?? null;
      const el = rowOf();
      flight.current = { index, at: performance.now() };
      if (el) return land(el);
      hold();
      pin.current = null;
      revealItem(sessionId, m.id, { quiet: true });
      let tries = 0;
      const look = () => {
        if (flight.current.index !== index) return;
        const row = rowOf();
        if (row) land(row);
        else if (++tries < 40) requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    },
    [scroller, content, sessionId, land, hold],
  );

  const toEnd = useCallback(() => {
    const sc = scroller.current;
    if (!sc) return;
    flight.current = { index: marksRef.current.length, at: performance.now() };
    pin.current = null;
    sc.scrollTo({ top: sc.scrollHeight, behavior: reducedMotion() ? 'instant' : 'smooth' });
  }, [scroller]);

  // Alt+Up and Alt+Down (the find bar hands them over): the previous or next message from where the view is.
  useEffect(
    () =>
      takeSteps(sessionId, (dir) => {
        const sc = scroller.current;
        const ms = marksRef.current;
        if (!sc || !ms.length) return false;
        let to: number;
        const f = flight.current;
        if (f.index >= 0 && performance.now() - f.at < IN_FLIGHT) to = Math.max(0, Math.min(ms.length, f.index + dir));
        else {
          const top = sc.scrollTop;
          to = stepTarget(geoRef.current.ys, top + sc.clientHeight * READ, top + LAND, dir);
        }
        if (to >= ms.length) toEnd();
        else if (to >= 0) jumpTo(to);
        return true;
      }),
    [sessionId, scroller, jumpTo, toEnd],
  );

  // ── the pointer ──

  const [hover, setHover] = useState(-1);
  const [held, setHeld] = useState(false);
  const press = useRef<{ id: number; y: number; scrub: boolean; raf: number; to: number } | null>(null);
  /** Places the band (declared below with it), for scrubbing to move it with the pointer. */
  const bandRef = useRef<((top?: number) => void) | null>(null);
  const trackTop = useRef(0);

  /** The pointer's place on the track (px), from a client y. */
  const onTrack = (clientY: number) => (clientY - trackTop.current) / uiZoom();

  /** Scrubbing: the view centred on the pointer's place, once a frame. */
  const scrubTo = (y: number) => {
    const sc = scroller.current;
    const p = press.current;
    if (!sc || !p) return;
    p.to = y;
    if (p.raf) return;
    p.raf = requestAnimationFrame(() => {
      p.raf = 0;
      hold();
      const top = (p.to / (geoRef.current.track || 1)) * sc.scrollHeight - sc.clientHeight / 2;
      sc.scrollTop = top;
      bandRef.current?.(top);
    });
  };

  const onPointerEnter = (e: ReactPointerEvent<HTMLDivElement>) => {
    trackTop.current = e.currentTarget.getBoundingClientRect().top;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const y = onTrack(e.clientY);
    const p = press.current;
    if (p && p.id === e.pointerId) {
      if (!p.scrub && Math.abs(y - p.y) > 3) p.scrub = true;
      if (p.scrub) scrubTo(y);
    }
    const i = nearest(px, y, HIT);
    if (i !== hover) setHover(i);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    trackTop.current = e.currentTarget.getBoundingClientRect().top;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { id: e.pointerId, y: onTrack(e.clientY), scrub: false, raf: 0, to: 0 };
    setHeld(true);
  };

  const release = () => {
    const p = press.current;
    if (p?.raf) cancelAnimationFrame(p.raf);
    press.current = null;
    setHeld(false);
    return p;
  };

  /**
   * Whether the conversation is built at a content offset. A place that is not (behind a spacer)
   * would show nothing: the view goes to the message there instead, which builds it.
   */
  const builtAt = (y: number) => {
    const { boxes, layout: lay } = last.current;
    if (!boxes || !lay) return true;
    const gi = groupAt(boxes.top, y);
    return gi < 0 || isBuilt(lay.built, gi);
  };

  /** The message at a content offset: the last one that starts above it (or the first). */
  const markAt = (y: number) => {
    const ys = geoRef.current.ys;
    let i = 0;
    while (i + 1 < ys.length && ys[i + 1] <= y) i++;
    return i;
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (press.current?.id !== e.pointerId) return;
    const p = release();
    const sc = scroller.current;
    if (!p || !sc || !geo.track) return;
    if (p.scrub) {
      // Let go over a part not built yet: the view settles on the message there.
      const line = sc.scrollTop + sc.clientHeight * READ;
      if (!builtAt(line)) jumpTo(markAt(line));
      return;
    }
    const y = onTrack(e.clientY);
    const i = nearest(px, y, HIT);
    if (i >= 0) return jumpTo(i);
    // Between ticks: the view goes there, centred on the place.
    const at = (y / geo.track) * sc.scrollHeight;
    if (!builtAt(at)) return jumpTo(markAt(at));
    hold();
    flight.current = { index: -1, at: 0 };
    pin.current = null;
    sc.scrollTo({ top: at - sc.clientHeight / 2, behavior: reducedMotion() ? 'instant' : 'smooth' });
  };

  // The wheel over the map scrolls the conversation, as it does beside it.
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const sc = scroller.current;
      if (!sc || e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY < 0) hold();
      sc.scrollBy({ top: e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY, behavior: 'instant' });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scroller, hold]);

  // ── the band ──

  /**
   * The view's band. Every move of it costs the main thread a pass of the page's lifecycle, the
   * intersection checks and layerization of the whole conversation (a scroll-linked animation pays
   * that every frame: reading back a long chat was about 10% busier with one, measured). So it
   * moves when a scroll comes to rest (and every `BAND_MS` during a long one), follows the pointer
   * while scrubbing, and rests at the end while the view follows the end (a turn streaming in front
   * of the reader). The scroll listener reads a ref and arms a timer; the one read of the scroll
   * position happens in a frame.
   */
  const travel = useRef<HTMLDivElement>(null);
  const placeBand = useCallback(
    (top?: number) => {
      const sc = scroller.current;
      const el = travel.current;
      if (!sc || !el) return;
      const at = stuck.current && top === undefined;
      if (el.parentElement && el.parentElement.hasAttribute('data-end') !== at) el.parentElement.toggleAttribute('data-end', at);
      // The travel is the track less the band: the band's top is scrollTop × track / scrollHeight.
      const max = sc.scrollHeight - sc.clientHeight;
      const t = at || max <= 0 ? '' : `translateY(${((Math.max(0, Math.min(max, top ?? sc.scrollTop)) / max) * el.offsetHeight).toFixed(1)}px)`;
      // Unchanged: no write, so nothing is laid out or layerized again.
      if (el.style.transform !== t) el.style.transform = t;
    },
    [scroller, stuck],
  );
  bandRef.current = placeBand;
  useEffect(() => {
    const sc = scroller.current;
    if (!sc || !show) return;
    let timer = 0;
    let raf = 0;
    let placed = performance.now();
    const place = () => {
      timer = 0;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        placed = performance.now();
        placeBand();
      });
    };
    const onScroll = () => {
      // Following the end: it rests there (set once).
      if (stuck.current && travel.current?.parentElement?.hasAttribute('data-end')) return;
      window.clearTimeout(timer);
      // A long scroll moves it now and then; otherwise once the scroll has been still a moment.
      if (performance.now() - placed > BAND_MS) place();
      else timer = window.setTimeout(place, BAND_QUIET);
    };
    place();
    sc.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      sc.removeEventListener('scroll', onScroll);
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [scroller, show, stuck, placeBand]);
  // The scale changed (the conversation grew, the view resized): the band takes its new place.
  useEffect(() => {
    if (show) placeBand();
  }, [show, geo, placeBand]);

  // ── drawing ──

  const bandH = Math.max(12, geo.cH * k);
  const hovered = show && hover >= 0 && hover < px.length ? marks[hover] : undefined;
  // The ticks as elements, made again only when they change: a new layout (a step in the running
  // turn) re-renders the map without touching them.
  const drawn = useMemo(
    () => (
      <>
        <div className="nav-ticks">
          {ticks.map((t, i) =>
            t.kind === 'wait' ? null : <i key={i} className="nav-tick" data-files={t.kind === 'files' || undefined} data-steered={t.steered || undefined} style={{ transform: `translateY(${t.y}px)` }} />,
          )}
        </div>
        {ticks.some((t) => t.kind === 'wait') && (
          <div className="nav-waits">
            {ticks.map((t, i) => (t.kind === 'wait' ? <i key={i} className="nav-tick" style={{ transform: `translateY(${t.y}px)` }} /> : null))}
          </div>
        )}
      </>
    ),
    [ticks],
  );

  return (
    <>
      <div
        ref={track}
        className="nav"
        data-show={show || undefined}
        data-held={held || undefined}
        data-find={hits ? '' : undefined}
        aria-hidden
        onPointerEnter={onPointerEnter}
        onPointerMove={onPointerMove}
        onPointerLeave={() => !press.current && setHover(-1)}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={release}
        onLostPointerCapture={release}
      >
        {show && (
          <>
            <div ref={travel} className="nav-travel" style={{ height: Math.max(0, geo.track - bandH) }}>
              <i className="nav-band" style={{ height: bandH }} />
            </div>
            {drawn}
            {hits && (
              <div className="nav-hits">
                {hits.rows.map((y, i) => (
                  <i key={i} className="nav-hit" style={{ transform: `translateY(${y}px)` }} />
                ))}
                {hits.at !== null && <i className="nav-hit" data-at style={{ transform: `translateY(${hits.at}px)` }} />}
              </div>
            )}
            {hovered && <i className="nav-lit" data-steered={hovered.steered || undefined} style={{ transform: `translateY(${px[hover]}px)` }} />}
          </>
        )}
      </div>
      {hovered && <Peek sessionId={sessionId} mark={hovered} y={px[hover]} track={geo.track} waiting={waiting && hover === lastMark} />}
    </>
  );
});

/** The message under the pointer: its first line, when it was sent, what its turn changed. */
function Peek({ sessionId, mark, y, track, waiting }: { sessionId: string; mark: NavMark; y: number; track: number; waiting: boolean }) {
  const item = useStore.getState().data[sessionId]?.items[mark.id];
  if (item?.type !== 'user') return null;
  const words = parseReview(item.text)?.lead || item.text;
  const line = firstLine(words) || (item.attachments?.length ? plural(item.attachments.length, 'attachment') : 'Message');
  const { day, time } = stampParts(item.ts);
  const when = day ? `${day}, ${time}` : time;
  const meta = [mark.steered ? `Steered ${when}` : when];
  if (mark.files) meta.push(`${plural(mark.files, 'file')} changed`);
  // Kept beside the track, so a card at either end never leaves it.
  const at = Math.max(16, Math.min(track - 16, y));
  return (
    <div className="nav-peek glass" style={{ transform: `translateY(${at}px)` }}>
      <div className="nav-peek-text truncate">{line}</div>
      <div className="nav-peek-meta num">
        {meta.join(' · ')}
        {waiting && <span className="nav-peek-wait"> · Waiting for you</span>}
      </div>
    </div>
  );
}
