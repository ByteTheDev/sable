import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { DropdownMenu as RM } from 'radix-ui';
import type { Attachment } from '@shared/protocol';
import { Icon, type IconName } from '@/icons';
import { addressParts, isLocalUrl, normalizeAddress, willSearch } from '@/lib/links';
import * as actions from '@/state/actions';
import { focusComposer } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton, Menu, MenuContent, MenuItem, MenuSep, MenuTrigger, Spinner, Tip } from '@/ui';
import { DEVICES, forgetVisit, getPage, noteVisit, pushHistory, setPage, stepHistory, touchVisit, usePage, usePreviews, useRecent, type Device } from './browser-store';
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
    capture(webContentsId: number): Promise<string>;
    clearData(): Promise<void>;
    onEvent(cb: (e: { type: string; name?: string; id?: number }) => void): () => void;
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
}

type WebviewEvent = Event & {
  url?: string;
  isMainFrame?: boolean;
  title?: string;
  favicons?: string[];
  errorCode?: number;
  errorDescription?: string;
  validatedURL?: string;
  result?: { activeMatchOrdinal: number; matches: number };
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
        setPage(sessionId, { url: e.url, title: '', favicon: undefined, phase: 2, ...nav() });
        setFound(null);
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
    });
    return () => {
      off?.();
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

  const attachShot = async () => {
    const el = view.current;
    if (!el || !desktop?.browser || !ready.current) return;
    const st = useStore.getState();
    if (st.data[sessionId]?.caps?.features.images === false) {
      toast('This agent does not accept images');
      return;
    }
    try {
      const dataUrl = await desktop.browser.capture(el.getWebContentsId());
      const cur = useStore.getState().drafts[sessionId]?.attachments ?? [];
      if (cur.filter((a) => a.kind === 'image').length >= 10) {
        toast('Up to 10 images per message');
        return;
      }
      let name = 'Page';
      try {
        name = new URL(page.url).host || name;
      } catch {
        /* keep the fallback */
      }
      const att: Attachment = { id: `att-${Date.now().toString(36)}-shot`, kind: 'image', name: `Screenshot of ${name}.png`, mime: 'image/png', dataUrl, size: dataUrlBytes(dataUrl) };
      useStore.getState().setDraft(sessionId, { attachments: [...cur, att] });
      toast('Screenshot attached to your message', 'success');
      focusComposer();
    } catch {
      toast('Could not capture the page', 'error');
    }
  };

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
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    const k = e.key.toLowerCase();
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
        <AddressField url={page.url} title={page.title} favicon={page.favicon} zoom={page.zoom} onResetZoom={() => zoomTo(1)} inputRef={input} onGo={go} />
        <Menu>
          <Tip label="More">
            <MenuTrigger className="icon-btn" aria-label="More" disabled={!page.url}>
              <Icon name="dots" size={15} />
            </MenuTrigger>
          </Tip>
          <MenuContent align="end" width={232}>
            <MenuItem icon="external" onSelect={openOutside}>
              Open in your browser
            </MenuItem>
            <MenuItem icon="link" onSelect={() => void copyLink()}>
              Copy link
            </MenuItem>
            {native && (
              <MenuItem icon="file-search" onSelect={openFind}>
                Find in page
              </MenuItem>
            )}
            {native && (
              <MenuItem icon="image" onSelect={() => void attachShot()}>
                Add screenshot to message
              </MenuItem>
            )}
            {native && (
              <>
                <MenuSep />
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
      </div>
    </div>
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
  onResetZoom,
  inputRef,
  onGo,
}: {
  url: string;
  title: string;
  favicon?: string;
  zoom: number;
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
