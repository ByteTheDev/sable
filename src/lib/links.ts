import type { MouseEvent } from 'react';
import { useStore } from '@/state/store';

/**
 * Addresses for the panel's Browser tab: what counts as a local page, turning typed text into a
 * URL, finding dev-server URLs in command output, and routing local links from the conversation
 * into the panel instead of a new window.
 */

const SEARCH = 'https://duckduckgo.com/?q=';

/** localhost, *.localhost, 127.0.0.0/8 and [::1]. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** An http(s) URL that points at this machine. */
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLocalHost(u.hostname);
  } catch {
    return false;
  }
}

/** Only web pages open in the panel. */
export function isWebUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const HOST_LIKE = /^(localhost|\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+[a-z0-9-]+)(:\d{1,5})?([/?#].*)?$/i;

/**
 * What the address field does with typed text: a full http(s) URL as is, a bare host gets a
 * scheme (http for local and IP addresses, https otherwise), anything else is a web search.
 * Other schemes (file:, javascript:, data:) are refused with null.
 */
export function normalizeAddress(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(text);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s !== 'http' && s !== 'https') return null;
    try {
      return new URL(text).href;
    } catch {
      return null;
    }
  }
  if (!/\s/.test(text) && HOST_LIKE.test(text)) {
    const host = HOST_LIKE.exec(text)![1];
    const plain = isLocalHost(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
    try {
      return new URL(`${plain ? 'http' : 'https'}://${text}`).href;
    } catch {
      /* fall through to a search */
    }
  }
  return SEARCH + encodeURIComponent(text);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const DEV_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9-]+\.localhost):\d{2,5}(?:[/?#][^\s'"`<>)\]}]*)?/gi;

/** Dev-server URLs (local, with a port) in command output, in order of appearance, de-duplicated. */
export function findDevUrls(text: string): string[] {
  if (!text || !text.includes('://')) return [];
  const out: string[] = [];
  for (const m of text.replace(ANSI, '').matchAll(DEV_URL)) {
    let url = m[0].replace(/[.,;:!?]+$/, '');
    // 0.0.0.0 means "every interface"; browsers reach it as localhost.
    url = url.replace(/^(https?:\/\/)0\.0\.0\.0/i, '$1localhost');
    try {
      url = new URL(url).href;
    } catch {
      continue;
    }
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

const LOCAL_URL = /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|(?:[a-z0-9-]+\.)+localhost)(?::\d{2,5})?(?:[/?#][^\s'"`<>)\]}]*)?/gi;

/**
 * Pages on this machine worth a Preview button: local http(s) URLs in the given texts (answers,
 * command output), one per host and port, first mention wins. A bare localhost or IP needs a
 * port (that is what a dev server prints); *.localhost names count without one.
 */
export function previewTargets(texts: readonly (string | undefined)[], max = 3): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text || !text.includes('://')) continue;
    for (const m of text.replace(ANSI, '').matchAll(LOCAL_URL)) {
      let raw = m[0].replace(/[.,;:!?*_]+$/, '').replace(/^(https?:\/\/)0\.0\.0\.0/i, '$1localhost');
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        continue;
      }
      if (!u.port && !u.hostname.endsWith('.localhost')) continue;
      raw = u.href;
      if (seen.has(u.host)) continue;
      seen.add(u.host);
      out.push({ url: raw, label: u.host });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Opens a local page from a Preview control: the Browser tab, or with Ctrl/Cmd the system browser. */
export function openPreview(url: string, external: boolean) {
  if (external || !openInBrowserTab(url)) window.open(url, '_blank', 'noopener,noreferrer');
}

/** Shows a page in the active session's Browser tab. Returns false when there is no session to show it in. */
export function openInBrowserTab(url: string): boolean {
  const s = useStore.getState();
  if (!s.ui.activeSessionId || !isWebUrl(url)) return false;
  s.setUi({ railOpen: true, railTab: 'browser', browserUrl: url });
  return true;
}

/**
 * Click handler for links in the conversation: local pages open in the panel's Browser tab,
 * everything else (and any modified click) keeps the link's normal behaviour.
 */
export function onLinkClick(e: MouseEvent<HTMLAnchorElement>) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.defaultPrevented) return;
  const href = e.currentTarget.href;
  if (!isLocalUrl(href)) return;
  if (openInBrowserTab(href)) e.preventDefault();
}
