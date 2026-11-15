import { useMemo, useSyncExternalStore } from 'react';
import type { TimelineItem } from '@shared/protocol';
import { findDevUrls, previewTargets } from '@/lib/links';
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
  /** How far a load has come, for the progress line: 1 started, 2 committed, 3 the document is ready. */
  phase: 1 | 2 | 3;
  error?: string;
  errorCode?: number;
  /** Desktop: the page's renderer went away. */
  crashed?: boolean;
  /** Desktop: the page's zoom factor. */
  zoom: number;
  device: Device;
}

export type Device = 'desktop' | 'tablet' | 'phone';

/** Viewport sizes the page can be checked at; the page is centred and scaled down to fit the panel. */
export const DEVICES: Record<Device, { label: string; w: number; h: number }> = {
  desktop: { label: 'Desktop', w: 0, h: 0 },
  tablet: { label: 'Tablet', w: 768, h: 1024 },
  phone: { label: 'Phone', w: 390, h: 844 },
};

const EMPTY: PageState = { url: '', title: '', loading: false, history: [], index: -1, canBack: false, canForward: false, nonce: 0, phase: 1, zoom: 1, device: 'desktop' };
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
  setPage(sessionId, { url, history, index: history.length - 1, title: '', favicon: undefined, loading: true, phase: 1, error: undefined });
}

export function stepHistory(sessionId: string, delta: number) {
  const p = getPage(sessionId);
  const index = p.index + delta;
  if (index < 0 || index >= p.history.length) return;
  setPage(sessionId, { index, url: p.history[index], title: '', loading: true, phase: 1, error: undefined });
}

/* ── recently visited pages (this viewer's, kept in local storage) ── */

export interface Visit {
  url: string;
  title: string;
  favicon?: string;
  ts: number;
}

const RECENT_KEY = 'sable.browser.recent';
const RECENT_MAX = 6;
const recentListeners = new Set<() => void>();

function loadRecent(): Visit[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((v): v is Visit => !!v && typeof v.url === 'string' && /^https?:\/\//.test(v.url))
      .map((v) => ({ url: v.url, title: typeof v.title === 'string' ? v.title : '', favicon: typeof v.favicon === 'string' && /^(https:|data:image\/)/.test(v.favicon) ? v.favicon : undefined, ts: Number(v.ts) || 0 }))
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

let recent: Visit[] | null = null;

const getRecent = () => (recent ??= loadRecent());

function saveRecent(next: Visit[]) {
  recent = next;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode: kept for this run only */
  }
  for (const l of recentListeners) l();
}

/** A page finished loading: it moves to the top of the list. */
export function noteVisit(url: string, title: string, favicon?: string) {
  if (!/^https?:\/\//.test(url)) return;
  const prev = getRecent().find((v) => v.url === url);
  saveRecent([{ url, title: title || prev?.title || '', favicon: favicon ?? prev?.favicon, ts: Date.now() }, ...getRecent().filter((v) => v.url !== url)].slice(0, RECENT_MAX));
}

/** Title or icon arrived after the load: update the page's entry if it is still listed. */
export function touchVisit(url: string, patch: Partial<Pick<Visit, 'title' | 'favicon'>>) {
  const list = getRecent();
  const i = list.findIndex((v) => v.url === url);
  if (i < 0 || (Object.keys(patch) as (keyof typeof patch)[]).every((k) => list[i][k] === patch[k])) return;
  saveRecent(list.map((v, j) => (j === i ? { ...v, ...patch } : v)));
}

export function forgetVisit(url: string) {
  saveRecent(getRecent().filter((v) => v.url !== url));
}

export function useRecent(): Visit[] {
  return useSyncExternalStore((l) => {
    recentListeners.add(l);
    return () => {
      recentListeners.delete(l);
    };
  }, getRecent);
}

/* ── local pages mentioned in this session ── */

type Target = { url: string; label: string };
const targetCache = new WeakMap<object, Target[]>();

function itemTargets(item: TimelineItem): Target[] {
  let texts: (string | undefined)[];
  if (item.type === 'text') texts = [item.text];
  else if (item.type === 'tool' && item.kind === 'bash') texts = [item.output, item.result?.text];
  else return [];
  let hit = targetCache.get(item);
  if (!hit) {
    hit = previewTargets(texts, 6);
    targetCache.set(item, hit);
  }
  return hit;
}

/**
 * Local pages this session's answers mention or its commands and the panel terminal printed, one
 * per host and port, newest first. Only call it while the start view shows: it follows streaming.
 */
export function usePreviews(sessionId: string, limit = 4): Target[] {
  const items = useStore((s) => s.data[sessionId]?.items);
  const termV = useTermVersion();
  return useMemo(() => {
    const found: { t: Target; ts: number; order: number }[] = [];
    let order = 0;
    for (const item of Object.values(items ?? {})) for (const t of itemTargets(item)) found.push({ t, ts: item.ts, order: order++ });
    for (const run of getRuns(sessionId)) for (const url of runUrls(run)) found.push({ t: { url, label: new URL(url).host }, ts: run.startedAt, order: order++ });
    found.sort((a, b) => b.ts - a.ts || a.order - b.order);
    const out: Target[] = [];
    const seen = new Set<string>();
    for (const f of found) {
      if (seen.has(f.t.label)) continue;
      seen.add(f.t.label);
      if (out.push(f.t) >= limit) break;
    }
    return out;
    // termV marks terminal output changes (the transcript lives outside React).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sessionId, termV]);
}

/* ── dev servers the panel terminal printed ── */

const runCache = new Map<number, { v: number; urls: string[] }>();

function runUrls(run: TermRun): string[] {
  const c = runCache.get(run.id);
  if (c && c.v === run.v) return c.urls;
  const urls = findDevUrls(run.chunks.map((ch) => ch.t).join(''));
  runCache.set(run.id, { v: run.v, urls });
  return urls;
}
