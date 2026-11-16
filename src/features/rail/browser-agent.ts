import type { BrowserAnswer, BrowserRequest } from '@shared/protocol';
import { reportBrowserPage, respondBrowser } from '@/state/actions';
import { useStore } from '@/state/store';
import { getLog, getPage, onPages, setPage, type AgentWork } from './browser-store';
import { clickScript, evalScript, focusedScript, pickCancelScript, keyProbeRead, keyProbeScript, pressScript, requestsScript, scrollScript, snapshotScript, typeScript, waitScript } from './browser-scripts';

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
  /** Runs one of Sable's page scripts (browser-scripts.ts) and gives its plain result. */
  run(script: string): Promise<unknown>;
  /** A real key press through the shell; false when it could not be sent. */
  key(combo: string): Promise<boolean>;
  /** Back, forward or reload; false when there is nowhere to go. */
  history(action: 'back' | 'forward' | 'reload'): boolean;
}

const TEXT_MAX = 20_000;
const SNAPSHOT_MAX = 12_000;
const EVAL_MAX = 8_000;
const EVAL_MS = 5_000;
const LINES_MAX = 60;
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
async function marked<T>(sessionId: string, op: AgentWork, fn: () => Promise<T>): Promise<T> {
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

  if (req.op !== 'screenshot') return marked(sessionId, req.op, () => work(req, c, url));

  return marked(sessionId, 'screenshot', async () => {
    const image = await c.capture();
    const size = await imageSize(image);
    return { ok: true, url: c.url() || url, title: getPage(sessionId).title, image, ...size };
  });
}

/** A page script's answer, or a plain failure when the page does not give one in time (it went away, or hangs). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error('The page did not answer in time.')), ms))]);
}

const isLocal = (url: string) => {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
  } catch {
    return false;
  }
};

type Done = { error?: string; target?: string; text?: string; title?: string; count?: number; truncated?: boolean; length?: number; timedOut?: boolean; secret?: boolean };
const plain = (v: unknown): Done => (v && typeof v === 'object' ? (v as Done) : {});
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** The tools that work the page: outline, click, type, press, scroll, script, logs, wait, history. */
async function work(req: BrowserRequest, c: PageController, url: string): Promise<BrowserAnswer> {
  const { sessionId } = req;
  const before = c.url() || url;
  const q = { ref: req.ref, selector: req.selector };
  /** After an action: a load it started is waited for, then where the page is. */
  const after = async (extra: Partial<BrowserAnswer> = {}): Promise<BrowserAnswer> => {
    await sleep(250);
    if (getPage(sessionId).loading) await waitFor(sessionId, () => !getPage(sessionId).loading, 10_000);
    const now = c.url() || getPage(sessionId).url;
    return { ok: true, url: now, title: getPage(sessionId).title, navigated: now.split('#')[0] !== before.split('#')[0] || undefined, ...extra };
  };

  // The person's pick mode swallows clicks and keys in the page: an action of the agent ends it first.
  if (req.op === 'click' || req.op === 'type' || req.op === 'press') await within(c.run(pickCancelScript), 3_000).catch(() => {});

  switch (req.op) {
    case 'snapshot': {
      const r = plain(await within(c.run(snapshotScript(SNAPSHOT_MAX)), 8_000));
      return { ok: true, url: before, title: text(r.title, 300) || getPage(sessionId).title, text: text(r.text, SNAPSHOT_MAX) ?? '', count: Number(r.count) || 0, truncated: r.truncated === true };
    }
    case 'click': {
      const r = plain(await within(c.run(clickScript({ ...q, text: req.find })), 8_000));
      if (r.error) return { ok: false, url: before, error: String(r.error).slice(0, 400) };
      return after({ target: text(r.target, 200) });
    }
    case 'type': {
      const r = plain(await within(c.run(typeScript(q, (req.text ?? '').slice(0, 2_000), req.submit === true)), 8_000));
      if (r.error) return { ok: false, url: before, error: String(r.error).slice(0, 400) };
      return after({ target: text(r.target, 200) });
    }
    case 'press': {
      const key = req.key ?? '';
      const focus = plain(await within(c.run(focusedScript), 5_000));
      // Characters into a password field would be typing it, one key at a time.
      if (focus.secret && /(^|\+)[\x21-\x7e]$/.test(key)) return { ok: false, url: before, error: 'Sable does not type into password or payment fields. Ask the user to fill this one in the Browser tab.' };
      await within(c.run(keyProbeScript), 5_000);
      const sent = await c.key(key).catch(() => false);
      await sleep(90);
      const moved = getPage(sessionId).loading || (c.url() || '') !== before;
      const arrived = moved || (sent && (await within(c.run(keyProbeRead), 5_000).catch(() => true)) === true);
      // The shell's key did not reach the page (no focus in it): the same press as events on the focused element.
      if (!arrived) await within(c.run(pressScript(key)), 5_000);
      return after({ target: text(focus.target, 200) });
    }
    case 'scroll': {
      const r = plain(await within(c.run(scrollScript(q, req.to, req.by)), 5_000));
      if (r.error) return { ok: false, url: before, error: String(r.error).slice(0, 400) };
      return { ok: true, url: before, title: getPage(sessionId).title, target: text(r.target, 200), text: text(r.text, 120) };
    }
    case 'eval': {
      let r: Done;
      try {
        r = plain(await within(c.run(evalScript(req.script ?? '', EVAL_MAX, EVAL_MS, !isLocal(before))), EVAL_MS + 3_000));
      } catch (err) {
        // A script that does not parse never starts: the shell reports only that it failed.
        return { ok: false, url: before, error: `The script did not run (${(err as Error)?.message || 'it could not be parsed'}). It is the body of an async function: check its syntax.` };
      }
      if (r.error) return { ok: false, url: before, error: String(r.error).slice(0, 500) };
      return after({ text: text(r.text, EVAL_MAX) ?? 'undefined', truncated: (Number(r.length) || 0) > EVAL_MAX });
    }
    case 'logs': {
      const log = getLog(sessionId);
      if (req.kind === 'network') {
        const got = (await within(c.run(requestsScript(LINES_MAX)), 5_000)) as { total?: number; requests?: { url?: unknown; kind?: unknown; status?: unknown; ms?: unknown }[] } | null;
        const requests = (Array.isArray(got?.requests) ? got.requests : []).slice(-LINES_MAX).map((e) => ({ url: String(e.url ?? '').slice(0, 300), kind: String(e.kind ?? '').slice(0, 20), status: Number(e.status) || undefined, ms: Number(e.ms) || 0 }));
        // Requests that failed outright have no timing entry: the shell saw them.
        const known = new Set(requests.filter((r) => (r.status ?? 0) >= 400).map((r) => r.url));
        const failed = log.failed.filter((f) => !known.has(f.url)).slice(-20).map((f) => ({ url: f.url, method: f.method, status: f.status, error: f.status ? undefined : f.error || 'failed' }));
        return { ok: true, url: before, title: getPage(sessionId).title, requests: [...requests, ...failed], more: { failed: Math.max(0, (Number(got?.total) || 0) - requests.length) } };
      }
      return { ok: true, url: before, title: getPage(sessionId).title, lines: log.lines.slice(-LINES_MAX), more: { console: log.moreLines + Math.max(0, log.lines.length - LINES_MAX) } };
    }
    case 'wait': {
      const ms = Math.max(100, Math.min(30_000, req.timeoutMs ?? 5_000));
      const started = Date.now();
      let r: Done;
      try {
        r = plain(await within(c.run(waitScript(req.selector, ms)), ms + 3_000));
      } catch {
        // The document went away while waiting (a navigation): the wait ends with the page as it is now.
        r = { count: Date.now() - started, timedOut: !!req.selector };
      }
      if (r.error) return { ok: false, url: before, error: String(r.error).slice(0, 400) };
      return { ok: true, url: c.url() || before, title: text(r.title, 300) || getPage(sessionId).title, count: Number(r.count) || 0, timedOut: r.timedOut === true || undefined };
    }
    case 'navigate': {
      const action = req.action ?? 'reload';
      let sawLoad = false;
      if (!c.history(action)) return { ok: false, url: before, error: action === 'reload' ? 'The page could not be reloaded.' : `There is no page to go ${action} to.` };
      // A step inside one document (a hash, pushState) never loads: a short wait tells the two apart.
      await waitFor(sessionId, () => (sawLoad ||= getPage(sessionId).loading), 1_200);
      if (sawLoad) await waitFor(sessionId, () => !getPage(sessionId).loading, 30_000);
      const p = getPage(sessionId);
      if (p.error) return { ok: false, url: p.url, error: `The page did not load: ${loadFailure(p.errorCode, p.url)} (${p.error}).` };
      if (p.loading) return { ok: false, url: p.url, error: 'The page is still loading after 30 seconds.' };
      // The title often arrives just after the load.
      if (sawLoad && !p.title) await waitFor(sessionId, () => !!getPage(sessionId).title, 800);
      return { ok: true, url: c.url() || p.url, title: getPage(sessionId).title };
    }
    default:
      return { ok: false, error: 'The Browser tab does not know that request.' };
  }
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
