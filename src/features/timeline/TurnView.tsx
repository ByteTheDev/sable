import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TimelineItem } from '@shared/protocol';
import { Tiles } from '@/art/Logo';
import { Collapse } from '@/components/Collapse';
import { Icon } from '@/icons';
import { plural } from '@/lib/format';
import { reducedMotion } from '@/lib/motion';
import { useNow } from '@/lib/view-hooks';
import { showRailTab } from '@/state/actions';
import { useStore, type Store } from '@/state/store';
import { Kbd } from '@/ui';
import { useItem, useTimeline } from './ctx';
import { foldKey, setFold, useFold } from './fold';
import { ItemList, ItemRow, LiveText, estimate } from './items';
import { REVEAL_EVENT, rootOf, type RevealDetail } from './reveal';
import { Stamp } from './Stamp';
import { changesOf } from './changes';
import { Tail } from './Tail';
import { TurnFoot } from './Turn';
import { groupTurns, shapeOf, type Group, type Segment, type StoryChunk, type TurnGroup, type TurnLayout } from './turns';
import { shortDuration } from './util';

/** Groups built when a transcript opens, and how many more each step up builds. */
const TAIL = 8;
const CHUNK = 8;

/** One character per root item (see `turns.ts`), recomputed only when the items object changes. */
function shapeSelector(sessionId: string, ids: string[]) {
  let lastItems: Record<string, TimelineItem> | undefined;
  let out = '';
  return (s: Store): string => {
    const items = s.data[sessionId]?.items;
    if (!items) return '';
    if (items === lastItems) return out;
    lastItems = items;
    let next = '';
    for (let i = 0; i < ids.length; i++) next += shapeOf(items[ids[i]]);
    out = next;
    return out;
  };
}

const segSig = (s: Segment) => `${s.lead}>${s.work.join(',')}>${s.reply}>${s.answer}>${s.errors.join(',')}>${s.shown.join(',')}`;

/**
 * Keeps the objects of turns and segments that did not change, so their memoized views skip
 * rendering: a new step in the running turn re-renders that turn alone.
 */
function stabilize(layout: TurnLayout, cache: Map<string, unknown>): TurnLayout {
  const next = new Map<string, unknown>();
  const groups = layout.groups.map((g): Group => {
    if (g.kind !== 'turn') return g;
    const segments = g.segments.map((s) => {
      const k = `s|${segSig(s)}`;
      const prev = (next.get(k) ?? cache.get(k)) as Segment | undefined;
      const seg = prev ?? s;
      next.set(k, seg);
      return seg;
    });
    const k = `t|${g.state}|${g.end}|${g.ids.length}|${segments.map(segSig).join(';')}`;
    const prev = (next.get(k) ?? cache.get(k)) as TurnGroup | undefined;
    const turn = prev ?? { ...g, segments };
    next.set(k, turn);
    return turn;
  });
  cache.clear();
  for (const [k, v] of next) cache.set(k, v);
  return { groups, queued: layout.queued };
}

function groupHeight(g: Group, items: Record<string, TimelineItem>): number {
  if (g.kind === 'item') return estimate(items[g.id]);
  let h = 30;
  for (const s of g.segments) {
    if (s.lead) h += estimate(items[s.lead]);
    if (s.work.length) h += 34;
    for (const id of s.shown) h += estimate(items[id]);
    if (s.reply) h += estimate(items[s.reply]);
    h += s.errors.length * 64;
  }
  return h;
}

/**
 * The conversation as turns: each message, a quiet line for the work behind the reply, and the
 * reply itself. A long transcript opens with only its last turns built; the ones above wait
 * behind a spacer of about their height and are built a few at a time as the reader scrolls up.
 */
export const TurnList = memo(function TurnList({ ids }: { ids: string[] }) {
  const { sessionId } = useTimeline();
  const shape = useStore(useMemo(() => shapeSelector(sessionId, ids), [sessionId, ids]));
  const busy = useStore((s) => {
    const st = s.sessions[sessionId]?.status;
    return st === 'running' || st === 'starting' || st === 'awaiting';
  });
  const cache = useRef(new Map<string, unknown>());
  const layout = useMemo(() => stabilize(groupTurns(ids, shape, busy), cache.current), [ids, shape, busy]);
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
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && setHidden((h) => Math.max(0, (h ?? hidden) - CHUNK)), {
      root: el.closest('.tl-scroll'),
      rootMargin: '1500px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hidden]);

  // Reveal requests (sable:reveal-item): build every turn from the target down, open the folds
  // that hide it, then bring it into view.
  const [reveal, setReveal] = useState<{ id: string; root: string; at: number } | null>(null);
  useEffect(() => {
    const onReveal = (e: Event) => {
      const d = (e as CustomEvent<RevealDetail>).detail;
      if (!d || d.sessionId !== sessionId) return;
      const root = rootOf(useStore.getState().data[sessionId]?.items ?? {}, d.itemId);
      const idx = groups.findIndex((g) => (g.kind === 'item' ? g.id === root : g.ids.includes(root)));
      if (idx < 0) return;
      const g = groups[idx];
      if (g.kind === 'turn') {
        for (const seg of g.segments) {
          if (!seg.work.includes(root)) continue;
          setFold(foldKey(sessionId, seg.key), true);
          const chunk = seg.story.find((c): c is Extract<StoryChunk, { kind: 'steps' }> => c.kind === 'steps' && c.ids.includes(root));
          if (chunk) setFold(foldKey(sessionId, chunk.key, 'steps'), true);
        }
      }
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
    </section>
  );
});

/** Start and end of a settled segment, in ms; null when there is nothing to measure. */
function segmentSpan(items: Record<string, TimelineItem>, turn: TurnGroup, index: number): number | null {
  const seg = turn.segments[index];
  const start = (seg.lead ? items[seg.lead]?.ts : undefined) ?? items[seg.work[0]]?.ts;
  if (!start) return null;
  const nextLead = turn.segments[index + 1]?.lead;
  if (nextLead && items[nextLead]) return items[nextLead].ts - start;
  const end = turn.end ? items[turn.end] : undefined;
  if (end?.type === 'turn') {
    if (turn.segments.length === 1 && end.durationMs > 0) return end.durationMs;
    return end.ts - start;
  }
  let last = start;
  for (const id of [...seg.work, ...(seg.answer ? [seg.answer] : [])]) {
    const it = items[id];
    if (!it) continue;
    last = Math.max(last, it.ts, ('endedAt' in it && it.endedAt) || 0);
  }
  return last - start;
}

const SegmentView = memo(function SegmentView({ seg, turn, index, live }: { seg: Segment; turn: TurnGroup; index: number; live: boolean }) {
  const { sessionId } = useTimeline();
  const hasWork = seg.work.length > 0;
  // The trail is open while the agent works and folds away when it is done, unless the reader chose.
  const [open, setOpen] = useFold(foldKey(sessionId, seg.key), live);

  // The end of the turn: the trail gathers into its summary line, once.
  const [gather, setGather] = useState(false);
  const was = useRef(live);
  const workEl = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const ended = was.current && !live;
    was.current = live;
    if (!ended || !hasWork) return;
    // Reduced motion: no travel, the summary line simply fades in.
    if (reducedMotion()) {
      workEl.current?.querySelector('.work-head')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
      return;
    }
    setGather(true);
    const t = window.setTimeout(() => setGather(false), 900);
    return () => window.clearTimeout(t);
  }, [live, hasWork]);

  return (
    <>
      {seg.lead && <ItemRow key={seg.lead} id={seg.lead} />}
      {seg.reply && <ItemRow key={seg.reply} id={seg.reply} answer />}
      {(hasWork || live) && (
        <div key="work" ref={workEl} className="tl-item tl-work" data-live={live || undefined} data-open={(open && hasWork) || undefined} data-gather={gather || undefined}>
          {live ? (
            <LiveLine seg={seg} open={open && hasWork} onToggle={hasWork ? () => setOpen(!open) : undefined} />
          ) : (
            <WorkLine seg={seg} turn={turn} index={index} open={open} onToggle={() => setOpen(!open)} landed={gather} />
          )}
          {hasWork && (
            <Collapse open={open} className="work-fold">
              <Story seg={seg} live={live} />
            </Collapse>
          )}
        </div>
      )}
      {seg.shown.map((id) => (
        <ItemRow key={id} id={id} answer={id === seg.answer} />
      ))}
      {seg.errors.map((id) => (
        <ItemRow key={id} id={id} />
      ))}
    </>
  );
});

/** "Worked 4m 12s · 23 steps", and what changed: the folded work of a settled segment. */
function WorkLine({ seg, turn, index, open, onToggle, landed }: { seg: Segment; turn: TurnGroup; index: number; open: boolean; onToggle: () => void; landed: boolean }) {
  const { sessionId } = useTimeline();
  const { span, changes } = useMemo(() => {
    const d = useStore.getState().data[sessionId];
    const items = d?.items ?? {};
    return { span: segmentSpan(items, turn, index), changes: changesOf(items, d?.children ?? {}, seg.work) };
  }, [sessionId, turn, index, seg]);
  const texts = seg.story.reduce((n, c) => n + (c.kind === 'text' ? 1 : 0), 0);
  const count = seg.steps ? plural(seg.steps, 'step') : texts ? plural(texts, 'message') : '';
  // Work that was only thinking says so ("Thought for 6s"): no count of one step over a single thought.
  const thought = !seg.steps && !texts;
  const took = span && span >= 1000 ? shortDuration(span) : '';
  return (
    <div className="work-head" data-landed={landed || undefined}>
      <button type="button" className="work-line" aria-expanded={open} onClick={onToggle}>
        <span className="work-label num">{thought ? (took ? `Thought for ${took}` : 'Thought') : took ? `Worked ${took}` : 'Worked'}</span>
        {count && <span className="work-time num">{count}</span>}
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

/** What the running segment is doing right now: `${waiting}|${title}`. */
function liveSelector(sessionId: string, seg: Segment) {
  return (s: Store): string => {
    const d = s.data[sessionId];
    const meta = s.sessions[sessionId];
    if (!d || !meta) return '0|Working';
    let waiting = meta.status === 'awaiting' || d.permissions.length > 0 || d.questions.length > 0;
    let title = '';
    const answer = seg.answer ? d.items[seg.answer] : undefined;
    for (let i = seg.work.length - 1, n = 0; i >= 0 && n < 60; i--, n++) {
      const it = d.items[seg.work[i]];
      if (!it) continue;
      if (it.type === 'tool' && (it.status === 'running' || it.status === 'pending' || it.status === 'awaiting')) {
        if (it.status === 'awaiting') waiting = true;
        if (!title) title = it.title;
      } else if (it.type === 'thinking' && it.streaming && !title) title = 'Thinking';
    }
    for (const id of seg.shown) {
      const it = d.items[id];
      if (!title && it?.type === 'tool' && (it.status === 'pending' || it.status === 'running')) title = it.title;
    }
    if (!title && answer?.type === 'text' && answer.streaming) title = 'Writing';
    if (!title) title = meta.status === 'starting' ? 'Starting' : meta.activity || 'Working';
    return `${waiting ? 1 : 0}|${title}`;
  };
}

/**
 * The running segment's line: the working indicator, what it is doing now, the time so far and
 * how to stop. It stays in view (sticky) while the trail under it grows past the top.
 */
function LiveLine({ seg, open, onToggle }: { seg: Segment; open: boolean; onToggle?: () => void }) {
  const { sessionId } = useTimeline();
  const info = useStore(useMemo(() => liveSelector(sessionId, seg), [sessionId, seg]));
  const lead = useItem(seg.lead ?? seg.work[0] ?? '');
  const now = useNow(true);
  const cut = info.indexOf('|');
  const waiting = info.slice(0, cut) === '1';
  const title = info.slice(cut + 1);
  const elapsed = lead ? now - lead.ts : 0;
  // The working tiles keep their own animation: the line's ticks and title changes leave them alone.
  const tiles = useMemo(() => <Tiles size={12} />, []);
  const body = (
    <>
      {waiting ? (
        <span className="work-ind work-wait-icon">
          <Icon name="hourglass" size={13} />
        </span>
      ) : (
        <span className="work-ind">{tiles}</span>
      )}
      <span className={waiting ? 'work-label work-waiting' : 'work-label work-live-title shimmer truncate'}>{waiting ? 'Waiting for you' : title}</span>
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
      <span className="work-esc">
        <Kbd combo="esc" /> to stop
      </span>
      <span className="work-band" aria-hidden />
      <span className="work-fade" aria-hidden />
    </div>
  );
}

// ─────────────────────────────────── the story ───────────────────────────────────

/**
 * The work: what was said along the way and the steps between, in order, one line per step.
 * Texts keep the answer's size (only their tone steps back), so a text that stops being the
 * newest moves into the story without a line of it reflowing.
 */
function Story({ seg, live }: { seg: Segment; live: boolean }) {
  return (
    <div className="story">
      {seg.story.map((c) => (c.kind === 'text' ? <StoryText key={c.id} id={c.id} live={live} /> : <ItemList key={c.key} ids={c.ids} />))}
    </div>
  );
}

const StoryText = memo(function StoryText({ id, live }: { id: string; live: boolean }) {
  const item = useItem(id);
  // Mounting while the turn runs: this text just stopped being the newest and settles to the story's tone.
  const [fresh] = useState(() => live);
  if (!item) return null;
  if (item.type === 'notice') {
    return (
      <div className="story-text" data-item-id={id}>
        <ItemRow id={id} nested />
      </div>
    );
  }
  if (item.type !== 'text') return null;
  return (
    <div className="story-text" data-item-id={id} data-fresh={fresh || undefined}>
      <LiveText id={id} text={item.text} streaming={item.streaming} />
      <Stamp ts={item.ts} />
    </div>
  );
});
