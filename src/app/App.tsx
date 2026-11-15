import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { INTRO_DELAY, INTRO_MIN, LogoIntro, LogoMark, ProviderMark } from '@/art/Logo';
import { Home } from '@/features/home/Home';
import { handoffActive } from '@/features/home/handoff';
import { useOnboarding } from '@/features/onboarding/useOnboarding';
import { SessionView } from '@/features/session/SessionView';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { Icon } from '@/icons';
import { desktop, onWindowControlsChange, windowControlsWidth } from '@/lib/desktop';
import { baseName, formatTokens } from '@/lib/format';
import { goHome, openSettings } from '@/state/actions';
import { useActiveProvider, useHotkey, useSessionAccountName } from '@/state/hooks';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/state/store';
import { IconButton, Tip, TipProvider, Toasts } from '@/ui';
import { CapabilitiesButton } from './Capabilities';
import './app.css';

// Surfaces that are not part of the first paint load on demand (and are prefetched once idle).
const loadPalette = () => import('@/features/palette/Palette');
const loadHistory = () => import('@/features/history/History');
const loadSettings = () => import('@/features/settings/Settings');
const loadPicker = () => import('@/features/projects/ProjectPicker');
const loadRail = () => import('@/features/rail/Rail');
const Palette = lazy(() => loadPalette().then((m) => ({ default: m.Palette })));
const History = lazy(() => loadHistory().then((m) => ({ default: m.History })));
const Settings = lazy(() => loadSettings().then((m) => ({ default: m.Settings })));
const ProjectPicker = lazy(() => loadPicker().then((m) => ({ default: m.ProjectPicker })));
const Rail = lazy(() => loadRail().then((m) => ({ default: m.Rail })));
const Onboarding = lazy(() => import('@/features/onboarding/Onboarding').then((m) => ({ default: m.Onboarding })));

/** Mounts a lazy surface the first time it is asked for, then keeps it (so its exit animations run). */
function Deferred({ when, children }: { when: boolean; children: ReactNode }) {
  const [seen, setSeen] = useState(when);
  if (when && !seen) setSeen(true);
  return seen ? <Suspense fallback={null}>{children}</Suspense> : null;
}

/**
 * True while the launch intro shows. A bridge that is ready before the intro would appear
 * skips it; otherwise it stays until its one fade-in has finished, so it never flickers.
 * Latched: once the app has shown, the intro never comes back.
 */
function useIntro(ready: boolean): boolean {
  const [start] = useState(() => performance.now());
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!ready || done) return;
    const elapsed = performance.now() - start;
    const wait = elapsed < INTRO_DELAY ? 0 : Math.max(0, INTRO_MIN - elapsed);
    const t = window.setTimeout(() => setDone(true), wait);
    return () => window.clearTimeout(t);
  }, [ready, done, start]);
  return !done;
}

export function App() {
  const ready = useStore((s) => s.ready);
  const conn = useStore((s) => s.conn);
  const activeId = useStore((s) => s.ui.activeSessionId);
  const sidebarOpen = useStore((s) => s.ui.sidebarOpen);
  const railOpen = useStore((s) => s.ui.railOpen);
  const fontScale = useStore((s) => s.settings.fontScale);
  const setUi = useStore((s) => s.setUi);
  // The open session's id and title only: the shell must not re-render on every usage tick.
  const sessionId = useStore((s) => (activeId && s.sessions[activeId] ? activeId : null));
  const title = useStore((s) => (activeId ? s.sessions[activeId]?.title : undefined));
  const provider = useActiveProvider();
  const booting = useIntro(ready);
  // First run: the welcome takes over the window; the app behind it waits, inert.
  const onboarding = useOnboarding(!booting);

  useEffect(() => {
    document.title = title ? `${title} · Sable` : 'Sable';
  }, [title]);

  // Interface size scales everything (type, spacing, icons) the way browser zoom does.
  // Floating layers are positioned in unzoomed pixels and undo it (see `--ui-zoom` in ui.css).
  useEffect(() => {
    const root = document.documentElement.style;
    root.zoom = fontScale === 1 ? '' : String(fontScale);
    root.setProperty('--ui-zoom', String(fontScale));
  }, [fontScale]);
  useTitleStrip(fontScale);

  const paletteOpen = useStore((s) => s.ui.paletteOpen);
  const historyOpen = useStore((s) => s.ui.historyOpen);
  const settingsOpen = useStore((s) => s.ui.settings !== null);
  const pickerOpen = useStore((s) => s.ui.projectPicker);

  // Warm the on-demand chunks once the app is idle, so the first open is instant.
  useEffect(() => {
    if (!ready) return;
    const warm = () => void Promise.all([loadPalette(), loadRail(), loadSettings(), loadHistory(), loadPicker()]).catch(() => {});
    const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(warm, { timeout: 4000 });
    else window.setTimeout(warm, 1500);
  }, [ready]);

  useHotkey('mod+k', useCallback((e) => (e.preventDefault(), setUi({ paletteOpen: !useStore.getState().ui.paletteOpen })), [setUi]));
  useHotkey('mod+b', useCallback((e) => (e.preventDefault(), setUi({ sidebarOpen: !useStore.getState().ui.sidebarOpen })), [setUi]));
  useHotkey('mod+j', useCallback((e) => (e.preventDefault(), setUi({ railOpen: !useStore.getState().ui.railOpen })), [setUi]));
  useHotkey('mod+,', useCallback((e) => (e.preventDefault(), openSettings()), []));
  useHotkey('mod+shift+o', useCallback((e) => (e.preventDefault(), goHome()), []));
  useHotkey('mod+o', useCallback((e) => (e.preventDefault(), setUi({ projectPicker: true })), [setUi]));

  return (
    <TipProvider>
      <div className="app" data-provider={provider} data-sidebar={sidebarOpen}>
        <aside className="app-side" aria-hidden={!sidebarOpen || onboarding} inert={onboarding}>
          <Sidebar />
        </aside>

        <main className="stage" inert={onboarding}>
          <Topbar />
          <div className="stage-body">
            <AnimatePresence>{booting && <LogoIntro key="intro" ready={ready} />}</AnimatePresence>
            <AnimatePresence mode="popLayout" initial={false}>
              {booting || onboarding ? null : sessionId ? (
                <motion.div
                  key={sessionId}
                  className="stage-view"
                  // After a send from home the conversation fades in around the docked composer, which must not move.
                  initial={handoffActive() ? { opacity: 0 } : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: handoffActive() ? 0.32 : 0.24, delay: handoffActive() ? 0.08 : 0, ease: [0.16, 1, 0.3, 1] }}
                >
                  <SessionView sessionId={sessionId} />
                </motion.div>
              ) : (
                <motion.div
                  key="home"
                  className="stage-view"
                  initial={{ opacity: 0, scale: 0.985 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={handoffActive() ? { opacity: 0, transition: { duration: 0.42, ease: [0.4, 0, 0.2, 1] } } : { opacity: 0, scale: 1.01 }}
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                >
                  <Home />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {ready && conn !== 'open' && (
            <div className="offline" role="status">
              <span className="spinner" />
              Reconnecting to the bridge
            </div>
          )}
        </main>

        <AnimatePresence initial={false}>
          {railOpen && sessionId && (
            <motion.aside
              key="rail"
              className="app-rail"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 'var(--rail-w)', opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 38 }}
            >
              <div className="app-rail-inner">
                <Suspense fallback={null}>
                  <Rail sessionId={sessionId} />
                </Suspense>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        <Deferred when={paletteOpen}>
          <Palette />
        </Deferred>
        <Deferred when={historyOpen}>
          <History />
        </Deferred>
        <Deferred when={settingsOpen}>
          <Settings />
        </Deferred>
        <Deferred when={pickerOpen}>
          <ProjectPicker />
        </Deferred>
        {/* While its chunk loads, a plain sheet keeps the waiting app from showing through. */}
        <Suspense fallback={onboarding ? <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'var(--sheet)' }} /> : null}>
          <AnimatePresence>{onboarding && <Onboarding key="onboarding" />}</AnimatePresence>
        </Suspense>
        <Toasts />
      </div>
    </TipProvider>
  );
}

/**
 * The desktop title strip (Windows and Linux): the native minimise / maximise / close buttons are
 * drawn over the page's top-right corner. The app's top-bar actions sit immediately left of them,
 * sized like them, and the native overlay is told the strip's height (window gap plus top bar,
 * scaled by Interface size) so both groups share one row and one centre line. Lengths go to CSS
 * divided by the root zoom, because the root's zoom multiplies them again.
 */
function useTitleStrip(fontScale: number) {
  useEffect(() => {
    if (!desktop) return;
    const root = document.documentElement;
    const sync = () => {
      const controls = windowControlsWidth();
      if (controls === null) {
        delete root.dataset.wco;
        return;
      }
      root.dataset.wco = '';
      root.style.setProperty('--wco-w', `${controls / fontScale}px`);
      root.style.setProperty('--caption-w', `${controls / 3 / fontScale}px`);
      const css = getComputedStyle(root);
      const strip = (parseFloat(css.getPropertyValue('--gap')) + parseFloat(css.getPropertyValue('--topbar-h'))) * fontScale;
      if (strip > 0) desktop?.setTitleBarHeight?.(strip);
    };
    sync();
    return onWindowControlsChange(sync);
  }, [fontScale]);
}

/** How full the context window is; its own subscription so usage ticks re-render only this. */
function ContextMeter({ sessionId }: { sessionId: string }) {
  const used = useStore((s) => s.sessions[sessionId]?.usage.contextTokens);
  const max = useStore((s) => s.sessions[sessionId]?.usage.contextWindow);
  const setUi = useStore((s) => s.setUi);
  if (!used || !max) return null;
  const pct = Math.min(100, (used / max) * 100);
  return (
    <Tip label={`${formatTokens(used)} of ${formatTokens(max)} context used`}>
      <button type="button" className="ctx-meter" onClick={() => setUi({ railOpen: true, railTab: 'context' })} data-warn={pct > 80 || undefined}>
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
          <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.2" />
          <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" pathLength={100} strokeDasharray={`${Math.max(2, pct)} 100`} transform="rotate(-90 10 10)" />
        </svg>
        <span className="num">{Math.round(pct)}%</span>
      </button>
    </Tip>
  );
}

function Topbar() {
  const activeId = useStore((s) => s.ui.activeSessionId);
  const sidebarOpen = useStore((s) => s.ui.sidebarOpen);
  const railOpen = useStore((s) => s.ui.railOpen);
  const setUi = useStore((s) => s.setUi);
  // Shallow: usage ticks while streaming change the session, not what the bar shows (the meter subscribes itself).
  const session = useStore(
    useShallow((s) => {
      const m = activeId ? s.sessions[activeId] : undefined;
      return m ? { id: m.id, provider: m.provider, accountId: m.accountId, title: m.title, cwd: m.cwd, branch: m.branch } : undefined;
    }),
  );
  const accountName = useSessionAccountName(session);

  // The actions' width, so the title stops short of them when they float in the title strip.
  const actions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = actions.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.borderBoxSize?.[0]?.inlineSize ?? el.offsetWidth;
      document.documentElement.style.setProperty('--caption-actions-w', `${Math.ceil(w)}px`);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <header className="topbar">
      <IconButton icon="sidebar" label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} keys="mod+b" onClick={() => setUi({ sidebarOpen: !sidebarOpen })} />
      {!sidebarOpen && (
        <button type="button" className="topbar-home" onClick={() => goHome()} aria-label="New session">
          <LogoMark size={18} />
        </button>
      )}

      {session ? (
        <div className="topbar-title">
          <ProviderMark provider={session.provider} size={15} />
          <span className="truncate topbar-name">{session.title}</span>
          <span className="topbar-crumb truncate">
            <Icon name="folder" size={13} />
            {baseName(session.cwd)}
            {session.branch && (
              <>
                <Icon name="branch" size={13} />
                {session.branch}
              </>
            )}
            {accountName && (
              <>
                <Icon name="user" size={13} />
                {accountName}
              </>
            )}
          </span>
        </div>
      ) : (
        <div className="grow" />
      )}

      <div className="topbar-actions" ref={actions}>
        {session && <ContextMeter sessionId={session.id} />}
        {session && <CapabilitiesButton sessionId={session.id} />}
        <IconButton icon="search" label="Search and commands" keys="mod+k" onClick={() => setUi({ paletteOpen: true })} />
        {session && (
          <IconButton
            icon="sidebar"
            label={railOpen ? 'Hide panel' : 'Show panel'}
            keys="mod+j"
            active={railOpen}
            className="flip-x"
            onClick={() => setUi({ railOpen: !railOpen })}
          />
        )}
      </div>
    </header>
  );
}
