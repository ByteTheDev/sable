import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { DropdownMenu as RM } from 'radix-ui';
import type { Attachment } from '@shared/protocol';
import { Icon, type IconName } from '@/icons';
import { addressParts, isLocalUrl, normalizeAddress, willSearch } from '@/lib/links';
import * as actions from '@/state/actions';
import { focusComposer } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton, Kbd, Menu, MenuContent, MenuItem, MenuSep, MenuTrigger, Spinner, Tip } from '@/ui';
import { readScript, registerPage } from './browser-agent';
import { parseKey, pickCancelScript, pickScript, type Picked } from './browser-scripts';
import { DEVICES, forgetVisit, getLog, getPage, logFailed, logLine, noteVisit, pushHistory, resetLog, setPage, stepHistory, touchVisit, useLogVersion, usePage, usePreviews, useRecent, type AgentWork, type Device, type FeedEntry } from './browser-store';
import './browser.css';

/**
 * The panel's Browser tab: the page an agent is building, next to the conversation. A real browser
 * view (<webview>) in the desktop app, a sandboxed frame in the web build. A toolbar (history,
 * reload or stop, the address, a menu), a progress line, and states of its own: a start view,
 * a failed load, a crashed page. The page can be checked at tablet and phone width.
 */

interface DesktopApi {
  platform: string;
  debug?: boolean;
  browser?: {
    capture(webContentsId: number, opts?: { forAgent?: boolean }): Promise<string>;
    clearData(): Promise<void>;
    onEvent(cb: (e: { type: string; name?: string; id?: number; url?: string; method?: string; status?: number; error?: string }) => void): () => void;
  };
}

/** The Electron <webview> element: only the parts used here. */
interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getWebContentsId(): number;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number;
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
  setZoomFactor(factor: number): void;
  getZoomFactor(): number;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
  getURL(): string;
  executeJavaScript(code: string): Promise<unknown>;
  sendInputEvent?(event: { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string; modifiers?: string[] }): Promise<void> | void;
}

/** Key names as the shell's input events spell them. */
const INPUT_KEY: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Escape', ' ': 'Space' };

type WebviewEvent = Event & {
  url?: string;
  isMainFrame?: boolean;
  title?: string;
  favicons?: string[];
  errorCode?: number;
  errorDescription?: string;
  validatedURL?: string;
  result?: { activeMatchOrdinal: number; matches: number };
  /** console-message: a number (0 verbose … 3 error) in older shells, a word in newer ones. */
  level?: number | string;
  message?: string;
  line?: number;
  sourceId?: string;
};

/** Chromium's zoom steps. */
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const DEVICE_ICON: Record<Device, IconName> = { desktop: 'monitor', tablet: 'tablet', phone: 'phone' };

/** The device strip above a constrained page, and the margin around it. */
const STRIP_H = 36;
const STAGE_PAD = 14;

/** A failed load in plain words, from Chromium's net error code. */
function failure(code: number | undefined, url: string): string {
  const { host } = addressParts(url);
  const c = code ?? 0;
  if (c === -102 || c === -101 || c === -100 || c === -109) return isLocalUrl(url) ? `Nothing is running at ${host}` : `${host} refused to connect`;
  if (c === -105 || c === -137) return `Could not find ${host}`;
  if (c === -106) return 'You are offline';
  if (c === -7 || c === -118) return `${host} took too long to answer`;
  if ((c <= -200 && c > -300) || c === -501) return `${host} has a certificate that cannot be trusted`;
  if (c === -310) return `${host} redirected too many times`;
  if (c === -324) return `${host} sent an empty response`;
  if (c === -20 || c === -27) return 'This page cannot be shown here';
  return `${host} did not load`;
}

const desktop = (window as { sableDesktop?: DesktopApi }).sableDesktop;
const native = !!desktop?.browser;
const PARTITION = 'persist:sable-browser';

// Verification runs of the desktop app (started with --eval) get the store, since production has no console helpers.
if (desktop?.debug) (window as unknown as Record<string, unknown>).sableDebug = { store: useStore, actions };

/** "localhost:5173/app" for display: no scheme, no lone trailing slash. */
function prettyUrl(url: string) {
  return url.replace(/^https?:\/\//, '').replace(/^([^/?#]+)\/$/, '$1');
}

const isAppOrigin = (url: string) => {
  try {
    return new URL(url).origin === location.origin;
  } catch {
    return false;
  }
};

const dataUrlBytes = (url: string) => Math.round(((url.length - url.indexOf(',') - 1) * 3) / 4);

export function BrowserTab({ sessionId, active }: { sessionId: string; active: boolean }) {
  const page = usePage(sessionId);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<WebviewEl | null>(null);
  const ready = useRef(false);
  const unregister = useRef<(() => void) | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const toast = useStore((s) => s.toast);
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<{ active: number; total: number } | null>(null);

  /* ── desktop: one webview per mount, created on the first page ── */

  const nav = () => {
    const el = view.current;
    if (!el || !ready.current) return {};
    try {
      return { canBack: el.canGoBack(), canForward: el.canGoForward() };
    } catch {
      return {};
    }
  };

  const ensureView = useCallback(
    (url: string) => {
      if (view.current || !host.current) return false;
      const el = document.createElement('webview') as WebviewEl;
      el.setAttribute('partition', PARTITION);
      el.setAttribute('src', url);
      // Lets window.open and target=_blank reach the shell, which loads them in this view (never a new window).
      el.setAttribute('allowpopups', '');
      el.className = 'bw-webview';
      const on = (type: string, fn: (e: WebviewEvent) => void) => el.addEventListener(type, fn as EventListener);
      on('dom-ready', () => {
        ready.current = true;
        let zoom = getPage(sessionId).zoom;
        try {
          // Chromium keeps zoom per site: the page tells us what it is now.
          zoom = el.getZoomFactor();
        } catch {
          /* keep ours */
        }
        setPage(sessionId, { ...nav(), zoom, ...(getPage(sessionId).loading ? { phase: 3 as const } : {}) });
      });
      // Set by a failed main-frame load: the engine then commits its own error page and reports
      // did-finish-load for it, which must not clear the failure.
      let failed = false;
      on('did-start-loading', () => {
        failed = false;
        setPage(sessionId, { loading: true, phase: 1, crashed: undefined });
      });
      on('did-stop-loading', () => setPage(sessionId, { loading: false, ...nav() }));
      // A failed load keeps its view until a load succeeds, so Retry does not flash the engine's own error page.
      on('did-finish-load', () => {
        if (failed) return;
        const p = getPage(sessionId);
        setPage(sessionId, { error: undefined, errorCode: undefined });
        noteVisit(p.url, p.title, p.favicon);
      });
      on('did-navigate', (e) => {
        if (!e.url) return;
        // A new document: the agent's view of its console and failed requests starts empty.
        resetLog(sessionId);
        // A reload of the same address keeps its title and icon: the engine reports them again only when they change.
        const same = getPage(sessionId).url === e.url;
        setPage(sessionId, { url: e.url, ...(same ? {} : { title: '', favicon: undefined }), phase: 2, ...nav() });
        setFound(null);
      });
      // What the page logs, for the drawer and the agent (errors and warnings also go with browser_read); bounded in the store.
      on('console-message', (e) => {
        const lv = e.level;
        const level = lv === 3 || lv === 'error' ? 'error' : lv === 2 || lv === 'warning' ? 'warning' : lv === 0 || lv === 'debug' || lv === 'verbose' ? 'debug' : lv === 'info' ? 'info' : 'log';
        if (!e.message) return;
        logLine(sessionId, { level, text: e.message, source: e.sourceId ? `${e.sourceId.replace(/[?#].*$/, '')}${e.line ? `:${e.line}` : ''}` : undefined });
      });
      on('did-navigate-in-page', (e) => e.isMainFrame && e.url && setPage(sessionId, { url: e.url, ...nav() }));
      on('page-title-updated', (e) => {
        const title = e.title ?? '';
        setPage(sessionId, { title });
        touchVisit(getPage(sessionId).url, { title });
      });
      on('page-favicon-updated', (e) => {
        const favicon = e.favicons?.find((f) => /^(https:|data:image\/)/.test(f));
        setPage(sessionId, { favicon });
        if (favicon) touchVisit(getPage(sessionId).url, { favicon });
      });
      on('did-fail-load', (e) => {
        // -3 is an aborted load (a new navigation replaced it).
        if (!e.isMainFrame || e.errorCode === -3) return;
        failed = true;
        setPage(sessionId, { loading: false, error: e.errorDescription || 'ERR_FAILED', errorCode: e.errorCode, url: e.validatedURL || getPage(sessionId).url, ...nav() });
      });
      on('render-process-gone', () => setPage(sessionId, { crashed: true, loading: false }));
      on('found-in-page', (e) => e.result && setFound({ active: e.result.activeMatchOrdinal, total: e.result.matches }));
      host.current.appendChild(el);
      view.current = el;
      resetLog(sessionId);
      // The agent's browser tools reach the page through this (browser-agent.ts).
      unregister.current?.();
      unregister.current = registerPage({
        sessionId,
        url: () => {
          try {
            return ready.current ? el.getURL() : getPage(sessionId).url;
          } catch {
            return getPage(sessionId).url;
          }
        },
        read: async (selector, max) => {
          if (!ready.current) throw new Error('The page is still starting.');
          const r = (await el.executeJavaScript(readScript(selector, max))) as { title?: unknown; text?: unknown; length?: unknown; missing?: boolean; badSelector?: boolean } | null;
          return {
            title: typeof r?.title === 'string' ? r.title : '',
            text: typeof r?.text === 'string' ? r.text : '',
            length: typeof r?.length === 'number' ? r.length : 0,
            missing: r?.missing === true,
            badSelector: r?.badSelector === true,
          };
        },
        capture: async () => {
          if (!ready.current || !desktop?.browser) throw new Error('The page is still starting.');
          return desktop.browser.capture(el.getWebContentsId(), { forAgent: true });
        },
        run: async (script) => {
          if (!ready.current) throw new Error('The page is still starting.');
          return el.executeJavaScript(script);
        },
        key: async (combo) => {
          if (!ready.current || typeof el.sendInputEvent !== 'function') return false;
          const { key, mods } = parseKey(combo);
          const keyCode = INPUT_KEY[key] ?? key;
          const ch = key === 'Space' ? ' ' : key;
          const typed = ch.length === 1 && !mods.some((m) => m !== 'shift');
          await el.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods });
          if (typed) await el.sendInputEvent({ type: 'char', keyCode: ch, modifiers: mods });
          else if (key === 'Enter' && !mods.length) await el.sendInputEvent({ type: 'char', keyCode: '\u000d' });
          await el.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods });
          return true;
        },
        history: (action) => {
          if (!ready.current) return false;
          try {
            if (action === 'back') {
              if (!el.canGoBack()) return false;
              el.goBack();
            } else if (action === 'forward') {
              if (!el.canGoForward()) return false;
              el.goForward();
            } else el.reload();
            return true;
          } catch {
            return false;
          }
        },
      });
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId],
  );

  useEffect(() => {
    if (!native) return;
    const url = getPage(sessionId).url;
    if (url) {
      setPage(sessionId, { loading: true, phase: 1, canBack: false, canForward: false, crashed: undefined });
      ensureView(url);
    }
    const off = desktop?.browser?.onEvent((e) => {
      if (e.type === 'download-blocked') useStore.getState().toast(`Downloads are off in the panel browser${e.name ? ` (${e.name})` : ''}. Open the page in your browser to download.`);
      // Ctrl+F typed inside this page (the shell forwards it; keys in the page never reach the app).
      if (e.type === 'find' && view.current && ready.current && e.id === view.current.getWebContentsId()) openFind();
      // A request of this page failed (the shell sends the address without its query, and the status or error).
      if (e.type === 'net' && e.url && view.current && ready.current && e.id === view.current.getWebContentsId()) logFailed(sessionId, { url: e.url, method: e.method, status: e.status, error: e.error });
    });
    return () => {
      off?.();
      unregister.current?.();
      unregister.current = null;
      view.current?.remove();
      view.current = null;
      ready.current = false;
      setPage(sessionId, { loading: false });
    };
  }, [sessionId, ensureView]);

  /* ── navigation ── */

  const go = useCallback(
    (raw: string) => {
      const url = normalizeAddress(raw);
      if (!url) {
        toast('Only web addresses open here');
        return false;
      }
      if (native) {
        if (isAppOrigin(url)) {
          toast('Sable itself does not open in the panel browser');
          return false;
        }
        setPage(sessionId, { url, title: '', favicon: undefined, error: undefined, errorCode: undefined, crashed: undefined, loading: true, phase: 1 });
        if (!ensureView(url)) load(url);
      } else {
        pushHistory(sessionId, url);
      }
      // A page asked for from elsewhere replaces whatever was half-typed in the address field.
      input.current?.blur();
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, ensureView, toast],
  );

  /** Loads an address in the existing view. */
  function load(url: string) {
    const el = view.current;
    if (!el) return;
    if (ready.current) el.loadURL(url).catch(() => {});
    else el.setAttribute('src', url);
  }

  /** Runs a call on the page's view, if it is there and alive. */
  const withView = (fn: (el: WebviewEl) => void) => {
    const el = view.current;
    if (!el || !ready.current) return;
    try {
      fn(el);
    } catch {
      /* the page went away between the check and the call */
    }
  };

  const back = () => (native ? withView((el) => el.goBack()) : stepHistory(sessionId, -1));
  const forward = () => (native ? withView((el) => el.goForward()) : stepHistory(sessionId, 1));
  const reload = (hard = false) => {
    if (!native) {
      setPage(sessionId, { nonce: page.nonce + 1, loading: true, phase: 1 });
      return;
    }
    // After a crash or a failed load, load the address again rather than reloading the engine's error page.
    if (page.crashed || page.error) {
      setPage(sessionId, { crashed: undefined, loading: true, phase: 1 });
      load(page.url);
    } else withView((el) => (hard ? el.reloadIgnoringCache() : el.reload()));
  };
  const stop = () => withView((el) => el.stop());

  const zoomTo = (zoom: number) =>
    withView((el) => {
      el.setZoomFactor(zoom);
      setPage(sessionId, { zoom });
    });
  const zoomStep = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOMS.find((z) => z > page.zoom + 0.001) : [...ZOOMS].reverse().find((z) => z < page.zoom - 0.001);
    if (next) zoomTo(next);
  };
  const devTools = () => withView((el) => (el.isDevToolsOpened() ? el.closeDevTools() : el.openDevTools()));
  const setDevice = (device: Device) => setPage(sessionId, { device });

  /* ── find in page ── */

  const [findKey, setFindKey] = useState(0);
  const openFind = () => {
    setFinding(true);
    setFindKey((k) => k + 1);
  };
  const find = (text: string, dir?: 1 | -1) =>
    withView((el) => {
      if (!text) {
        el.stopFindInPage('clearSelection');
        setFound(null);
      } else el.findInPage(text, dir ? { forward: dir > 0, findNext: false } : { findNext: true });
    });
  const closeFind = () => {
    setFinding(false);
    setFound(null);
    withView((el) => el.stopFindInPage('clearSelection'));
  };

  /* ── device sizes: the page centred at a fixed width, scaled down to fit ── */

  const viewBox = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = viewBox.current;
    if (page.device === 'desktop' || !el) return;
    setBox({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [page.device]);

  const dev = DEVICES[page.device];
  let stage: CSSProperties | undefined;
  let stageInfo: { w: number; h: number; pct: number } | null = null;
  if (page.device !== 'desktop' && box.w > 0) {
    const s = Math.min(1, (box.w - STAGE_PAD * 2) / dev.w);
    const h = Math.max(200, Math.round(Math.min(dev.h, (box.h - STRIP_H - STAGE_PAD) / s)));
    stage = { width: dev.w, height: h, top: STRIP_H, transform: `translateX(-50%) scale(${s})` };
    stageInfo = { w: dev.w, h, pct: Math.round(s * 100) };
  }

  // Another part of the app asked for a page (a local link in the conversation, /browser, the palette).
  const wanted = useStore((s) => s.ui.browserUrl);
  useEffect(() => {
    if (!wanted || useStore.getState().ui.browserUrl !== wanted) return;
    useStore.getState().setUi({ browserUrl: undefined });
    go(wanted);
  }, [wanted, go]);

  useEffect(() => {
    if (!active || getPage(sessionId).url) return;
    const raf = requestAnimationFrame(() => {
      // A page may have been asked for in the meantime: then the address field stays at rest.
      if (!getPage(sessionId).url) input.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [active, sessionId]);

  /* ── page actions ── */

  const copyLink = () =>
    navigator.clipboard.writeText(page.url).then(
      () => toast('Link copied', 'success'),
      () => toast('Could not reach the clipboard', 'error'),
    );

  const openOutside = () => window.open(page.url, '_blank', 'noopener,noreferrer');

  const acceptsImages = () => useStore.getState().data[sessionId]?.caps?.features.images !== false;
  const siteName = () => {
    try {
      return new URL(getPage(sessionId).url).host || 'page';
    } catch {
      return 'page';
    }
  };

  /** A picture into the message being written; false when it has no room for one. */
  const attach = (dataUrl: string, name: string) => {
    const cur = useStore.getState().drafts[sessionId]?.attachments ?? [];
    if (cur.filter((a) => a.kind === 'image').length >= 10) {
      toast('Up to 10 images per message');
      return false;
    }
    const att: Attachment = { id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, kind: 'image', name, mime: 'image/png', dataUrl, size: dataUrlBytes(dataUrl) };
    useStore.getState().setDraft(sessionId, { attachments: [...cur, att] });
    return true;
  };

  const attachShot = async () => {
    const el = view.current;
    if (!el || !desktop?.browser || !ready.current) return;
    if (!acceptsImages()) {
      toast('This agent does not accept images');
      return;
    }
    try {
      const dataUrl = await desktop.browser.capture(el.getWebContentsId());
      if (!attach(dataUrl, `Screenshot of ${siteName()}.png`)) return;
      toast('Screenshot attached to your message', 'success');
      focusComposer();
    } catch {
      toast('Could not capture the page', 'error');
    }
  };

  /* ── pick an element: hover outlines it in the page, a click puts a reference to it in the message ── */

  const [picking, setPicking] = useState(false);
  const pick = async () => {
    const el = view.current;
    if (!el || !ready.current || !desktop?.browser || page.error || page.crashed) return;
    if (picking) {
      void el.executeJavaScript(pickCancelScript).catch(() => {});
      return;
    }
    setRegion(false);
    setPicking(true);
    try {
      // Keys go to the page while picking, so Escape ends it there.
      el.focus();
      const r = (await el.executeJavaScript(pickScript)) as Picked | null;
      if (!r || typeof r.selector !== 'string' || !r.rect) return;
      if (acceptsImages() && r.rect.w >= 1 && r.rect.h >= 1) {
        try {
          const full = await desktop.browser.capture(el.getWebContentsId());
          const shot = await cropImage(full, r.rect, r.vw, 8);
          attach(shot, `${r.tag} on ${siteName()}.png`);
        } catch {
          /* the reference still goes in, without its picture */
        }
      }
      focusComposer(`${pickedText(r, getPage(sessionId).url)} `, { append: true });
    } catch {
      toast('Could not pick an element on this page', 'error');
    } finally {
      setPicking(false);
    }
  };

  /* ── a region of the page as a picture ── */

  const [region, setRegion] = useState(false);
  const startRegion = () => {
    if (!view.current || !ready.current || !desktop?.browser) return;
    if (!acceptsImages()) {
      toast('This agent does not accept images');
      return;
    }
    if (picking) void view.current.executeJavaScript(pickCancelScript).catch(() => {});
    setRegion(true);
  };
  const takeRegion = async (r: { x: number; y: number; w: number; h: number } | null) => {
    setRegion(false);
    const el = view.current;
    if (!r || !el || !desktop?.browser || !ready.current) return;
    try {
      // The view as laid out (a device size scales it): the picture maps onto this box.
      const box = el.getBoundingClientRect();
      const frame = viewBox.current?.getBoundingClientRect();
      if (!frame || box.width < 1) return;
      const full = await desktop.browser.capture(el.getWebContentsId());
      const shot = await cropImage(full, { x: r.x + frame.left - box.left, y: r.y + frame.top - box.top, w: r.w, h: r.h }, box.width, 0);
      if (!attach(shot, `Part of ${siteName()}.png`)) return;
      toast('Picture attached to your message', 'success');
      focusComposer();
    } catch {
      toast('Could not capture that part of the page', 'error');
    }
  };

  /* ── the page's console and failed requests, under the page ── */

  const [drawer, setDrawer] = useState(false);

  const clearData = async () => {
    try {
      await desktop?.browser?.clearData();
      toast('Cleared cookies, storage and cache for the panel browser', 'success');
      if (page.url) reload();
    } catch {
      toast('Could not clear browsing data', 'error');
    }
  };

  const canBack = native ? page.canBack : page.index > 0;
  const canForward = native ? page.canForward : page.index < page.history.length - 1;
  const showNote = !native && !!page.url && !isLocalUrl(page.url);
  const frameUrl = native ? '' : page.history[page.index] ?? '';
  const busy = page.loading && !page.error;

  const onKey = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.shiftKey) {
      // The tools, on the keys developer tools use for the same things.
      if (!native || !page.url || (k !== 'c' && k !== 's' && k !== 'j')) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === 'c') void pick();
      else if (k === 's') startRegion();
      else setDrawer((d) => !d);
      return;
    }
    if (k === 'l') {
      e.preventDefault();
      e.stopPropagation();
      input.current?.focus();
      input.current?.select();
    } else if (k === 'f' && native && page.url) {
      e.preventDefault();
      e.stopPropagation();
      openFind();
    }
  };

  return (
    <div className="rail-col bw" onKeyDown={onKey}>
      <div className="bw-bar">
        <IconButton icon="arrow-left" label="Back" size={15} disabled={!canBack} onClick={back} />
        <IconButton icon="arrow-right" label="Forward" size={15} disabled={!canForward} onClick={forward} />
        <Tip label={native && page.loading ? 'Stop' : 'Reload'}>
          <button
            type="button"
            className="icon-btn bw-reload"
            aria-label={native && page.loading ? 'Stop' : 'Reload'}
            data-loading={(native && page.loading) || undefined}
            disabled={!page.url}
            onClick={() => (native && page.loading ? stop() : reload())}
          >
            <Icon name="reload" size={15} className="bw-reload-a" />
            <Icon name="x" size={14} className="bw-reload-b" />
          </button>
        </Tip>
        <AddressField url={page.url} title={page.title} favicon={page.favicon} zoom={page.zoom} agent={page.agent} picking={picking} onResetZoom={() => zoomTo(1)} inputRef={input} onGo={go} />
        {native && (
          <>
            <IconButton icon="cursor-click" label={picking ? 'Stop picking' : 'Pick an element'} keys="mod+shift+c" size={15} active={picking} disabled={!page.url || !!page.error || !!page.crashed} onClick={() => void pick()} />
            <LogToggle sessionId={sessionId} open={drawer} disabled={!page.url} onToggle={() => setDrawer((d) => !d)} />
          </>
        )}
        <Menu>
          <Tip label="More">
            <MenuTrigger className="icon-btn" aria-label="More" disabled={!page.url}>
              <Icon name="dots" size={15} />
            </MenuTrigger>
          </Tip>
          <MenuContent align="end" width={292}>
            <MenuItem icon="external" onSelect={openOutside}>
              Open in your browser
            </MenuItem>
            <MenuItem icon="link" onSelect={() => void copyLink()}>
              Copy link
            </MenuItem>
            <MenuSep />
            <MenuItem icon="at" onSelect={() => focusComposer(`${page.url} `, { append: true })}>
              Mention this page in chat
            </MenuItem>
            {native && (
              <>
                <MenuItem icon="image" onSelect={() => void attachShot()}>
                  Add screenshot to message
                </MenuItem>
                <MenuItem icon="expand" hint={<Kbd combo="mod+shift+s" />} onSelect={startRegion}>
                  Add region to message
                </MenuItem>
                <MenuSep />
                <MenuItem icon="file-search" hint={<Kbd combo="mod+f" />} onSelect={openFind}>
                  Find in page
                </MenuItem>
                <MenuItem icon="zoom-in" disabled={page.zoom >= ZOOMS[ZOOMS.length - 1]} onSelect={() => zoomStep(1)}>
                  Zoom in
                </MenuItem>
                <MenuItem icon="zoom-out" disabled={page.zoom <= ZOOMS[0]} onSelect={() => zoomStep(-1)}>
                  Zoom out
                </MenuItem>
                <MenuItem icon="search" hint={<span className="num">{Math.round(page.zoom * 100)}%</span>} disabled={page.zoom === 1} onSelect={() => zoomTo(1)}>
                  Actual size
                </MenuItem>
              </>
            )}
            <MenuSep />
            <DeviceMenu device={page.device} onPick={setDevice} />
            <MenuSep />
            <MenuItem icon="refresh" onSelect={() => reload(true)}>
              Hard reload
            </MenuItem>
            {native && (
              <MenuItem icon="code" onSelect={devTools}>
                Developer tools
              </MenuItem>
            )}
            {native && (
              <MenuItem icon="broom" onSelect={() => void clearData()}>
                Clear browsing data
              </MenuItem>
            )}
          </MenuContent>
        </Menu>
        <LoadLine loading={busy} phase={page.phase} />
      </div>

      <AnimatePresence initial={false}>
        {finding && native && page.url && <FindBar key="find" focusKey={findKey} found={found} onFind={find} onClose={closeFind} />}
      </AnimatePresence>

      {showNote && (
        <div className="bw-note">
          <Icon name="info" size={14} />
          <span className="bw-note-text">Some sites refuse to be embedded. Local pages work here; use the desktop app for the full web.</span>
          <button type="button" className="btn btn-sm" onClick={openOutside}>
            Open in your browser
          </button>
        </div>
      )}

      <div className="bw-view" ref={viewBox} data-device={stage ? page.device : undefined} data-empty={!page.url || undefined}>
        {stageInfo && (
          <div className="bw-device">
            <Icon name={DEVICE_ICON[page.device]} size={14} />
            <span className="bw-device-name">{dev.label}</span>
            <span className="num">
              {stageInfo.w} × {stageInfo.h}
            </span>
            {stageInfo.pct < 100 && <span className="num">{stageInfo.pct}%</span>}
            <IconButton icon="x" label="Back to full width" size={13} className="bw-device-close" onClick={() => setDevice('desktop')} />
          </div>
        )}
        <div className="bw-host" ref={host} style={stage}>
          {!native && frameUrl && (
            <iframe
              key={`${page.index}:${page.nonce}:${frameUrl}`}
              className="bw-frame"
              src={frameUrl}
              title={prettyUrl(frameUrl)}
              // The app's own origin runs without allow-same-origin, so a page there cannot reach the app.
              sandbox={isAppOrigin(frameUrl) ? 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox' : 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox'}
              referrerPolicy="no-referrer"
              onLoad={(e) => {
                e.currentTarget.dataset.loaded = '';
                setPage(sessionId, { loading: false });
                // A frame reports a load even when the site refused to be embedded: only local pages count as visited.
                if (isLocalUrl(frameUrl)) noteVisit(frameUrl, '');
              }}
            />
          )}
        </div>
        {native && page.url && page.crashed ? (
          <PageState title="This page stopped working" detail={addressParts(page.url).host}>
            <button type="button" className="btn btn-sm" onClick={() => reload()}>
              <Icon name="reload" size={14} />
              Reload
            </button>
          </PageState>
        ) : native && page.url && page.error ? (
          <PageState title={failure(page.errorCode, page.url)} detail={page.error}>
            <button type="button" className="btn btn-sm" disabled={page.loading} onClick={() => reload()}>
              {page.loading ? <Spinner size={12} /> : <Icon name="reload" size={14} />}
              Retry
            </button>
            {!isLocalUrl(page.url) && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={openOutside}>
                Open in your browser
              </button>
            )}
          </PageState>
        ) : null}
        {!page.url && <StartView sessionId={sessionId} onGo={go} />}
        {region && native && page.url && <RegionPick onDone={(r) => void takeRegion(r)} />}
      </div>

      <AnimatePresence initial={false}>{drawer && native && page.url && <LogDrawer key="log" sessionId={sessionId} url={page.url} onClose={() => setDrawer(false)} />}</AnimatePresence>
    </div>
  );
}

/** A part of a picture of the page: `r` in the page's own pixels, `viewW` the page's width in them. */
async function cropImage(src: string, r: { x: number; y: number; w: number; h: number }, viewW: number, pad: number): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('no picture'));
    i.src = src;
  });
  const k = img.naturalWidth / Math.max(1, viewW);
  const x0 = Math.max(0, Math.floor((r.x - pad) * k));
  const y0 = Math.max(0, Math.floor((r.y - pad) * k));
  const x1 = Math.min(img.naturalWidth, Math.ceil((r.x + r.w + pad) * k));
  const y1 = Math.min(img.naturalHeight, Math.ceil((r.y + r.h + pad) * k));
  if (x1 - x0 < 2 || y1 - y0 < 2) throw new Error('nothing to crop');
  const canvas = document.createElement('canvas');
  canvas.width = x1 - x0;
  canvas.height = y1 - y0;
  canvas.getContext('2d')!.drawImage(img, x0, y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/** The picked element in one line for the message: what it is, where, its selector, its text when that says more. */
function pickedText(r: Picked, url: string): string {
  const where = prettyUrl(url.split(/[?#]/)[0]);
  const what = String(r.what || r.tag).slice(0, 120);
  const text = String(r.text || '').replace(/\s+/g, ' ').trim();
  const said = text && !what.includes(text.slice(0, 60)) ? `, text "${text.length > 140 ? `${text.slice(0, 139)}…` : text}"` : '';
  return `The ${what} on ${where} (\`${String(r.selector).slice(0, 200).replace(/`/g, '')}\`${said})`;
}

/** Drag a rectangle over the page; Escape or a plain click gives it up. */
function RegionPick({ onDone }: { onDone: (r: { x: number; y: number; w: number; h: number } | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const at = (e: React.PointerEvent) => {
    const b = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(b.width, e.clientX - b.left)), y: Math.max(0, Math.min(b.height, e.clientY - b.top)) };
  };
  return (
    <div
      ref={ref}
      className="bw-region"
      tabIndex={-1}
      role="application"
      aria-label="Drag over the part of the page to attach. Escape cancels."
      data-escape-scope=""
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onDone(null);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = at(e);
        setBox({ ...start.current, w: 0, h: 0 });
      }}
      onPointerMove={(e) => {
        const a = start.current;
        if (!a) return;
        const b = at(e);
        setBox({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
      }}
      onPointerUp={() => {
        const b = box;
        start.current = null;
        onDone(b && b.w >= 6 && b.h >= 6 ? b : null);
      }}
      onPointerCancel={() => onDone(null)}
    >
      {box ? (
        <div className="bw-region-box" style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h }}>
          {box.w > 56 && box.h > 26 && (
            <span className="bw-region-size num">
              {Math.round(box.w)} × {Math.round(box.h)}
            </span>
          )}
        </div>
      ) : (
        <span className="bw-region-hint">Drag over the part to attach</span>
      )}
    </div>
  );
}

/** The drawer's switch in the toolbar; a count shows only while the page has errors. */
function LogToggle({ sessionId, open, disabled, onToggle }: { sessionId: string; open: boolean; disabled: boolean; onToggle: () => void }) {
  useLogVersion(sessionId);
  const errors = disabled ? 0 : getLog(sessionId).feed.reduce((n, f) => n + (f.level === 'error' ? 1 : 0), 0);
  const label = open ? 'Hide console' : 'Show console';
  return (
    <Tip label={errors ? `${label} (${errors} error${errors === 1 ? '' : 's'})` : label} keys="mod+shift+j">
      <button type="button" className="icon-btn bw-log-toggle" aria-label={label} aria-pressed={open} data-active={open || undefined} disabled={disabled} onClick={onToggle}>
        <Icon name="terminal" size={15} />
        {errors > 0 && (
          <span className="bw-log-count num" aria-hidden>
            {errors > 99 ? '99+' : errors}
          </span>
        )}
      </button>
    </Tip>
  );
}

/** "app.js:12" from a script's address; the document itself is the page. */
const fileOf = (source?: string) => {
  if (!source) return '';
  const name = source.replace(/^.*\//, '');
  return (name.startsWith(':') || !name ? `page${name}` : name).slice(-48);
};
const feedLine = (f: FeedEntry) => `${f.request ? 'request' : f.level}: ${f.text.length > 300 ? `${f.text.slice(0, 299)}…` : f.text}${f.source ? ` (${fileOf(f.source)})` : ''}`;

/** The page's console lines and failed requests since it loaded, newest last; any line, or all of them, goes to the message. */
function LogDrawer({ sessionId, url, onClose }: { sessionId: string; url: string; onClose: () => void }) {
  const v = useLogVersion(sessionId);
  const log = getLog(sessionId);
  const feed = log.feed;
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [v]);

  const errors = feed.filter((f) => f.level === 'error').length;
  const warnings = feed.filter((f) => f.level === 'warning').length;
  const where = prettyUrl(url.split(/[?#]/)[0]);
  const send = (lines: FeedEntry[]) => {
    if (!lines.length) return;
    const text = lines.length === 1 ? `From the console of ${where}:\n\`${feedLine(lines[0]).replace(/`/g, "'")}\`` : `From the console of ${where}:\n${lines.map((f) => `- ${feedLine(f)}`).join('\n')}`;
    focusComposer(`${text}\n`, { append: true });
  };
  // All of it means the problems when there are some: that is what a message about a page needs.
  const sendAll = () => {
    const problems = feed.filter((f) => f.level === 'error' || f.level === 'warning');
    send((problems.length ? problems : feed).slice(-30));
  };

  return (
    <motion.div className="bw-log" initial={{ height: 0, opacity: 0 }} animate={{ height: 208, opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 520, damping: 40 }}>
      <div className="bw-log-bar">
        <span className="bw-log-title">Console</span>
        <span className="bw-log-sum num">{errors || warnings ? [errors ? `${errors} error${errors === 1 ? '' : 's'}` : '', warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ') : feed.length ? `${feed.length} line${feed.length === 1 ? '' : 's'}` : ''}</span>
        <button type="button" className="btn btn-sm btn-ghost bw-log-send" disabled={!feed.length} onClick={sendAll}>
          <Icon name="chat" size={14} />
          Send to chat
        </button>
        <IconButton icon="broom" label="Clear" size={14} disabled={!feed.length} onClick={() => resetLog(sessionId)} />
        <IconButton icon="x" label="Hide console" size={13} onClick={onClose} />
      </div>
      <div
        className="bw-log-list scroll"
        ref={list}
        role="log"
        aria-label="Console"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {feed.length === 0 ? (
          <p className="bw-log-empty">Nothing logged since the page loaded.</p>
        ) : (
          <>
            {log.moreFeed > 0 && <p className="bw-log-more">{log.moreFeed} earlier lines left out</p>}
            {feed.map((f) => (
              <div key={f.n} className="bw-log-row" data-level={f.level}>
                <span className="bw-log-mark" aria-hidden>
                  {f.level === 'error' ? <Icon name="x-circle" size={13} /> : f.level === 'warning' ? <Icon name="warning" size={13} /> : null}
                </span>
                <span className="bw-log-text">{f.text}</span>
                {f.source && <span className="bw-log-src">{fileOf(f.source)}</span>}
                <IconButton icon="chat" label="Send to chat" size={13} className="bw-log-act" onClick={() => send([f])} />
              </div>
            ))}
          </>
        )}
      </div>
    </motion.div>
  );
}

/**
 * The progress line under the toolbar. It jumps to a stage as the load comes along (started,
 * committed, document ready) and creeps within it, then completes and fades. Transform and
 * opacity only; a new load starts from zero without animating back.
 */
function LoadLine({ loading, phase }: { loading: boolean; phase: 1 | 2 | 3 }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (loading) {
      if (el.dataset.state !== 'on') {
        el.dataset.state = 'reset';
        void el.offsetWidth;
      }
      el.dataset.state = 'on';
      el.dataset.phase = String(phase);
    } else if (el.dataset.state === 'on') el.dataset.state = 'done';
  }, [loading, phase]);
  return <span ref={ref} className="bw-load" aria-hidden />;
}

/** A state in place of the page: what happened in one line, the engine's own words dim, then what to do. */
function PageState({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return (
    <div className="bw-state" role="alert">
      <p className="bw-state-title">{title}</p>
      {detail && <p className="bw-state-detail">{detail}</p>}
      <div className="bw-state-acts">{children}</div>
    </div>
  );
}

/** Desktop, tablet or phone width, as a submenu of the page menu. */
function DeviceMenu({ device, onPick }: { device: Device; onPick: (d: Device) => void }) {
  return (
    <RM.Sub>
      <RM.SubTrigger className="menu-item">
        <Icon name={DEVICE_ICON[device]} size={16} />
        <span className="grow truncate">Device size</span>
        <span className="hint">{DEVICES[device].label}</span>
        <Icon name="caret-right" size={11} />
      </RM.SubTrigger>
      <RM.Portal>
        <RM.SubContent className="pop" data-spot="" sideOffset={6} alignOffset={-4} collisionPadding={10} style={{ minWidth: 168, width: 168 }}>
          {(Object.keys(DEVICES) as Device[]).map((d) => (
            <MenuItem key={d} icon={DEVICE_ICON[d]} checked={d === device} onSelect={() => onPick(d)}>
              {DEVICES[d].label}
            </MenuItem>
          ))}
        </RM.SubContent>
      </RM.Portal>
    </RM.Sub>
  );
}

/** Find in page: a slim bar under the toolbar. Enter for the next match, Shift+Enter for the previous one. */
function FindBar({
  focusKey,
  found,
  onFind,
  onClose,
}: {
  focusKey: number;
  found: { active: number; total: number } | null;
  onFind: (text: string, dir?: 1 | -1) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const take = () => {
      ref.current?.focus();
      ref.current?.select();
    };
    take();
    // Opened from the page menu: the menu keeps focus while it closes, then hands it back to its trigger.
    const again = () => {
      const a = document.activeElement;
      if (!a || a === document.body || a.closest('.bw-bar, [role="menu"]')) take();
    };
    const t = [setTimeout(again, 160), setTimeout(again, 320)];
    return () => t.forEach(clearTimeout);
  }, [focusKey]);

  return (
    <motion.div
      className="bw-find"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 520, damping: 40 }}
    >
      <div className="bw-find-row">
        <label className="bw-find-field">
          <Icon name="search" size={14} />
          <input
            ref={ref}
            value={text}
            placeholder="Find in page"
            aria-label="Find in page"
            spellCheck={false}
            data-escape-scope=""
            onChange={(e) => {
              setText(e.target.value);
              onFind(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (text) onFind(text, e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
            }}
          />
          {text && (
            <span className="bw-find-count num" aria-live="polite">
              {found ? (found.total ? `${found.active} of ${found.total}` : 'No matches') : ''}
            </span>
          )}
        </label>
        <IconButton icon="caret-up" label="Previous match" size={13} disabled={!found?.total} onClick={() => onFind(text, -1)} />
        <IconButton icon="caret-down" label="Next match" size={13} disabled={!found?.total} onClick={() => onFind(text, 1)} />
        <IconButton icon="x" label="Close" size={13} onClick={onClose} />
      </div>
    </motion.div>
  );
}

/** A site's icon, or a plain line icon when it has none or it fails to load. */
function SiteIcon({ src, fallback, size = 14 }: { src?: string; fallback: IconName; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? (
    <img className="bw-favicon" src={src} alt="" width={size} height={size} draggable={false} onError={() => setFailed(true)} />
  ) : (
    <Icon name={fallback} size={size} className="bw-site-icon" />
  );
}

/** What stands for a page that has no icon of its own: a search, this machine, a plain connection, the web. */
function siteFallback(url: string): IconName {
  if (!url) return 'search';
  if (addressParts(url).search) return 'search';
  if (isLocalUrl(url)) return 'laptop';
  return url.startsWith('http:') ? 'unlock' : 'globe';
}

/** While the agent works on the page: one quiet word in the address field, for that moment only. */
const AGENT_WORD: Record<AgentWork, string> = {
  read: 'Reading',
  screenshot: 'Capturing',
  open: 'Opening',
  snapshot: 'Reading',
  click: 'Clicking',
  type: 'Typing',
  press: 'Pressing',
  scroll: 'Scrolling',
  eval: 'Running',
  logs: 'Reading',
  wait: 'Waiting',
  navigate: 'Loading',
};
const AGENT_SAYS: Record<AgentWork, string> = {
  read: 'The agent is reading this page',
  screenshot: 'The agent is taking a screenshot of this page',
  open: 'The agent is opening this page',
  snapshot: 'The agent is reading the outline of this page',
  click: 'The agent is clicking on this page',
  type: 'The agent is typing on this page',
  press: 'The agent is pressing a key on this page',
  scroll: 'The agent is scrolling this page',
  eval: 'The agent is running a script on this page',
  logs: "The agent is reading this page's log",
  wait: 'The agent is waiting for this page',
  navigate: 'The agent is moving through this page\'s history',
};

/**
 * At rest: the site's icon, the host, the rest of the path dim (or the title on a site's front
 * page, or the words of a search). On focus: the whole address, selected. Enter opens it or
 * searches the web; Escape puts the page's address back.
 */
function AddressField({
  url,
  title,
  favicon,
  zoom,
  agent,
  picking,
  onResetZoom,
  inputRef,
  onGo,
}: {
  url: string;
  title: string;
  favicon?: string;
  zoom: number;
  agent?: AgentWork;
  /** Pick mode is on: the field says so until an element is picked or Escape ends it. */
  picking?: boolean;
  onResetZoom: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onGo: (raw: string) => boolean;
}) {
  const [value, setValue] = useState(url);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setValue(url);
    // Focus can leave without a blur event (the pane turning inert moves it to the body): trust the document.
    else if (document.activeElement !== inputRef.current) setFocused(false);
  }, [url, focused, inputRef]);

  const parts = url ? addressParts(url) : null;
  const typed = focused && value.trim() !== '' && value !== url;
  const showTitle = !!parts && !parts.search && !parts.path && !!title && title !== parts.host && title !== url;

  return (
    <form
      className="bw-addr"
      data-focused={focused || undefined}
      data-zoomed={(!focused && zoom !== 1) || undefined}
      data-agent={(!focused && (!!agent || !!picking)) || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        if (onGo(value)) inputRef.current?.blur();
      }}
    >
      <span className="bw-addr-lead" aria-hidden>
        {focused ? <Icon name={typed && willSearch(value) ? 'search' : 'globe'} size={14} className="bw-site-icon" /> : <SiteIcon src={favicon} fallback={siteFallback(url)} />}
      </span>
      <input
        ref={inputRef}
        value={focused ? value : ''}
        placeholder={url ? '' : 'Search or enter address'}
        aria-label="Address"
        aria-description={!focused && url ? url : undefined}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        onChange={(e) => setValue(e.target.value)}
        onMouseDown={(e) => {
          // The first click selects the whole address; a pointer-up must not collapse the selection.
          if (focused) return;
          e.preventDefault();
          e.currentTarget.focus();
        }}
        onFocus={(e) => {
          setFocused(true);
          setValue(url);
          const el = e.currentTarget;
          // select() focuses the field again: only while it still has focus.
          requestAnimationFrame(() => document.activeElement === el && el.select());
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setValue(url);
            e.currentTarget.blur();
          }
        }}
      />
      {!focused && parts && (
        <span className="bw-addr-view" aria-hidden>
          {parts.search ? (
            <>
              <span className="bw-addr-host">{parts.search}</span>
              <span className="bw-addr-title">{parts.host}</span>
            </>
          ) : (
            <>
              <span className="bw-addr-host">{parts.host}</span>
              {parts.path ? <span className="bw-addr-path">{parts.path}</span> : showTitle && <span className="bw-addr-title">{title}</span>}
            </>
          )}
        </span>
      )}
      {!focused && agent ? (
        <span className="bw-agent shimmer" role="status" aria-label={AGENT_SAYS[agent]}>
          {AGENT_WORD[agent]}
        </span>
      ) : (
        !focused &&
        picking && (
          <span className="bw-agent" role="status" aria-label="Click an element on the page to put it in your message. Escape cancels.">
            Picking
          </span>
        )
      )}
      {!focused && zoom !== 1 && (
        <Tip label="Reset zoom">
          <button type="button" className="bw-zoom num" onClick={onResetZoom}>
            {Math.round(zoom * 100)}%
          </button>
        </Tip>
      )}
    </form>
  );
}

/** Before the first page: local pages this session mentioned, then recently visited pages. */
function StartView({ sessionId, onGo }: { sessionId: string; onGo: (raw: string) => boolean }) {
  const previews = usePreviews(sessionId);
  const recent = useRecent();
  const shownHosts = new Set(previews.map((p) => p.label));
  // A local page listed above is not repeated under Recent.
  const visits = recent.filter((v) => !(isLocalUrl(v.url) && shownHosts.has(addressParts(v.url).host)));

  if (!previews.length && !visits.length) {
    return (
      <div className="bw-start">
        <p className="rail-empty">Enter an address to see the page next to the conversation.</p>
      </div>
    );
  }

  return (
    <div className="bw-start scroll">
      {previews.length > 0 && (
        <section className="bw-sec" aria-label="In this session">
          <h3 className="rail-h bw-h">In this session</h3>
          <ul className="bw-list">
            {previews.map((p) => {
              const { host, path } = addressParts(p.url);
              return (
                <li key={p.url}>
                  <button type="button" className="bw-row" onClick={() => onGo(p.url)}>
                    <span className="bw-row-lead">
                      <Icon name="laptop" size={15} />
                    </span>
                    <span className="bw-row-title">{host}</span>
                    {path && <span className="bw-row-sub bw-row-path">{path}</span>}
                    <Icon name="arrow-right" size={13} className="bw-row-go" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {visits.length > 0 && (
        <section className="bw-sec" aria-label="Recent">
          <h3 className="rail-h bw-h">Recent</h3>
          <ul className="bw-list">
            {visits.map((v) => {
              const { host, search } = addressParts(v.url);
              const name = search ?? (v.title || host);
              return (
                <li key={v.url} className="rail-row-host">
                  <button type="button" className="bw-row" onClick={() => onGo(v.url)}>
                    <span className="bw-row-lead">
                      <SiteIcon src={v.favicon} fallback={siteFallback(v.url)} size={15} />
                    </span>
                    <span className="bw-row-title">{name}</span>
                    {name !== host && <span className="bw-row-sub rail-row-deco">{host}</span>}
                  </button>
                  <span className="rail-row-acts">
                    <IconButton icon="x" label="Remove from recent" size={12} onClick={() => forgetVisit(v.url)} />
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
