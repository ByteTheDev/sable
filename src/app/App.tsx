import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AnimatePresence, motion, type Variants } from 'motion/react';
import { INTRO_DELAY, INTRO_MIN, LogoIntro, LogoMark, ProviderMark } from '@/art/Logo';
import { veil, VEIL_SWAP, VEIL_SWAP_AT } from '@/art/veil';
import { reducedMotion, uiZoom } from '@/lib/motion';
import { Home } from '@/features/home/Home';
import { handoffActive } from '@/features/home/handoff';
import { useOnboarding } from '@/features/onboarding/useOnboarding';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { Icon } from '@/icons';
import { windowShell } from '@/lib/desktop';
import { baseName, formatTokens } from '@/lib/format';
import { goHome, openSettings } from '@/state/actions';
import { useActiveProvider, useHotkey } from '@/state/hooks';
import { SessionAccount } from '@/features/accounts';
import { useShallow } from 'zustand/react/shallow';
import { useStore, type RailTab } from '@/state/store';
import { IconButton, Tip, TipProvider, Toasts } from '@/ui';
import { CapabilitiesButton } from './Capabilities';
import { loadSessionView } from './views';
import { WindowControls } from './WindowControls';
import './app.css';

/** The side panel's tabs in the order of their shortcuts (Alt+1 to Alt+6), as the panel lists them. */
const RAIL_TAB_ORDER: RailTab[] = ['changes', 'files', 'browser', 'terminal', 'tasks', 'context'];

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
const SessionView = lazy(() => loadSessionView().then((m) => ({ default: m.SessionView })));
const SessionDock = lazy(() => loadSessionView().then((m) => ({ default: m.SessionDock })));
const SessionLight = lazy(() => loadSessionView().then((m) => ({ default: m.SessionLight })));
const Onboarding = lazy(() => import('@/features/onboarding/Onboarding').then((m) => ({ default: m.Onboarding })));

/**
 * A window too narrow for three columns (about 1060 CSS px) keeps two: while the side panel is open there,
 * the sidebar steps aside without forgetting that it was open, and comes back when the panel closes.
 * Showing it again from the top bar closes the panel instead.
 */
const NARROW_PX = 1060;
/** Narrower than three columns need, in CSS pixels (the Interface size zooms the page). */
const isNarrow = () => window.innerWidth / (useStore.getState().settings.fontScale || 1) < NARROW_PX;
function useNarrow(): boolean {
  const zoom = useStore((s) => s.settings.fontScale);
  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    const on = () => setNarrow(isNarrow());
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [zoom]);
  return narrow;
}

/** Whether the sidebar is shown: open, and not stepped aside for the panel in a narrow window. */
export function useSidebarShown(): boolean {
  const open = useStore((s) => s.ui.sidebarOpen);
  const squeezed = useStore((s) => s.ui.railOpen && !!s.ui.activeSessionId && !!s.sessions[s.ui.activeSessionId]);
  const narrow = useNarrow();
  return open && !(narrow && squeezed);
}

/** Mounts a lazy surface the first time it is asked for, then keeps it (so its exit animations run). */
function Deferred({ when, children }: { when: boolean; children: ReactNode }) {
  const [seen, setSeen] = useState(when);
  if (when && !seen) setSeen(true);
  return seen ? <Suspense fallback={null}>{children}</Suspense> : null;
}

/**
 * How the stage changes views:
 * - `swap` (session to session, session to home, home to a session from the list): the old view
 *   dissolves into the ground through the dither veil, the new one resolves out of it and rises a
 *   few pixels. The views only change opacity and transform: nothing is laid out again meanwhile.
 * - `handoff` (the first message sent from home): the composer flies to the dock (handoff.ts), the
 *   conversation fades in around it, and the home field lingers just long enough for the send's
 *   wave to cross it.
 * - `enter` (the first view after the launch intro): no fade here; Home composes its own arrival.
 * - `fade` (reduced motion, in place of a swap): a short crossfade, nothing moves.
 */
type ViewMode = 'swap' | 'handoff' | 'enter' | 'fade';
const EASE = [0.16, 1, 0.3, 1] as const;
/** When the veil is solid: the old view goes and the new one appears under it, in one frame. */
const SWAP_AT = (VEIL_SWAP / 1000) * VEIL_SWAP_AT;
const VIEW: Variants = {
  initial: (m: ViewMode) => (m === 'swap' ? { opacity: 0, y: 8 } : m === 'handoff' || m === 'fade' ? { opacity: 0 } : { opacity: 1 }),
  animate: (m: ViewMode) =>
    m === 'fade'
      ? { opacity: 1, y: 0, transition: { duration: 0.14 } }
      : m === 'swap'
      ? { opacity: 1, y: 0, transition: { opacity: { duration: 0.001, delay: SWAP_AT }, y: { duration: 0.36, delay: SWAP_AT, ease: EASE } } }
      : m === 'handoff'
        ? { opacity: 1, y: 0, transition: { duration: 0.32, delay: 0.08, ease: EASE } }
        : { opacity: 1, y: 0, transition: { duration: 0 } },
  exit: (m: ViewMode) =>
    m === 'fade'
      ? { opacity: 0, transition: { duration: 0.14 } }
      : m === 'swap'
      ? { opacity: 0, transition: { duration: 0.001, delay: SWAP_AT } }
      : m === 'handoff'
        ? // Holds while the wave from the send key crosses the field, then lets go.
          { opacity: 0, transition: { duration: 0.64, ease: [0.45, 0, 0.7, 0.45] } }
        : { opacity: 0, transition: { duration: 0.16 } },
};

/** Which kind of change the stage is making (read while rendering the change, see ViewMode). */
function useViewMode(key: string | null, body: RefObject<HTMLElement | null>): ViewMode {
  const last = useRef(key);
  const mode = useRef<ViewMode>('enter');
  if (last.current !== key) mode.current = last.current == null ? 'enter' : handoffActive() ? 'handoff' : reducedMotion() ? 'fade' : 'swap';
  // Before paint: the veil's first frame lands in the same frame as the new view.
  useLayoutEffect(() => {
    if (last.current === key) return;
    const was = last.current;
    last.current = key;
    if (was != null && key != null && mode.current === 'swap') {
      // Session to session: the dock stays above the veil, so only the conversation dissolves.
      const el = body.current;
      if (el && was !== 'home' && key !== 'home') {
        el.setAttribute('data-session-swap', '');
        window.setTimeout(() => el.removeAttribute('data-session-swap'), VEIL_SWAP + 40);
      }
      void veil(el, 'swap');
    }
  }, [key, body]);
  return mode.current;
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
  const sidebarOpen = useSidebarShown();
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
  const stageBody = useRef<HTMLDivElement>(null);
  const viewKey = booting || onboarding ? null : (sessionId ?? 'home');
  const viewMode = useViewMode(viewKey, stageBody);
  const railShown = railOpen && !!sessionId;
  useRailMotion(railShown);

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

  const paletteOpen = useStore((s) => s.ui.paletteOpen);
  const historyOpen = useStore((s) => s.ui.historyOpen);
  const settingsOpen = useStore((s) => s.ui.settings !== null);
  const pickerOpen = useStore((s) => s.ui.projectPicker);

  // Warm the on-demand chunks once the app is idle, so the first open is instant. The session view
  // first and soon (a send from home needs it), the rest when the window has nothing else to do.
  useEffect(() => {
    if (!ready) return;
    const t = window.setTimeout(() => void loadSessionView().catch(() => {}), 600);
    const warm = () => void Promise.all([loadPalette(), loadRail(), loadSettings(), loadHistory(), loadPicker()]).catch(() => {});
    const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(warm, { timeout: 4000 });
    else window.setTimeout(warm, 1500);
    return () => window.clearTimeout(t);
  }, [ready]);

  useHotkey('mod+k', useCallback((e) => (e.preventDefault(), setUi({ paletteOpen: !useStore.getState().ui.paletteOpen })), [setUi]));
  useHotkey('mod+b', useCallback((e) => (e.preventDefault(), toggleSidebar(sidebarOpen)), [sidebarOpen]));
  useHotkey('mod+j', useCallback((e) => (e.preventDefault(), setUi({ railOpen: !useStore.getState().ui.railOpen })), [setUi]));
  useHotkey('mod+,', useCallback((e) => (e.preventDefault(), openSettings()), []));
  useHotkey('mod+shift+o', useCallback((e) => (e.preventDefault(), goHome()), []));
  useHotkey('mod+o', useCallback((e) => (e.preventDefault(), setUi({ projectPicker: true })), [setUi]));
  // Alt+1 to Alt+6: the side panel's tabs, in order (opens the panel when it is closed).
  useEffect(() => {
    if (!sessionId) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const tab = RAIL_TAB_ORDER[Number(e.code.replace('Digit', '')) - 1];
      if (!/^Digit[1-6]$/.test(e.code) || !tab) return;
      e.preventDefault();
      setUi({ railOpen: true, railTab: tab });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionId, setUi]);

  return (
    <TipProvider>
      <div className="app" data-provider={provider} data-sidebar={sidebarOpen}>
        <aside className="app-side" aria-hidden={!sidebarOpen || onboarding} inert={onboarding}>
          <Sidebar />
        </aside>

        <main className="stage" inert={onboarding}>
          <Topbar />
          <div className="stage-body" ref={stageBody}>
            <AnimatePresence>{booting && <LogoIntro key="intro" ready={ready} />}</AnimatePresence>
            {/* The session's band of light, one field for every session (like the dock): a switch
                changes its colour and pace, it is never built again. Under the conversation. */}
            <AnimatePresence initial={false} custom={viewMode}>
              {viewKey != null && sessionId && (
                <motion.div key="light" className="stage-view stage-light" custom={viewMode} variants={VIEW} initial="initial" animate="animate" exit="exit">
                  <Suspense fallback={null}>
                    <SessionLight sessionId={sessionId} />
                  </Suspense>
                </motion.div>
              )}
            </AnimatePresence>
            {/* After a send from home the conversation fades in around the docked composer, which must not move. */}
            <AnimatePresence mode="popLayout" initial={false} custom={viewMode}>
              {viewKey == null ? null : (
                <motion.div key={viewKey} className="stage-view" custom={viewMode} variants={VIEW} initial="initial" animate="animate" exit="exit">
                  {sessionId ? (
                    <Suspense fallback={null}>
                      <SessionView sessionId={sessionId} />
                    </Suspense>
                  ) : (
                    <Home />
                  )}
                </motion.div>
              )}
            </AnimatePresence>
            {/* The dock outlives a change of session (one key for all of them): only its contents follow.
                Coming from or going to home it arrives and leaves with the view. */}
            <AnimatePresence initial={false} custom={viewMode}>
              {viewKey != null && sessionId && (
                <motion.div key="dock" className="stage-dock" custom={viewMode} variants={VIEW} initial="initial" animate="animate" exit="exit">
                  <Suspense fallback={null}>
                    <SessionDock sessionId={sessionId} />
                  </Suspense>
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

        <AnimatePresence initial={false} onExitComplete={releaseRail}>
          {railShown && (
            <motion.aside
              key="rail"
              className="app-rail"
              // The panel's contents resolve through the dither veil (and dissolve into it on close),
              // so only reduced motion fades them.
              initial={{ width: 0, opacity: reducedMotion() ? 0 : 1 }}
              animate={{ width: 'var(--rail-fit)', opacity: 1 }}
              exit={{ width: 0, opacity: reducedMotion() ? 0 : 1 }}
              transition={{ type: 'spring', stiffness: 380, damping: 38 }}
              onUpdate={onRailFrame}
              onAnimationComplete={releaseRail}
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
      {/* Outside .app (an isolated stacking context) so the controls stay above dialogs and the welcome. */}
      <WindowControls />
    </TipProvider>
  );
}

/**
 * Opening and closing the side panel. The panel's width springs; the stage beside it narrows or
 * widens with it, but the view inside the stage keeps one width meanwhile (the narrower of the
 * two, through the sidebar's freeze rule in app.css) and is slid each frame so its centre column
 * glides exactly where the resizing stage puts it: the conversation is laid out once, not once
 * per frame. The panel's contents resolve through the
 * dither veil on open and dissolve into it on close.
 */
const railMotion = { body: null as HTMLElement | null, total: 0, wide: 0, timer: 0 };

function releaseRail() {
  const m = railMotion;
  window.clearTimeout(m.timer);
  if (!m.body) return;
  delete m.body.dataset.freeze;
  m.body.style.removeProperty('--freeze-w');
  for (const v of m.body.querySelectorAll<HTMLElement>(':scope > .stage-view')) v.style.removeProperty('translate');
  m.body = null;
}

function freezeForRail(opening: boolean) {
  releaseRail();
  if (reducedMotion()) return;
  // A narrow window trades the sidebar for the panel at the same time: the stage moves at both edges.
  if (isNarrow() && useStore.getState().ui.sidebarOpen) return;
  const body = document.querySelector<HTMLElement>('.stage > .stage-body');
  const app = document.querySelector<HTMLElement>('.app');
  if (!body || !app || body.dataset.freeze != null) return;
  const z = uiZoom();
  const now = (document.querySelector('.app-rail')?.getBoundingClientRect().width ?? 0) / z;
  // The panel's width as it will be drawn (--rail-fit: the chosen width, narrowed to what the window allows).
  const target = opening ? (document.querySelector<HTMLElement>('.app-rail-inner')?.offsetWidth ?? 396) : 0;
  const b0 = body.clientWidth;
  const b1 = b0 + now - target;
  if (!(b1 > 0)) return;
  railMotion.body = body;
  railMotion.total = b0 + now;
  // The narrower of the two: the conversation takes its narrow layout once (at the start when the
  // panel opens, at the end when it closes) and is never clipped by the moving edge.
  railMotion.wide = Math.min(b0, b1);
  body.style.setProperty('--freeze-w', `${railMotion.wide}px`);
  body.dataset.freeze = 'rail';
  // Placed for the first frame already (the spring reports its first value a frame later).
  for (const v of body.querySelectorAll<HTMLElement>(':scope > .stage-view')) v.style.translate = `${((railMotion.wide - b0) / 2).toFixed(2)}px 0`;
  railMotion.timer = window.setTimeout(releaseRail, 1200);
  // Contents: resolve on open (after the panel has mounted), dissolve on close.
  const inner = document.querySelector<HTMLElement>('.app-rail-inner');
  if (inner) void veil(inner, opening ? 'reveal' : 'cover', { duration: opening ? 320 : 150 });
}

/** Per frame of the panel's spring: the frozen view slides to where the stage's centre is now. */
function followRail(latest: { width?: unknown }) {
  const m = railMotion;
  if (!m.body) return;
  const w = typeof latest.width === 'number' ? latest.width : typeof latest.width === 'string' && latest.width.endsWith('px') ? parseFloat(latest.width) : NaN;
  if (!Number.isFinite(w)) return;
  const tx = (m.wide - (m.total - w)) / 2;
  for (const v of m.body.querySelectorAll<HTMLElement>(':scope > .stage-view')) v.style.translate = `${tx.toFixed(2)}px 0`;
}

function onRailFrame(latest: { width?: unknown }) {
  trackRailWidth?.(latest);
  followRail(latest);
}

function useRailMotion(shown: boolean) {
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    freezeForRail(shown);
  }, [shown]);
  useEffect(() => releaseRail, []);
}

/**
 * While the panel opens or closes, the stage's top bar hands the room kept for the window controls
 * over to the panel frame by frame (--rail-live, app.css), so its actions never pass under them.
 * Set on the top bar alone: a custom property on .app would restyle the whole tree every frame.
 */
const trackRailWidth = windowShell
  ? (latest: { width?: unknown }) => {
      const bar = document.querySelector<HTMLElement>('.stage > .topbar');
      if (!bar) return;
      const w = latest.width;
      bar.style.setProperty('--rail-live', typeof w === 'number' ? `${w}px` : typeof w === 'string' && w.endsWith('px') ? w : '999px');
    }
  : undefined;

/** How full the context window is; its own subscription so usage ticks re-render only this. */
function ContextMeter({ sessionId }: { sessionId: string }) {
  // Only what the meter shows: a usage tick that changes neither the label nor the percentage renders nothing.
  const shown = useStore((s) => {
    const u = s.sessions[sessionId]?.usage;
    if (!u?.contextTokens || !u.contextWindow) return '';
    return `${Math.min(100, Math.round((u.contextTokens / u.contextWindow) * 1000) / 10)}|${formatTokens(u.contextTokens)}|${formatTokens(u.contextWindow)}`;
  });
  const setUi = useStore((s) => s.setUi);
  if (!shown) return null;
  const [p, used, max] = shown.split('|');
  const pct = Number(p);
  // A ring drawn on the icons' 16 px grid: a hairline track and a 1.5 px arc, so it weighs what the line icons beside it weigh.
  return (
    <Tip label={`${used} of ${max} context used`}>
      <button type="button" className="ctx-meter" onClick={() => setUi({ railOpen: true, railTab: 'context' })} data-warn={pct > 80 || undefined} aria-label={`Context ${Math.round(pct)}% used`}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1" />
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" pathLength={100} strokeDasharray={`${Math.max(1.5, pct)} 100`} transform="rotate(-90 8 8)" />
        </svg>
        <span className="num">{Math.round(pct)}%</span>
      </button>
    </Tip>
  );
}

/** Shows or hides the sidebar as it is drawn now: one stepped aside for the panel comes back by closing the panel. */
function toggleSidebar(shown: boolean) {
  const { ui, setUi } = useStore.getState();
  if (shown) setUi({ sidebarOpen: false });
  else if (ui.sidebarOpen) setUi({ railOpen: false });
  else setUi({ sidebarOpen: true });
}

function Topbar() {
  const activeId = useStore((s) => s.ui.activeSessionId);
  const sidebarOpen = useSidebarShown();
  const railOpen = useStore((s) => s.ui.railOpen);
  const setUi = useStore((s) => s.setUi);
  // Shallow: usage ticks while streaming change the session, not what the bar shows (the meter subscribes itself).
  const session = useStore(
    useShallow((s) => {
      const m = activeId ? s.sessions[activeId] : undefined;
      return m ? { id: m.id, provider: m.provider, accountId: m.accountId, title: m.title, cwd: m.cwd, branch: m.branch } : undefined;
    }),
  );
  return (
    <header className="topbar">
      <IconButton icon="sidebar" label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} keys="mod+b" onClick={() => toggleSidebar(sidebarOpen)} />
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
            {/* The account, when its agent has several: opens "Continue with another account". */}
            <SessionAccount sessionId={session.id} />
          </span>
        </div>
      ) : (
        <div className="grow" />
      )}

      <div className="topbar-actions">
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
