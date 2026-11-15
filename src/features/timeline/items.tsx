import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineItem, ToolItem } from '@shared/protocol';
import { Collapse } from '@/components/Collapse';
import { Markdown } from '@/components/Markdown';
import { Icon } from '@/icons';
import { plural } from '@/lib/format';
import { useStore } from '@/state/store';
import { useFresh, useItem, useTimeline } from './ctx';
import { Notice } from './Notice';
import { useSmoothLength } from './smooth';
import { Stamp } from './Stamp';
import { Thinking } from './Thinking';
import { ToolView } from './Tool';
import { UserMessage } from './User';
import { isExplore } from './util';

type Row = { key: string; id: string; run?: undefined } | { key: string; run: string[]; id?: undefined };

/**
 * Renders a list of steps in order (inside a turn's work, or a sub-agent's thread). Consecutive
 * look-only tools (read, search, glob, fetch) form a run; a run of three or more folds into a
 * single "Explored" row.
 */
export const ItemList = memo(function ItemList({ ids }: { ids: string[]; nested?: boolean }) {
  const { sessionId } = useTimeline();
  // One character per item: whether it can join a run. Changes rarely, so the list re-renders rarely.
  const shape = useStore((s) => {
    const items = s.data[sessionId]?.items;
    if (!items) return '';
    let out = '';
    for (let i = 0; i < ids.length; i++) out += isExplore(items[ids[i]]) ? 'e' : '-';
    return out;
  });
  const cache = useRef(new Map<string, string[]>());

  const rows = useMemo(() => {
    const out: Row[] = [];
    const next = new Map<string, string[]>();
    for (let i = 0; i < ids.length; ) {
      if (shape[i] !== 'e') {
        out.push({ key: ids[i], id: ids[i] });
        i++;
        continue;
      }
      let j = i;
      while (j < ids.length && shape[j] === 'e') j++;
      let run = ids.slice(i, j);
      // Keep the same array while a run is unchanged so its row stays memoized.
      const prev = cache.current.get(ids[i]);
      if (prev && prev.length === run.length && prev[prev.length - 1] === run[run.length - 1]) run = prev;
      next.set(ids[i], run);
      out.push({ key: `run:${ids[i]}`, run });
      i = j;
    }
    cache.current = next;
    return out;
  }, [ids, shape]);

  return (
    <>
      {rows.map((r) => (r.run ? <ExploreRun key={r.key} ids={r.run} /> : <ItemRow key={r.key} id={r.id} nested />))}
    </>
  );
});

/** A rough height for a row that is not built yet, so the scrollbar and scroll position stay sensible. */
export function estimate(item: TimelineItem | undefined): number {
  switch (item?.type) {
    case 'user':
      return 70 + Math.ceil(item.text.length / 70) * 24;
    case 'text':
      return item.text ? 20 + Math.ceil(item.text.length / 95) * 27 + (item.text.match(/\n\n/g)?.length ?? 0) * 12 : 0;
    case 'tool':
      return item.kind === 'agent' || item.kind === 'plan' ? 72 : 28;
    case undefined:
      return 0;
    default:
      return 34;
  }
}

/**
 * Assistant prose. While it streams, the text is paced (see `useSmoothLength`) and a small
 * light sits at the write head; when the stream ends the light fades out.
 */
export const LiveText = memo(function LiveText({ text, streaming }: { text: string; streaming: boolean }) {
  const { stuck } = useTimeline();
  const len = useSmoothLength(text, streaming, stuck);
  // While pacing catches up after the stream ended, the text keeps its live rendering.
  const live = streaming || len < text.length;
  const was = useRef(live);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const ended = was.current && !live;
    was.current = live;
    if (!ended) return;
    setLeaving(true);
    const t = window.setTimeout(() => setLeaving(false), 260);
    return () => window.clearTimeout(t);
  }, [live]);
  return <Markdown text={live ? text.slice(0, len) : text} streaming={live} head={live ? 'live' : leaving ? 'out' : undefined} />;
});

/** One item, subscribed to itself only. `answer`: the reply a turn segment ends with. */
export const ItemRow = memo(function ItemRow({ id, nested = false, answer = false }: { id: string; nested?: boolean; answer?: boolean }) {
  const item = useItem(id);
  const fresh = useFresh(item?.ts);
  if (!item) return null;
  let body;
  switch (item.type) {
    case 'user':
      body = <UserMessage item={item} />;
      break;
    case 'text':
      if (!item.text && !item.streaming) return null;
      body = (
        <>
          <LiveText text={item.text} streaming={!!item.streaming} />
          {!nested && <Stamp ts={item.ts} />}
        </>
      );
      break;
    case 'thinking':
      body = <Thinking item={item} />;
      break;
    case 'tool':
      body = <ToolView item={item} />;
      break;
    case 'notice':
      body = <Notice item={item} />;
      break;
    default:
      return null;
  }
  return (
    <div
      className={nested ? 'tl-sub' : 'tl-item'}
      data-item-id={item.id}
      data-t={item.type}
      data-k={item.type === 'tool' ? item.kind : undefined}
      data-answer={answer || undefined}
      data-fresh={fresh || undefined}
    >
      {body}
    </div>
  );
});

/** A tool row that reads its own item (used inside runs, where rows are not wrapped as timeline items). */
const ToolById = memo(function ToolById({ id }: { id: string }) {
  const item = useItem<ToolItem>(id);
  if (!item || item.type !== 'tool') return null;
  return (
    <div data-item-id={item.id}>
      <ToolView item={item} />
    </div>
  );
});

function summarize(sessionId: string, ids: string[]) {
  return (s: ReturnType<typeof useStore.getState>): string => {
    const items = s.data[sessionId]?.items;
    let files = 0;
    let searches = 0;
    let pages = 0;
    let active = '';
    if (items) {
      for (const id of ids) {
        const it = items[id];
        if (!it || it.type !== 'tool') continue;
        if (it.kind === 'read') files++;
        else if (it.kind === 'fetch') pages++;
        else searches++;
        if (it.status !== 'done') active = it.title;
      }
    }
    return `${files}|${searches}|${pages}|${active}`;
  };
}

const ExploreRun = memo(function ExploreRun({ ids }: { ids: string[] }) {
  const { sessionId } = useTimeline();
  const grouped = ids.length >= 3;
  const [open, setOpen] = useState(false);
  const fresh = useFresh();
  const summary = useStore(useMemo(() => summarize(sessionId, ids), [sessionId, ids]));
  const [files, searches, pages, ...rest] = summary.split('|');
  const active = rest.join('|');
  const parts = [Number(files) && plural(Number(files), 'file'), Number(searches) && plural(Number(searches), 'search', 'searches'), Number(pages) && plural(Number(pages), 'page')].filter(Boolean);

  return (
    <div className="tl-sub" data-t="tool" data-k="run" data-fresh={fresh || undefined}>
      <Collapse open={grouped}>
        <button type="button" className="row-btn tool-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="tool-icon">
            <Icon name="search" size={14} />
          </span>
          {active ? (
            <>
              <span className="tool-title shimmer">Exploring</span>
              <span className="tool-sub truncate">{active}</span>
            </>
          ) : (
            <span className="tool-title truncate">Explored {parts.join(', ')}</span>
          )}
          <span className="tool-meta">{active ? parts.join(', ') : null}</span>
          <Icon name="caret-right" size={10} className="row-caret" />
        </button>
      </Collapse>
      <Collapse open={!grouped || open}>
        <div className={grouped ? 'run-rows' : undefined}>
          {ids.map((id) => (
            <ToolById key={id} id={id} />
          ))}
        </div>
      </Collapse>
    </div>
  );
});
