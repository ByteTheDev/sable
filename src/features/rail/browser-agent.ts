import type { BrowserAnswer, BrowserRequest } from '@shared/protocol';
import { reportBrowserPage, respondBrowser } from '@/state/actions';
import { useStore } from '@/state/store';
import { getLog, getPage, onPages, setPage } from './browser-store';

/**
 * The window's side of the agent's browser tools (server/providers/browser-tool.ts): the bridge asks
 * with a `browser.request` event, the live Browser tab of that session does the work on its
 * <webview>, and the answer goes back with `browser.respond`. Only text, a picture, the page's
 * console problems and its failed requests ever leave the page: never cookies, storage or headers.
 */

/** What a live Browser tab offers the agent; registered while its <webview> exists. */
export interface PageController {
  sessionId: string;
  /** The address the view is on. */
  url(): string;
  /** The page's readable text (or of `selector`), cut at `max` characters. */
  read(selector: string | undefined, max: number): Promise<{ title: string; text: string; length: number; missing?: boolean; badSelector?: boolean }>;
  /** A picture of the page, sized for the agent. */
  capture(): Promise<string>;
}

const TEXT_MAX = 20_000;
const controllers = new Map<string, PageController>();

const desktop = (window as { sableDesktop?: { browser?: unknown } }).sableDesktop;
const native = !!desktop?.browser;

/** The Browser tab of `c.sessionId` has a live page: the agent can look at it. */
export function registerPage(c: PageController): () => void {
  controllers.set(c.sessionId, c);
  schedulePageReport();
  return () => {
    if (controllers.get(c.sessionId) === c) controllers.delete(c.sessionId);
    schedulePageReport();
  };
}

/* ── what the tab shows, for the line the agent gets with the next message ── */

const reported = new Map<string, string>();
let reportTimer: ReturnType<typeof setTimeout> | undefined;

function schedulePageReport() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(reportPages, 300);
}

function reportPages() {
  const seen = new Set<string>();
  for (const [sessionId, c] of controllers) {
    seen.add(sessionId);
    const p = getPage(sessionId);
    // Settled pages only: a load in flight reports once it is done.
    if (p.loading) continue;
    const url = c.url() || p.url;
    const page = url && !p.error && /^https?:/.test(url) ? { url, title: p.title } : null;
    const key = page ? `${page.url}\n${page.title}` : '';
    if (reported.get(sessionId) === key) continue;
    reported.set(sessionId, key);
    void reportBrowserPage(sessionId, page);
  }
  for (const sessionId of [...reported.keys()]) {
    if (seen.has(sessionId)) continue;
    reported.delete(sessionId);
    void reportBrowserPage(sessionId, null);
  }
}

onPages(() => {
  if (controllers.size || reported.size) schedulePageReport();
});

/* ── requests from the bridge ── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for `test` to hold on the session's page (checked on every change), or gives up. */
function waitFor(sessionId: string, test: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (test()) return resolve(true);
    let off = () => {};
    const timer = setTimeout(() => {
      off();
      clearInterval(poll);
      resolve(test());
    }, ms);
    // Page changes and controllers registering both count; a slow poll covers the latter.
    const check = () => {
      if (!test()) return;
      clearTimeout(timer);
      clearInterval(poll);
      off();
      resolve(true);
    };
    off = onPages(check);
    const poll = setInterval(check, 150);
    void sessionId;
  });
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

/** Shows the agent's work in the bar for its moment (at least long enough to be seen). */
async function marked<T>(sessionId: string, op: 'read' | 'screenshot' | 'open', fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  setPage(sessionId, { agent: op });
  try {
    return await fn();
  } finally {
    const left = 700 - (Date.now() - started);
    if (left > 0) await sleep(left);
    if (getPage(sessionId).agent === op) setPage(sessionId, { agent: undefined });
  }
}

export async function handleBrowserRequest(req: BrowserRequest) {
  let answer: BrowserAnswer;
  try {
    answer = await serve(req);
  } catch (err) {
    answer = { ok: false, error: (err as Error)?.message || 'The Browser tab could not do that.' };
  }
  void respondBrowser(req.sessionId, req.id, answer);
}

async function serve(req: BrowserRequest): Promise<BrowserAnswer> {
  if (!native) return { ok: false, weak: true, error: 'The Browser tab is only available in the desktop app.' };
  const st = useStore.getState();
  if (st.ui.activeSessionId !== req.sessionId) {
    return { ok: false, weak: true, error: 'The Browser tab shows another session right now. It works while the user has this session open.' };
  }
  const { sessionId } = req;

  if (req.op === 'open') {
    const url = req.url ?? '';
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Only http and https addresses open in the Browser tab.' };
    if (originOf(url) === location.origin) return { ok: false, error: 'Sable itself does not open in the Browser tab.' };
    return marked(sessionId, 'open', async () => {
      let sawLoad = false;
      // The page view may not exist yet (panel closed, or another tab in front): open the panel on it.
      useStore.getState().setUi({ railOpen: true, railTab: 'browser', browserUrl: url });
      const settled = await waitFor(
        sessionId,
        () => {
          const p = getPage(sessionId);
          if (p.loading) sawLoad = true;
          return !!controllers.get(sessionId) && sawLoad && !p.loading && !!p.url;
        },
        35_000,
      );
      const p = getPage(sessionId);
      if (!settled) return p.loading ? { ok: false, error: `The page is still loading after 35 seconds (${p.url || url}).` } : { ok: false, error: 'The Browser tab did not open the page.' };
      if (p.error) return { ok: false, url: p.url, error: `The page did not load: ${loadFailure(p.errorCode, p.url)} (${p.error}).` };
      // The title often arrives just after the load.
      if (!p.title) await waitFor(sessionId, () => !!getPage(sessionId).title, 800);
      const now = getPage(sessionId);
      return { ok: true, url: controllers.get(sessionId)?.url() || now.url, title: now.title };
    });
  }

  const c = controllers.get(sessionId);
  const p = getPage(sessionId);
  if (!c) {
    return p.url
      ? { ok: false, error: `The Browser tab is closed. Use browser_open to open ${p.url} again.` }
      : { ok: false, error: 'No page is open in the Browser tab. Use browser_open to open one.' };
  }
  const url = c.url() || p.url;
  if (req.op === 'state') return { ok: true, url, title: p.title };
  if (!/^https?:/i.test(url)) return { ok: false, error: 'Sable reads only web pages (http or https).' };
  if (req.expectOrigin && originOf(url) !== req.expectOrigin) return { ok: false, error: 'The page changed while it was being checked. Try again.' };
  if (p.crashed) return { ok: false, url, error: 'The page stopped working. The user can reload it.' };
  if (p.error) return { ok: false, url, error: `The page did not load: ${loadFailure(p.errorCode, url)} (${p.error}).` };
  // A load in flight: wait a little for it to settle.
  if (p.loading) await waitFor(sessionId, () => !getPage(sessionId).loading, 8_000);

  if (req.op === 'read') {
    return marked(sessionId, 'read', async () => {
      const r = await c.read(req.selector, TEXT_MAX);
      if (r.badSelector) return { ok: false, url, error: `"${req.selector}" is not a valid CSS selector.` };
      if (r.missing) return { ok: false, url, error: `Nothing on the page matches "${req.selector}".` };
      const log = getLog(sessionId);
      return {
        ok: true,
        url: c.url() || url,
        title: r.title || getPage(sessionId).title,
        text: r.text.slice(0, TEXT_MAX),
        truncated: r.length > TEXT_MAX,
        console: log.console.slice(-30),
        failed: log.failed.slice(-30),
        more: { console: log.more.console + Math.max(0, log.console.length - 30), failed: log.more.failed + Math.max(0, log.failed.length - 30) },
      };
    });
  }

  return marked(sessionId, 'screenshot', async () => {
    const image = await c.capture();
    const size = await imageSize(image);
    return { ok: true, url: c.url() || url, title: getPage(sessionId).title, image, ...size };
  });
}

function imageSize(src: string): Promise<{ width?: number; height?: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({});
    img.src = src;
  });
}

/** A failed load in plain words (the same words the tab shows). */
function loadFailure(code: number | undefined, url: string): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the address */
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)|\.localhost(:|$)/.test(host);
  const c = code ?? 0;
  if (c === -102 || c === -101 || c === -100 || c === -109) return local ? `Nothing is running at ${host}` : `${host} refused to connect`;
  if (c === -105 || c === -137) return `Could not find ${host}`;
  if (c === -106) return 'You are offline';
  if (c === -7 || c === -118) return `${host} took too long to answer`;
  return `${host} did not load`;
}

/** The script that reads a page's text. Runs in the page; only reads text, never storage or cookies. */
export function readScript(selector: string | undefined, max: number): string {
  return `(() => {
  const sel = ${JSON.stringify(selector ?? '')};
  let root = document.body;
  if (sel) {
    try { root = document.querySelector(sel); } catch (e) { return { badSelector: true, title: document.title, text: '', length: 0 }; }
    if (!root) return { missing: true, title: document.title, text: '', length: 0 };
  }
  const t = root ? String(root.innerText || root.textContent || '') : '';
  return { title: String(document.title || ''), text: t.slice(0, ${max + 1}), length: t.length };
})()`;
}
