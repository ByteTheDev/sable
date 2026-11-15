import { useMemo, useSyncExternalStore } from 'react';
import type { TimelineItem } from '@shared/protocol';
import { findDevUrls } from '@/lib/links';
import { useStore } from '@/state/store';
import { getRuns, useTermVersion, type TermRun } from './term-store';

/**
 * The panel browser's page per session, kept outside React like the terminal transcript so it
 * survives tab switches and closing the panel for the app's lifetime. In the web build the
 * history is ours (a framed page's own history is not readable cross-origin); in the desktop app
 * the <webview> keeps the real history and reports into this state.
 */

export interface PageState {
  /** Current address; empty before the first page. */
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
  /** Web build: our own history. */
  history: string[];
  index: number;
  /** Desktop: from the webview. */
  canBack: boolean;
  canForward: boolean;
  /** Bumped to reload the frame in the web build. */
  nonce: number;
  error?: string;
}

const EMPTY: PageState = { url: '', title: '', loading: false, history: [], index: -1, canBack: false, canForward: false, nonce: 0 };
const pages = new Map<string, PageState>();
const listeners = new Set<() => void>();

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const getPage = (sessionId: string): PageState => pages.get(sessionId) ?? EMPTY;

export function setPage(sessionId: string, patch: Partial<PageState>) {
  const cur = getPage(sessionId);
  const next = { ...cur, ...patch };
  if ((Object.keys(patch) as (keyof PageState)[]).every((k) => cur[k] === next[k])) return;
  pages.set(sessionId, next);
  for (const l of listeners) l();
}

export function usePage(sessionId: string): PageState {
  return useSyncExternalStore(subscribe, () => getPage(sessionId));
}

/** Web build: a new entry in our own history. */
export function pushHistory(sessionId: string, url: string) {
  const p = getPage(sessionId);
  const history = [...p.history.slice(0, p.index + 1), url].slice(-100);
  setPage(sessionId, { url, history, index: history.length - 1, title: '', favicon: undefined, loading: true, error: undefined });
}

export function stepHistory(sessionId: string, delta: number) {
  const p = getPage(sessionId);
  const index = p.index + delta;
  if (index < 0 || index >= p.history.length) return;
  setPage(sessionId, { index, url: p.history[index], title: '', loading: true, error: undefined });
}

/* ── dev servers seen in this session ── */

const itemCache = new WeakMap<object, string[]>();
const runCache = new Map<number, { v: number; urls: string[] }>();

function itemUrls(item: TimelineItem): string[] {
  if (item.type !== 'tool' || item.kind !== 'bash') return [];
  let hit = itemCache.get(item);
  if (!hit) {
    hit = findDevUrls(`${item.output ?? ''}\n${item.result?.text ?? ''}`);
    itemCache.set(item, hit);
  }
  return hit;
}

function runUrls(run: TermRun): string[] {
  const c = runCache.get(run.id);
  if (c && c.v === run.v) return c.urls;
  const urls = findDevUrls(run.chunks.map((ch) => ch.t).join(''));
  runCache.set(run.id, { v: run.v, urls });
  return urls;
}

/**
 * Local dev-server URLs from this session's shell tool output and the panel terminal, newest
 * first, de-duplicated. Only call it while the empty state shows: it follows streaming output.
 */
export function useDevUrls(sessionId: string, limit = 5): string[] {
  const items = useStore((s) => s.data[sessionId]?.items);
  const termV = useTermVersion();
  return useMemo(() => {
    const found: { url: string; ts: number; order: number }[] = [];
    let order = 0;
    for (const item of Object.values(items ?? {})) for (const url of itemUrls(item)) found.push({ url, ts: item.ts, order: order++ });
    for (const run of getRuns(sessionId)) for (const url of runUrls(run)) found.push({ url, ts: run.startedAt, order: order++ });
    found.sort((a, b) => b.ts - a.ts || b.order - a.order);
    const out: string[] = [];
    for (const f of found) if (!out.includes(f.url) && out.push(f.url) >= limit) break;
    return out;
    // termV marks terminal output changes (the transcript lives outside React).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sessionId, termV]);
}
