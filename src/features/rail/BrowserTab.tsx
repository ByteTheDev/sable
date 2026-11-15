import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment } from '@shared/protocol';
import { Glyph, Icon } from '@/icons';
import { isLocalUrl, normalizeAddress } from '@/lib/links';
import * as actions from '@/state/actions';
import { focusComposer } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton, Menu, MenuContent, MenuItem, MenuSep, MenuTrigger, Tip } from '@/ui';
import { getPage, pushHistory, setPage, stepHistory, useDevUrls, usePage } from './browser-store';
import './browser.css';

/**
 * The panel's Browser tab: the page an agent is building, next to the conversation. A real browser
 * view (<webview>) in the desktop app, a sandboxed frame in the web build.
 */

interface DesktopApi {
  platform: string;
  debug?: boolean;
  browser?: {
    capture(webContentsId: number): Promise<string>;
    clearData(): Promise<void>;
    onEvent(cb: (e: { type: string; name?: string }) => void): () => void;
  };
}

/** The Electron <webview> element: only the parts used here. */
interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>;
  reload(): void;
  stop(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getWebContentsId(): number;
}

type WebviewEvent = Event & {
  url?: string;
  isMainFrame?: boolean;
  title?: string;
  favicons?: string[];
  errorCode?: number;
  errorDescription?: string;
  validatedURL?: string;
};

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
        setPage(sessionId, nav());
      });
      on('did-start-loading', () => setPage(sessionId, { loading: true, error: undefined }));
      on('did-stop-loading', () => setPage(sessionId, { loading: false, ...nav() }));
      on('did-navigate', (e) => e.url && setPage(sessionId, { url: e.url, favicon: undefined, ...nav() }));
      on('did-navigate-in-page', (e) => e.isMainFrame && e.url && setPage(sessionId, { url: e.url, ...nav() }));
      on('page-title-updated', (e) => setPage(sessionId, { title: e.title ?? '' }));
      on('page-favicon-updated', (e) => setPage(sessionId, { favicon: e.favicons?.find((f) => /^(https:|data:image\/)/.test(f)) }));
      on('did-fail-load', (e) => {
        // -3 is an aborted load (a new navigation replaced it).
        if (!e.isMainFrame || e.errorCode === -3) return;
        setPage(sessionId, { loading: false, error: e.errorDescription || 'The page did not load', url: e.validatedURL || getPage(sessionId).url, ...nav() });
      });
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
      setPage(sessionId, { loading: true, canBack: false, canForward: false });
      ensureView(url);
    }
    const off = desktop?.browser?.onEvent((e) => {
      if (e.type === 'download-blocked') useStore.getState().toast(`Downloads are off in the panel browser${e.name ? ` (${e.name})` : ''}. Open the page in your browser to download.`);
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
        setPage(sessionId, { url, title: '', error: undefined, loading: true });
        if (!ensureView(url) && view.current) {
          if (ready.current) view.current.loadURL(url).catch(() => {});
          else view.current.setAttribute('src', url);
        }
      } else {
        pushHistory(sessionId, url);
      }
      // A page asked for from elsewhere replaces whatever was half-typed in the address field.
      input.current?.blur();
      return true;
    },
    [sessionId, ensureView, toast],
  );

  const back = () => (native ? view.current?.goBack() : stepHistory(sessionId, -1));
  const forward = () => (native ? view.current?.goForward() : stepHistory(sessionId, 1));
  const reload = () => {
    setPage(sessionId, { error: undefined });
    if (native) view.current?.reload();
    else setPage(sessionId, { nonce: page.nonce + 1, loading: true });
  };
  const stop = () => view.current?.stop();

  // Another part of the app asked for a page (a local link in the conversation, /browser, the palette).
  const wanted = useStore((s) => s.ui.browserUrl);
  useEffect(() => {
    if (!wanted || useStore.getState().ui.browserUrl !== wanted) return;
    useStore.getState().setUi({ browserUrl: undefined });
    go(wanted);
  }, [wanted, go]);

  useEffect(() => {
    if (active && !getPage(sessionId).url) requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
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

  return (
    <div className="rail-col bw">
      <div className="bw-bar">
        <IconButton icon="arrow-left" label="Back" size={14} disabled={!canBack} onClick={back} />
        <IconButton icon="arrow-right" label="Forward" size={14} disabled={!canForward} onClick={forward} />
        {native && page.loading ? (
          <IconButton icon="x" label="Stop" size={14} onClick={stop} />
        ) : (
          <IconButton icon="refresh" label="Reload" size={14} disabled={!page.url} onClick={reload} />
        )}
        <AddressField url={page.url} title={page.title} favicon={page.favicon} inputRef={input} onGo={go} />
        <Menu>
          <Tip label="More">
            <MenuTrigger className="icon-btn" aria-label="More" disabled={!page.url}>
              <Icon name="dots" size={15} />
            </MenuTrigger>
          </Tip>
          <MenuContent align="end" width={256}>
            <MenuItem icon="external" onSelect={openOutside}>
              Open in your browser
            </MenuItem>
            <MenuItem icon="link" onSelect={() => void copyLink()}>
              Copy link
            </MenuItem>
            <MenuSep />
            {native && (
              <MenuItem icon="image" onSelect={() => void attachShot()}>
                Attach screenshot to chat
              </MenuItem>
            )}
            <MenuItem icon="at" onSelect={() => focusComposer(`${page.url} `, { append: true })}>
              Mention this page in chat
            </MenuItem>
            {native && (
              <>
                <MenuSep />
                <MenuItem icon="broom" onSelect={() => void clearData()}>
                  Clear browsing data
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
        <span className="bw-progress" data-on={page.loading || undefined} aria-hidden />
      </div>

      {showNote && (
        <div className="bw-note">
          <Icon name="info" size={14} />
          <span className="bw-note-text">Some sites refuse to be embedded. Local pages work here; use the desktop app for the full web.</span>
          <button type="button" className="btn btn-sm" onClick={openOutside}>
            Open in your browser
          </button>
        </div>
      )}

      <div className="bw-view" data-empty={!page.url || undefined}>
        {native && <div className="bw-host" ref={host} />}
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
            }}
          />
        )}
        {native && page.error && page.url && (
          <div className="bw-error">
            <p>
              {isLocalUrl(page.url) ? 'Nothing answered at ' : 'Could not load '}
              <span className="bw-error-url">{prettyUrl(page.url)}</span>
              {isLocalUrl(page.url) ? '. Is the server running?' : '.'}
            </p>
            <p className="bw-error-code">{page.error}</p>
            <button type="button" className="btn btn-sm" onClick={reload}>
              <Icon name="refresh" size={13} />
              Try again
            </button>
          </div>
        )}
        {!page.url && <EmptyState sessionId={sessionId} onGo={go} />}
      </div>
    </div>
  );
}

function AddressField({
  url,
  title,
  favicon,
  inputRef,
  onGo,
}: {
  url: string;
  title: string;
  favicon?: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onGo: (raw: string) => boolean;
}) {
  const [value, setValue] = useState(url);
  const [focused, setFocused] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);

  useEffect(() => {
    if (!focused) setValue(url);
  }, [url, focused]);
  useEffect(() => setIconFailed(false), [favicon]);

  const showTitle = !focused && !!url && !!title && title !== url && title !== prettyUrl(url);

  return (
    <form
      className="bw-addr"
      data-focused={focused || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        if (onGo(value)) inputRef.current?.blur();
      }}
    >
      {favicon && !iconFailed ? (
        <img className="bw-favicon" src={favicon} alt="" onError={() => setIconFailed(true)} />
      ) : (
        <Icon name="globe" size={13} className="bw-addr-icon" />
      )}
      <input
        ref={inputRef}
        value={focused ? value : ''}
        placeholder={url ? '' : 'Search or enter an address'}
        aria-label="Address"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => {
          setFocused(true);
          setValue(url);
          const el = e.currentTarget;
          requestAnimationFrame(() => el.select());
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
      {!focused && url && (
        <span className="bw-addr-view" aria-hidden>
          <span className="bw-addr-url">{prettyUrl(url)}</span>
          {showTitle && <span className="bw-addr-title">{title}</span>}
        </span>
      )}
    </form>
  );
}

function EmptyState({ sessionId, onGo }: { sessionId: string; onGo: (raw: string) => boolean }) {
  const urls = useDevUrls(sessionId);
  return (
    <div className="bw-empty scroll">
      <p className="bw-empty-line">Enter an address to see the page next to the conversation.</p>
      {urls.length > 0 && (
        <div className="bw-quick">
          <div className="rail-h">Dev servers in this session</div>
          <ul className="bw-quick-list">
            {urls.map((u) => (
              <li key={u}>
                <button type="button" className="bw-quick-row" onClick={() => onGo(u)}>
                  <Glyph name="globe" size={24} />
                  <span className="bw-quick-url truncate">{prettyUrl(u)}</span>
                  <Icon name="arrow-right" size={13} className="bw-quick-go" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
