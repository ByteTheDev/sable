import { memo, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ThinkingItem, TimelineItem, ToolItem } from '@shared/protocol';
import { Tiles } from '@/art/Logo';
import { Collapse } from '@/components/Collapse';
import { Icon } from '@/icons';
import { plural } from '@/lib/format';
import { reducedMotion } from '@/lib/motion';
import { showRailTab } from '@/state/actions';
import { useStore, type Store } from '@/state/store';
import { useFresh, useItem, useTimeline } from './ctx';
import { foldKey, setFold, useFold } from './fold';
import { ItemList, ItemRow, estimate } from './items';
import { REVEAL_EVENT, rootOf, type RevealDetail } from './reveal';
import { changesOf } from './changes';
import { Tail } from './Tail';
import { TurnFoot } from './Turn';
import { LINE, shapeIndex, turnsIndex, type FlowChunk, type Group, type Segment, type TurnGroup, type TurnLayout } from './turns';
import { leadTitle } from './lead-in';
import { shortDuration, thinkingHeadline, useHeld, useTick } from './util';

/** Groups built when a transcript opens, and how many more each step up builds. */
const TAIL = 8;
const CHUNK = 8;
/**
 * Older groups built ahead of the reader in idle moments, a few at a time, up to this many beyond
 * the tail: scrolling up finds them built instead of building a chunk under a moving scroll.
 */
const AHEAD = 56;
const IDLE_CHUNK = 2;
/** How long the view must have been still before building ahead (ms). */
const STILL_MS = 400;

const chunkSig = (c: FlowChunk) => (c.kind === 'line' ? '|' : c.kind === 'steps' ? `${c.key}+${c.ids.length}+${c.count}` : c.id);
const segSig = (s: Segment) => `${s.lead}>${s.flow.map(chunkSig).join(',')}>${s.reply}>${s.answer}>${s.errors.join(',')}`;

/** A turn `turnsIndex` handed back again, the same object (nothing in it changed): its stable object and its cache entries. */
interface Kept {
  turn: TurnGroup;
  entries: [string, unknown][];
}

/**
 * Keeps the objects of turns and segments that did not change, so their memoized views skip
 * rendering: a new step in the running turn re-renders that turn alone. A turn the grouping kept
 * (`kept`) is not read again: its stable object and cache entries carry over as they are.
 */
function stabilize(layout: TurnLayout, cache: Map<string, unknown>, kept: WeakMap<TurnGroup, Kept>): TurnLayout {
  const next = new Map<string, unknown>();
  const groups = layout.groups.map((g): Group => {
    if (g.kind !== 'turn') return g;
    const known = kept.get(g);
    if (known) {
      for (const [k, v] of known.entries) next.set(k, v);
      return known.turn;
    }
    const entries: [string, unknown][] = [];
    const put = (k: string, v: unknown) => {
      next.set(k, v);
      entries.push([k, v]);
    };
    const segments = g.segments.map((s) => {
      const k = `s|${segSig(s)}`;
      const prev = (next.get(k) ?? cache.get(k)) as Segment | undefined;
      const seg = prev ?? { ...s, flow: s.flow.map((c) => keepChunk(c, cache, next, put)) };
      if (prev) for (const c of prev.flow) if (c.kind === 'steps') put(`c|${c.key}`, c);
      put(k, seg);
      return seg;
    });
    const k = `t|${g.state}|${g.end}|${g.ids.length}|${g.checks?.join(',') ?? ''}|${segments.map(segSig).join(';')}`;
    const prev = (next.get(k) ?? cache.get(k)) as TurnGroup | undefined;
    const turn = prev ?? { ...g, segments };
    put(k, turn);
    kept.set(g, { turn, entries });
    return turn;
  });
  cache.clear();
  for (const [k, v] of next) cache.set(k, v);
  return { groups, queued: layout.queued };
}

/** A run of steps keeps its object while nothing joined it (ids only ever append), so its list skips rendering. */
function keepChunk(c: FlowChunk, cache: Map<string, unknown>, next: Map<string, unknown>, put: (k: string, v: unknown) => void): FlowChunk {
  if (c.kind !== 'steps') return c;
  const k = `c|${c.key}`;
  const old = (next.get(k) ?? cache.get(k)) as FlowChunk | undefined;
  const same = old?.kind === 'steps' && old.count === c.count && old.ids.length === c.ids.length && old.ids[old.ids.length - 1] === c.ids[c.ids.length - 1];
  const chunk = same ? old : c;
  put(k, chunk);
  return chunk;
}

function groupHeight(g: Group, items: Record<string, TimelineItem>): number {
  if (g.kind === 'item') return estimate(items[g.id]);
  let h = 30;
  for (const s of g.segments) {
    if (s.lead) h += estimate(items[s.lead]);
    for (const c of s.flow) {
      if (c.kind === 'line') h += 34;
      else if (c.kind !== 'steps') h += estimate(items[c.id]);
    }
    h += s.errors.length * 64;
  }
  return h + (g.checks?.length ?? 0) * 80;
}

/**
 * The conversation as turns: each message, what the agent said, a quiet line for the work behind
 * it, and the answer. A long transcript opens with only its last turns built; the ones above wait
 * behind a spacer of about their height and are built a few at a time as the reader scrolls up.
 */
export const TurnList = memo(function TurnList({ ids }: { ids: string[] }) {
  const { sessionId, scrolled } = useTimeline();
  // One character per root item (see `turns.ts`), following the items write by write: a streamed
  // word re-reads the item it grew, not every root.
  const [shapes] = useState(shapeIndex);
  const shape = useStore(useMemo(() => (s: Store) => shapes(s.data[sessionId], ids), [shapes, sessionId, ids]));
  const busy = useStore((s) => {
    const st = s.sessions[sessionId]?.status;
    return st === 'running' || st === 'starting' || st === 'awaiting';
  });
  const cache = useRef(new Map<string, unknown>());
  // The grouping, regrouping only from the last message the timeline has not changed before (a new
  // step regroups the running turn, not the conversation), and the turns it kept.
  const [grouping] = useState(turnsIndex);
  const [kept] = useState(() => new WeakMap<TurnGroup, Kept>());
  const layout = useMemo(() => {
    // The turn a check belongs to never changes, so reading it here (once per shape) is enough.
    const items = useStore.getState().data[sessionId]?.items;
    const checkOf = (id: string) => (items?.[id] as ToolItem | undefined)?.check?.turn;
    return stabilize(grouping(ids, shape, busy, checkOf), cache.current, kept);
  }, [grouping, kept, ids, shape, busy, sessionId]);
  const groups = layout.groups;
  const running = busy && groups.some((g) => g.kind === 'turn' && g.state === 'running');

  const [hiddenState, setHidden] = useState<number | null>(null);
  const hidden = Math.min(groups.length, hiddenState ?? Math.max(0, groups.length - TAIL));
  useEffect(() => {
    if (hiddenState === null && groups.length) setHidden(hidden);
  }, [hiddenState, groups.length, hidden]);

  const spacer = useRef<HTMLDivElement>(null);
  const spacerHeight = useMemo(() => {
    if (!hidden) return 0;
    const items = useStore.getState().data[sessionId]?.items ?? {};
    let h = 0;
    for (let i = 0; i < hidden; i++) h += groupHeight(groups[i], items);
    return h;
  }, [hidden, groups, sessionId]);

  useEffect(() => {
    const el = spacer.current;
    if (!el || !hidden) return;
    // Interruptible: a chunk built under a moving scroll yields to its frames.
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && startTransition(() => setHidden((h) => Math.max(0, (h ?? hidden) - CHUNK))), {
      root: el.closest('.tl-scroll'),
      rootMargin: '1500px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hidden]);

  // Ahead of the reader: in idle moments the nearest older groups are built a couple at a time (off
  // screen they skip layout and paint), so reading back up never waits for a chunk to build.
  // Never under a moving scroll (its idle moments between frames are not idle for the reader): the
  // build waits until the view has been still a moment.
  useEffect(() => {
    if (!hidden || groups.length - hidden >= TAIL + AHEAD || typeof requestIdleCallback !== 'function') return;
    let id = 0;
    const build = () => {
      if (performance.now() - (scrolled?.current ?? 0) < STILL_MS) return void (id = requestIdleCallback(build, { timeout: 4000 }));
      startTransition(() => setHidden((h) => Math.max(0, (h ?? hidden) - IDLE_CHUNK)));
    };
    id = requestIdleCallback(build, { timeout: 4000 });
    return () => cancelIdleCallback(id);
  }, [hidden, groups.length, scrolled]);

  // Reveal requests (sable:reveal-item): build every turn from the target down, open the steps
  // that hide it, then bring it into view.
  const [reveal, setReveal] = useState<{ id: string; root: string; at: number } | null>(null);
  useEffect(() => {
    const onReveal = (e: Event) => {
      const d = (e as CustomEvent<RevealDetail>).detail;
      if (!d || d.sessionId !== sessionId) return;
      const root = rootOf(useStore.getState().data[sessionId]?.items ?? {}, d.itemId);
      const idx = groups.findIndex((g) => (g.kind === 'item' ? g.id === root : g.ids.includes(root) || !!g.checks?.includes(root)));
      if (idx < 0) return;
      const g = groups[idx];
      if (g.kind === 'turn') for (const seg of g.segments) if (seg.work.includes(root)) setFold(foldKey(sessionId, seg.key), true);
      setHidden((h) => Math.min(h ?? Math.max(0, groups.length - TAIL), idx));
      setReveal({ id: d.itemId, root, at: Date.now() });
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, [sessionId, groups]);

  useLayoutEffect(() => {
    if (!reveal) return;
    let raf = 0;
    let tries = 0;
    let fix = 0;
    let clear = 0;
    const find = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)].find((el) => el.closest('.tl-scroll'));
    // Folds mount their content a frame or two after they open: look until it is there.
    const go = () => {
      const el = find(reveal.id) ?? find(reveal.root);
      if (!el) {
        if (++tries < 30) raf = requestAnimationFrame(go);
        return;
      }
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
      el.removeAttribute('data-reveal');
      void el.offsetWidth;
      el.setAttribute('data-reveal', '');
      fix = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) el.scrollIntoView({ block: 'center' });
      }, 700);
      clear = window.setTimeout(() => el.removeAttribute('data-reveal'), 1800);
    };
    go();
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(fix);
      window.clearTimeout(clear);
    };
  }, [reveal]);

  return (
    <>
      {hidden > 0 && <div ref={spacer} className="tl-older" style={{ height: spacerHeight }} aria-hidden />}
      {groups.map((g, i) => (i < hidden ? null : g.kind === 'item' ? <ItemRow key={g.key} id={g.id} /> : <TurnView key={g.key} turn={g} />))}
      {layout.queued.map((id) => (
        <ItemRow key={id} id={id} />
      ))}
      {!running && <Tail />}
    </>
  );
});

// ─────────────────────────────────── a turn ───────────────────────────────────

const TurnView = memo(function TurnView({ turn }: { turn: TurnGroup }) {
  const last = turn.segments.length - 1;
  return (
    <section className="tg" data-state={turn.state}>
      {turn.segments.map((seg, i) => (
        <SegmentView key={seg.key} seg={seg} turn={turn} index={i} live={turn.state === 'running' && i === last} />
      ))}
      <TurnFoot turn={turn} />
      {turn.checks?.map((id) => (
        <ItemRow key={id} id={id} />
      ))}
    </section>
  );
});

/** Start and end of a settled segment, in ms; null when there is nothing to measure. */
function segmentSpan(items: Record<string, TimelineItem>, turn: TurnGroup, index: number): number | null {
  const seg = turn.segments[index];
  const first = seg.flow.find((c): c is Exclude<FlowChunk, { kind: 'line' }> => c.kind !== 'line');
  const firstId = !first ? '' : first.kind === 'steps' ? first.ids[0] : first.id;
  const start = (seg.lead ? items[seg.lead]?.ts : undefined) ?? items[firstId]?.ts;
  if (!start) return null;
  const nextLead = turn.segments[index + 1]?.lead;
  if (nextLead && items[nextLead]) return items[nextLead].ts - start;
  const end = turn.end ? items[turn.end] : undefined;
  if (end?.type === 'turn') {
    // The time the live line counted (a fresh agent's start-up included, which the agent's own
    // figure leaves out), so the number does not drop when the turn settles. The agent's figure
    // only where the items' times say less (a conversation loaded from history).
    const wall = end.ts - start;
    if (turn.segments.length === 1 && end.durationMs > wall) return end.durationMs;
    return wall;
  }
  let last = start;
  for (const c of seg.flow) {
    for (const id of c.kind === 'steps' ? c.ids : c.kind === 'line' ? [] : [c.id]) {
      const it = items[id];
      if (!it) continue;
      last = Math.max(last, it.ts, ('endedAt' in it && it.endedAt) || 0);
    }
  }
  return last - start;
}

/**
 * One segment as it reads: the message, what the agent says (each text as it arrives, in order),
 * and one line for the work. The steps themselves stay folded until the reader opens them; then
 * every run appears in its place between the texts. While the agent works the line says what it
 * is doing now; when the segment settles it becomes the summary ("Worked 4m · 12 steps").
 */
const SegmentView = memo(function SegmentView({ seg, turn, index, live }: { seg: Segment; turn: TurnGroup; index: number; live: boolean }) {
  const { sessionId } = useTimeline();
  const hasWork = seg.work.length > 0;
  const [open, setOpen] = useFold(foldKey(sessionId, seg.key), false);
  const toggle = hasWork ? () => setOpen(!open) : undefined;
  const shown = open && hasWork;
  const at = seg.flow.indexOf(LINE);
  const piece = (c: FlowChunk) => flowPiece(c, seg, shown);
  return (
    <>
      {seg.lead && <ItemRow key={seg.lead} id={seg.lead} />}
      {(at < 0 ? seg.flow : seg.flow.slice(0, at)).map(piece)}
      {at >= 0 && (
        // The line and everything after it: while the agent works the line stays in view (sticky)
        // as what it says grows past the top of the window.
        <div key="work" className="seg-work">
          <WorkHead seg={seg} turn={turn} index={index} live={live} open={shown} onToggle={toggle} />
          {seg.flow.slice(at + 1).map(piece)}
        </div>
      )}
      {seg.errors.map((id) => (
        <ItemRow key={id} id={id} />
      ))}
    </>
  );
});

/** What a text reads as: the answer and a steered message's reply at full strength, reports along the way one step back. */
const toneOf = (seg: Segment, id: string) => (id === seg.answer || id === seg.reply ? 'answer' : 'mid');

/**
 * One piece of a segment's flow. Texts and runs are memoized on their own props (an id and a tone,
 * a run's ids and the fold), so a new step re-renders the segment's list, not what is in it.
 */
function flowPiece(c: FlowChunk, seg: Segment, open: boolean) {
  if (c.kind === 'line') return null;
  if (c.kind === 'steps') return <Steps key={`s:${c.key}`} ids={c.ids} open={open} />;
  if (c.kind === 'show') return <ItemRow key={c.id} id={c.id} answer={c.id === seg.answer} />;
  const tone = toneOf(seg, c.id);
  return <ItemRow key={c.id} id={c.id} answer={tone === 'answer'} mid={tone === 'mid'} />;
}

/** A run of steps between two texts: nothing while folded (not even mounted), one line each when opened. */
const Steps = memo(function Steps({ ids, open }: { ids: string[]; open: boolean }) {
  return (
    <Collapse open={open} className="tl-steps">
      <div className="story">
        <ItemList ids={ids} />
      </div>
    </Collapse>
  );
});

/** The work line in its place: live while the segment runs, the summary once it has settled. */
function WorkHead({ seg, turn, index, live, open, onToggle }: { seg: Segment; turn: TurnGroup; index: number; live: boolean; open: boolean; onToggle?: () => void }) {
  // A segment that starts live in front of the reader (a message just sent): its line enters.
  const fresh = useFresh() && live;
  // The end of the segment: the live line hands over to its summary, once.
  const [landed, setLanded] = useState(false);
  const was = useRef(live);
  const el = useRef<HTMLDivElement>(null);
  const hasWork = seg.work.length > 0;
  useLayoutEffect(() => {
    const ended = was.current && !live;
    was.current = live;
    if (!ended || !hasWork) return;
    // Reduced motion: no travel, the summary line simply fades in.
    if (reducedMotion()) {
      el.current?.querySelector('.work-head')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
      return;
    }
    setLanded(true);
    const t = window.setTimeout(() => setLanded(false), 700);
    return () => window.clearTimeout(t);
  }, [live, hasWork]);
  if (!live && !hasWork) return null;
  return (
    <div ref={el} className="tl-item tl-work" data-live={live || undefined} data-enter={fresh || undefined} data-open={open || undefined}>
      {live ? <LiveLine seg={seg} open={open} onToggle={onToggle} /> : <WorkLine seg={seg} turn={turn} index={index} open={open} onToggle={onToggle} landed={landed} />}
    </div>
  );
}

/** "Worked 4m 12s · 23 steps", and what changed: the folded work of a settled segment. */
function WorkLine({ seg, turn, index, open, onToggle, landed }: { seg: Segment; turn: TurnGroup; index: number; open: boolean; onToggle?: () => void; landed: boolean }) {
  const { sessionId } = useTimeline();
  const { span, changes, thought } = useMemo(() => {
    const d = useStore.getState().data[sessionId];
    const items = d?.items ?? {};
    return {
      span: segmentSpan(items, turn, index),
      changes: changesOf(items, d?.children ?? {}, seg.work),
      // Work that was only thinking says so ("Thought for 6s"), with no count of steps.
      thought: !seg.steps && seg.work.some((id) => items[id]?.type === 'thinking'),
    };
  }, [sessionId, turn, index, seg]);
  const took = span && span >= 1000 ? shortDuration(span) : '';
  return (
    <div className="work-head" data-landed={landed || undefined}>
      <button type="button" className="work-line" aria-expanded={open} onClick={onToggle}>
        <span className="work-label num">{thought ? (took ? `Thought for ${took}` : 'Thought') : took ? `Worked ${took}` : 'Worked'}</span>
        {seg.steps > 0 && <span className="work-time num">{plural(seg.steps, 'step')}</span>}
        <Icon name="caret-right" size={10} className="row-caret" />
      </button>
      {changes.files > 0 && (
        <button type="button" className="work-changes num" onClick={() => showRailTab('changes')} aria-label={`${plural(changes.files, 'file')} changed. Open Changes`}>
          <Icon name="diff" size={13} />
          <span>{plural(changes.files, 'file')}</span>
          {changes.add > 0 && <span className="t-add">+{changes.add}</span>}
          {changes.del > 0 && <span className="t-del">−{changes.del}</span>}
        </button>
      )}
    </div>
  );
}

/** The shortest time the live line shows one title (ms). */
const TITLE_HOLD_MS = 600;
/** How long a finished step still names what the agent is doing, when nothing newer has started (ms). */
const RECENT_MS = 2000;

/**
 * The lead-in that names what the agent does now, or '' when there is none: the newest one written
 * since the agent last said something in view, while the steps it announced run. A step started
 * after one of those had ended, or thinking, is the agent's next move: the lead-in has had its say.
 */
function currentLead(items: Record<string, TimelineItem>, seg: Segment): string {
  const id = seg.narr[seg.narr.length - 1];
  const it = id ? items[id] : undefined;
  if (it?.type !== 'text' || it.streaming) return '';
  const at = seg.work.lastIndexOf(id);
  let ended = Infinity;
  for (let i = at + 1; i < seg.work.length; i++) {
    const step = items[seg.work[i]];
    if (!step) continue;
    if (step.type !== 'tool' || step.ts > ended) return '';
    if (step.endedAt) ended = Math.min(ended, step.endedAt);
  }
  return leadTitle(it.text);
}

/** What the running segment is doing right now: `${waiting}|${title}`. `held` keeps the title last given. */
function liveSelector(sessionId: string, seg: Segment, held: { title: string }) {
  // The pieces in view (texts, widgets, plans), newest first: a widget being drawn or a text being written.
  const pieces: string[] = [];
  for (let i = seg.flow.length - 1; i >= 0 && pieces.length < 4; i--) {
    const c = seg.flow[i];
    if (c.kind === 'text' || c.kind === 'show') pieces.push(c.id);
  }
  return (s: Store): string => {
    const d = s.data[sessionId];
    const meta = s.sessions[sessionId];
    if (!d || !meta) return '0|Working';
    let waiting = meta.status === 'awaiting' || d.permissions.length > 0 || d.questions.length > 0;
    let title = '';
    let agents = 0;
    // The newest step, when it finished a moment ago: quick steps in a row read as one calm sequence
    // of their titles instead of flickering back to "Working" between them.
    let recent = '';
    // A lead-in being written: the line keeps what it says until the sentence is whole.
    let writing = false;
    for (let i = seg.work.length - 1, n = 0; i >= 0 && n < 60; i--, n++) {
      const it = d.items[seg.work[i]];
      if (!it) continue;
      if (it.type === 'tool' && (it.status === 'running' || it.status === 'pending' || it.status === 'awaiting')) {
        if (it.status === 'awaiting') waiting = true;
        if (it.kind === 'agent') agents++;
        if (!title) title = it.title;
      } else if (it.type === 'thinking' && it.streaming && !title) title = thinkingHeadline((it as ThinkingItem).text) || 'Thinking';
      else if (n === 0 && it.type === 'text' && it.streaming) writing = true;
      else if (n === 0 && it.type === 'tool' && it.endedAt && Date.now() - it.endedAt < RECENT_MS) recent = it.title;
    }
    // Several sub-agents at once: the line counts them.
    if (agents > 1) title = `Running ${agents} sub-agents`;
    // The agent's own words for what it does now, while the steps it announced run.
    else if (writing && held.title) title = held.title;
    else title = currentLead(d.items, seg) || title;
    for (const id of pieces) {
      if (title) break;
      const it = d.items[id];
      if (it?.type === 'tool' && (it.status === 'pending' || it.status === 'running')) title = it.title;
      else if (it?.type === 'text' && it.streaming) title = 'Writing';
    }
    if (!title) title = recent || (meta.status === 'starting' ? 'Starting' : meta.activity || 'Working');
    held.title = title;
    return `${waiting ? 1 : 0}|${title}`;
  };
}

/** How long the old title takes to fade before the new one comes in (ms). */
const SWAP_OUT_MS = 110;

/**
 * A title that changes by fading through: the old one fades out, the new one fades in, and the
 * figures after it move only while neither is visible.
 */
function useSwap(value: string): [string, boolean] {
  const [shown, setShown] = useState(value);
  const [out, setOut] = useState(false);
  useEffect(() => {
    // Back to the title on screen before the old one had gone: it simply stays.
    if (value === shown) return setOut(false);
    if (reducedMotion()) {
      setShown(value);
      return;
    }
    setOut(true);
    const t = window.setTimeout(() => {
      setShown(value);
      setOut(false);
    }, SWAP_OUT_MS);
    return () => window.clearTimeout(t);
  }, [value, shown]);
  return [shown, out];
}

/**
 * The running segment's one line: the working indicator, what it is doing now, the time so far and
 * how many steps it took; a click opens the steps (the stop button and Esc stop the turn, with no
 * hint here). It stays in view (sticky) while what the agent says grows past the top.
 */
function LiveLine({ seg, open, onToggle }: { seg: Segment; open: boolean; onToggle?: () => void }) {
  const { sessionId } = useTimeline();
  const [last] = useState(() => ({ title: '' }));
  const info = useStore(useMemo(() => liveSelector(sessionId, seg, last), [sessionId, seg, last]));
  const lead = useItem(seg.lead ?? seg.work[0] ?? '');
  const now = useTick();
  const cut = info.indexOf('|');
  const waiting = info.slice(0, cut) === '1';
  // Quick steps in a row: each title holds a moment instead of flickering past (waiting shows at once).
  const held = useHeld(info.slice(cut + 1), TITLE_HOLD_MS);
  const [title, out] = useSwap(held);
  const elapsed = lead ? now - lead.ts : 0;
  // The working tiles keep their own animation: the line's ticks and title changes leave them alone.
  const tiles = useMemo(() => <Tiles size={12} />, []);
  // A new title of another width: the time and steps after it glide to their new place instead of
  // jumping there. A longer title waits until they have made room, so no words ever cross. The old
  // width is read as the old title fades out, the new one as it arrives: never at mount, where a
  // sent message is still in the air.
  const label = useRef<HTMLSpanElement>(null);
  const width = useRef(-1);
  useLayoutEffect(() => {
    if (out && label.current) width.current = label.current.offsetWidth;
  }, [out]);
  useLayoutEffect(() => {
    const was = width.current;
    width.current = -1;
    const el = label.current;
    if (!el || was < 0) return;
    const w = el.offsetWidth;
    if (Math.abs(was - w) < 1) return;
    for (let n = el.nextElementSibling; n; n = n.nextElementSibling) n.animate([{ transform: `translateX(${was - w}px)` }, { transform: 'translateX(0)' }], { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)', composite: 'add' });
    if (w > was) el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], { duration: 380, easing: 'ease-out' });
  }, [title, waiting]);
  const body = (
    <>
      {waiting ? (
        <span className="work-ind work-wait-icon">
          <Icon name="hourglass" size={13} />
        </span>
      ) : (
        <span className="work-ind">{tiles}</span>
      )}
      {waiting ? (
        <span ref={label} className="work-label work-waiting">
          Waiting for you
        </span>
      ) : (
        <span ref={label} className="work-label work-live-title shimmer truncate" data-out={out || undefined}>
          {title}
        </span>
      )}
      {elapsed >= 1000 && <span className="work-time num">{shortDuration(elapsed)}</span>}
      {seg.steps > 0 && <span className="work-time num">{plural(seg.steps, 'step')}</span>}
      {onToggle && <Icon name="caret-right" size={10} className="row-caret" />}
    </>
  );
  return (
    <div className="work-head" data-live role="status" aria-live="off">
      {onToggle ? (
        <button type="button" className="work-line work-live" aria-expanded={open} onClick={onToggle}>
          {body}
        </button>
      ) : (
        <div className="work-line work-live" data-static>
          {body}
        </div>
      )}
      <span className="work-band" aria-hidden />
      <span className="work-fade" aria-hidden />
    </div>
  );
}
