import { useEffect } from 'react';
import { DEFAULT_ACCOUNT, type AccountInfo, type Capabilities, type ProviderId, type RateLimit, type SessionMeta } from '@shared/protocol';
import { homeAccountId, homeChoice, prewarmHome } from './actions';
import { accountKey, capsKey, ensureProviderCaps, useStore } from './store';

/**
 * Prewarms the agent process while focus is inside `selector` (the home composer) and a folder
 * is chosen; again whenever the choice changes, and every two minutes while focus stays (the
 * bridge drops a warm process after three idle minutes).
 */
export function usePrewarm(selector: string) {
  const sig = useStore((s) => {
    if (!s.ready || s.settings.prewarm === false || s.ui.homeProvider === 'demo') return '';
    const c = homeChoice();
    return c ? JSON.stringify(c) : '';
  });
  useEffect(() => {
    if (!sig) return;
    let timer = 0;
    let beat = 0;
    const inside = () => !!document.activeElement?.closest(selector);
    const schedule = () => {
      window.clearTimeout(timer);
      // A short pause: focus moving through the composer, or start-up still busy, starts nothing.
      timer = window.setTimeout(() => inside() && prewarmHome(), 700);
    };
    const onFocus = (e: FocusEvent) => {
      if ((e.target as Element | null)?.closest?.(selector)) schedule();
    };
    document.addEventListener('focusin', onFocus);
    beat = window.setInterval(() => inside() && prewarmHome(), 120_000);
    if (inside()) schedule();
    return () => {
      document.removeEventListener('focusin', onFocus);
      window.clearTimeout(timer);
      window.clearInterval(beat);
    };
  }, [sig, selector]);
}

/** The provider in focus: the open session's, or the one chosen on the home screen. */
export function useActiveProvider(): ProviderId {
  return useStore((s) => (s.ui.activeSessionId ? s.sessions[s.ui.activeSessionId]?.provider : undefined) ?? s.ui.homeProvider);
}

/**
 * Capabilities for a composer: the session's own once it has reported them,
 * otherwise what the provider offers in that folder (fetched on demand).
 */
export function useCaps(sessionId: string | null): Capabilities | undefined {
  return useCapsState(sessionId).caps;
}

/** `useCaps` plus whether loading them failed for good (then there is nothing to wait for). */
export function useCapsState(sessionId: string | null): { caps: Capabilities | undefined; failed: boolean } {
  const provider = useStore((s) => (sessionId ? s.sessions[sessionId]?.provider : s.ui.homeProvider));
  const cwd = useStore((s) => (sessionId ? (s.sessions[sessionId]?.cwd ?? null) : s.ui.homeCwd));
  const accountId = useStore((s) => (sessionId ? s.sessions[sessionId]?.accountId : provider ? homeAccountId(provider, s) : undefined));
  const sessionCaps = useStore((s) => (sessionId ? s.data[sessionId]?.caps : undefined));
  const providerCaps = useStore((s) => (provider ? s.providerCaps[capsKey(provider, cwd, accountId)] : undefined));
  const failed = useStore((s) => (provider ? !!s.capsFailed[capsKey(provider, cwd, accountId)] : true));
  const ready = useStore((s) => s.ready);
  useEffect(() => {
    if (ready && provider && !sessionCaps) ensureProviderCaps(provider, cwd, accountId);
  }, [ready, provider, cwd, accountId, sessionCaps]);
  const caps = sessionCaps ?? providerCaps;
  return { caps, failed: !caps && failed };
}

// ── accounts ──

const NO_ACCOUNTS: AccountInfo[] = [];

/** An agent's accounts, the built-in default first (empty until the bridge has answered). */
export function useAccounts(provider: ProviderId): AccountInfo[] {
  return useStore((s) => s.providers[provider]?.accounts) ?? NO_ACCOUNTS;
}

/** The account in focus: the open session's, otherwise the home choice for the home agent. */
export function useFocusAccount(): { provider: ProviderId; accountId: string } {
  const provider = useActiveProvider();
  const accountId = useStore((s) => {
    const session = s.ui.activeSessionId ? s.sessions[s.ui.activeSessionId] : undefined;
    return session ? (session.accountId ?? DEFAULT_ACCOUNT) : homeAccountId(provider, s);
  });
  return { provider, accountId };
}

/** Plan limits of one account, when known. */
export function useAccountLimits(provider: ProviderId | undefined, accountId?: string): RateLimit[] | undefined {
  return useStore((s) => (provider ? s.limits[accountKey(provider, accountId)] : undefined));
}

/** How an account reads in one line: its email once signed in, otherwise its label. */
export function accountName(a: AccountInfo | undefined): string {
  if (!a) return 'Removed account';
  return (a.auth.loggedIn && a.auth.email) || a.label;
}

/**
 * A session's account name for places that show its agent, only when that agent has more
 * than one account (otherwise there is nothing to tell apart).
 */
export function useSessionAccountName(session: Pick<SessionMeta, 'provider' | 'accountId'> | undefined): string | undefined {
  const provider = session?.provider;
  const accountId = session?.accountId ?? DEFAULT_ACCOUNT;
  return useStore((s) => {
    const accounts = provider ? s.providers[provider]?.accounts : undefined;
    if (!accounts || accounts.length < 2) return undefined;
    return accountName(accounts.find((a) => a.id === accountId));
  });
}

/** Calls `fn` on a global key combo like "mod+k". Ignores typing in fields unless `inFields`. */
export function useHotkey(combo: string, fn: (e: KeyboardEvent) => void, opts: { inFields?: boolean; enabled?: boolean } = {}) {
  const { inFields = true, enabled = true } = opts;
  useEffect(() => {
    if (!enabled) return;
    const parts = combo.toLowerCase().split('+');
    const key = parts[parts.length - 1];
    const needMod = parts.includes('mod');
    const needShift = parts.includes('shift');
    const needAlt = parts.includes('alt');
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (needMod !== mod || needShift !== e.shiftKey || needAlt !== e.altKey) return;
      if (e.key.toLowerCase() !== key) return;
      if (!inFields) {
        const t = e.target as HTMLElement | null;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      }
      fn(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [combo, fn, inFields, enabled]);
}

/**
 * Asks the active composer to take focus. With `text` it replaces the draft, or with
 * `{ append: true }` inserts the text at the cursor (used for "@file" mentions from panels).
 */
export function focusComposer(text?: string, opts: { append?: boolean } = {}) {
  window.dispatchEvent(new CustomEvent('sable:focus-composer', { detail: { text, append: !!opts.append } }));
}
