import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { veil } from '@/art/veil';
import { Icon, type IconName } from '@/icons';
import { clamp } from '@/lib/format';
import { reducedMotion } from '@/lib/motion';
import { useStore, type RailTab } from '@/state/store';
import { IconButton, Tip } from '@/ui';
import { AgentsTab, useLiveAgentCount } from './AgentsTab';
import { BrowserTab } from './BrowserTab';
import { ChangesTab, useChangeCount } from './ChangesTab';
import { ContextTab } from './ContextTab';
import { FilesTab } from './FilesTab';
import { useGitAutoRefresh } from './git-state';
import { TasksTab, useOpenTaskCount } from './TasksTab';
import { runCommand } from './term-store';
import { TerminalTab } from './TerminalTab';
import './rail.css';

const TABS: { id: RailTab; label: string; icon: IconName }[] = [
  { id: 'changes', label: 'Changes', icon: 'diff' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'browser', label: 'Browser', icon: 'globe' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'context', label: 'Context', icon: 'context' },
  { id: 'agents', label: 'Agents', icon: 'robot' },
];

const WIDTH_KEY = 'sable.rail.w';
const DEFAULT_W = 396;
const MIN_W = 320;
const MAX_W = 720;

function readWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(v) && v >= MIN_W ? clamp(v, MIN_W, MAX_W) : null;
  } catch {
    return null;
  }
}

function applyWidth(w: number | null) {
  const app = document.querySelector<HTMLElement>('.app');
  if (!app) return;
  if (w === null) app.style.removeProperty('--rail-w');
  else app.style.setProperty('--rail-w', `${Math.round(w)}px`);
}

/** The side panel: working-tree changes, files, a browser, a command runner, tasks, context and sub-agents for one session. */
export function Rail({ sessionId }: { sessionId: string }) {
  return <RailInner key={sessionId} sessionId={sessionId} />;
}

/** The session whose panel was last on screen, and when it left: tells a change of session from the panel opening. */
const lastPanel = { sessionId: '', leftAt: -1e9 };

function RailInner({ sessionId }: { sessionId: string }) {
  const tab = useStore((s) => s.ui.railTab);
  const body = useRef<HTMLDivElement>(null);
  // Another session's panel took this one's place in the same frame: its contents resolve out of
  // the ground, in step with the conversation beside it (the panel's frame and tabs stay put).
  useLayoutEffect(() => {
    if (lastPanel.sessionId && lastPanel.sessionId !== sessionId && performance.now() - lastPanel.leftAt < 80 && !reducedMotion()) {
      void veil(body.current, 'reveal', { duration: 300 });
    }
    return () => {
      lastPanel.sessionId = sessionId;
      lastPanel.leftAt = performance.now();
    };
  }, [sessionId]);
  const cwd = useStore((s) => s.sessions[sessionId]?.cwd ?? '');
  const setUi = useStore((s) => s.setUi);
  const [visited, setVisited] = useState<ReadonlySet<RailTab>>(() => new Set([tab]));

  useEffect(() => {
    setVisited((v) => (v.has(tab) ? v : new Set([...v, tab])));
  }, [tab]);

  useGitAutoRefresh(sessionId, cwd);
  usePendingCommand(sessionId, cwd);

  // Another part of the app asked to show a file: bring the Files tab forward.
  const railFile = useStore((s) => s.ui.railFile);
  const lastFile = useRef(railFile);
  useEffect(() => {
    if (railFile && railFile !== lastFile.current && useStore.getState().ui.railTab !== 'files') setUi({ railTab: 'files' });
    lastFile.current = railFile;
  }, [railFile, setUi]);

  const panes: Record<RailTab, ReactNode> = {
    changes: <ChangesTab sessionId={sessionId} cwd={cwd} />,
    files: <FilesTab sessionId={sessionId} cwd={cwd} />,
    browser: <BrowserTab sessionId={sessionId} active={tab === 'browser'} />,
    terminal: <TerminalTab sessionId={sessionId} cwd={cwd} active={tab === 'terminal'} />,
    tasks: <TasksTab sessionId={sessionId} />,
    context: <ContextTab sessionId={sessionId} active={tab === 'context'} />,
    agents: <AgentsTab sessionId={sessionId} />,
  };
  const at = TABS.findIndex((t) => t.id === tab);
  // Which way the selection last travelled along the tab row: the arriving pane comes from that side.
  const [nav, setNav] = useState({ at, dir: 'fwd' });
  if (nav.at !== at) setNav({ at, dir: at < nav.at ? 'back' : 'fwd' });

  return (
    <div className="rail" data-spot="">
      <ResizeHandle />
      <header className="rail-head">
        <RailTabs sessionId={sessionId} cwd={cwd} tab={tab} onPick={(t) => setUi({ railTab: t })} />
        <IconButton icon="x" label="Close panel" keys="mod+j" className="rail-close" onClick={() => setUi({ railOpen: false })} />
      </header>
      <div className="rail-body" ref={body} data-dir={nav.dir}>
        {TABS.map((t, i) =>
          visited.has(t.id) ? (
            <section key={t.id} className="rail-pane" data-active={t.id === tab || undefined} data-side={i < at ? 'before' : undefined} inert={t.id !== tab} aria-label={t.label} role="tabpanel" id={`rail-pane-${t.id}`}>
              {panes[t.id]}
            </section>
          ) : null,
        )}
      </div>
    </div>
  );
}

/** The tab row's width, observed (it excludes the close button and, in the desktop app, the window controls). */
function useRowWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;

/** A label's width in the tab's own font, without touching layout. */
function textWidth(text: string, el: HTMLElement | null): number {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx || !el) return text.length * 7.5;
  const cs = getComputedStyle(el);
  measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return measureCtx.measureText(text).width;
}

/** Fixed parts of the row: the tabs at 28 px, 2 px apart; a name adds its text and 9 px; a count (two figures) about 20 px. */
const TAB = 28;
const TAB_GAP = 2;
const COUNT_ROOM = 20;

/** The selected tab's name opens and closes with the same spring as the panel itself. */
const LABEL_SPRING = { type: 'spring', stiffness: 520, damping: 40, mass: 0.7 } as const;

function RailTabs({ sessionId, cwd, tab, onPick }: { sessionId: string; cwd: string; tab: RailTab; onPick: (t: RailTab) => void }) {
  const changes = useChangeCount(sessionId, cwd);
  const tasks = useOpenTaskCount(sessionId);
  // Agents: how many are working now.
  const agents = useLiveAgentCount(sessionId);
  const counts: Partial<Record<RailTab, number>> = { changes, tasks, agents };
  const list = useRef<HTMLDivElement>(null);
  const width = useRowWidth(list);
  // The selected tab shows its name only when the row fits the longest name and two-figure counts, so
  // the decision never flips while counts load or from one tab to the next; otherwise the row is icons only.
  const font = list.current?.querySelector<HTMLElement>('.rail-tab') ?? null;
  const longest = width > 0 ? Math.max(...TABS.map((t) => textWidth(t.label, font))) : 0;
  const need = TABS.length * TAB + (TABS.length - 1) * TAB_GAP + 3 * COUNT_ROOM + Math.ceil(longest) + 9;
  const labels = width > 0 && width >= need;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    onPick(TABS[next].id);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-tab="${TABS[next].id}"]`)?.focus());
  };

  return (
    <div className="tabs rail-tabs" role="tablist" aria-label="Panel" ref={list} onKeyDown={onKey}>
      {TABS.map((t, i) => {
        const active = t.id === tab;
        const count = counts[t.id];
        return (
          <Tip key={t.id} label={t.label} keys={`alt+${i + 1}`}>
            <button
              type="button"
              role="tab"
              data-tab={t.id}
              aria-selected={active}
              aria-controls={`rail-pane-${t.id}`}
              aria-label={count ? `${t.label}, ${count}` : t.label}
              tabIndex={active ? 0 : -1}
              className="rail-tab"
              data-on={active || undefined}
              data-count={count ? '' : undefined}
              onClick={() => onPick(t.id)}
            >
              <span className="rail-tab-pill dither-sel" aria-hidden />
              <Icon name={t.icon} size={16} />
              <AnimatePresence initial={false}>
                {active && labels && (
                  <motion.span
                    key="label"
                    className="rail-tab-label"
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: 'auto', opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={LABEL_SPRING}
                  >
                    <span>{t.label}</span>
                  </motion.span>
                )}
              </AnimatePresence>
              {!!count && <span className="rail-tab-count num">{count > 999 ? '999+' : count}</span>}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/** Drag the panel's left edge to resize it (320 to 720 px); double-click restores the default. */
function ResizeHandle() {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    applyWidth(readWidth());
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const rail = el.closest('.app-rail') as HTMLElement | null;
    // Pointer and box positions are screen pixels; widths are CSS pixels under the Interface size zoom.
    const z = parseFloat(document.documentElement.style.zoom) || 1;
    const startW = rail ? rail.getBoundingClientRect().width / z : DEFAULT_W;
    const startX = e.clientX;
    const max = Math.max(MIN_W, Math.min(MAX_W, window.innerWidth / z - 600));
    let w = startW;
    setDragging(true);
    document.documentElement.dataset.railResizing = '';
    // While dragging, the two boxes that use the width get it inline: --rail-w lives on .app and is
    // inherited, so changing it every move would restyle the whole window (thousands of elements).
    // It is written once, on release.
    const inner = rail?.querySelector<HTMLElement>(':scope > .app-rail-inner') ?? null;
    const railWas = rail?.style.width ?? '';
    const move = (ev: PointerEvent) => {
      w = clamp(startW + (startX - ev.clientX) / z, MIN_W, max);
      const px = `${Math.round(w)}px`;
      if (rail) rail.style.width = px;
      if (inner) inner.style.width = px;
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      applyWidth(w);
      if (rail) rail.style.width = railWas;
      inner?.style.removeProperty('width');
      delete document.documentElement.dataset.railResizing;
      setDragging(false);
      try {
        localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
      } catch {
        /* private mode */
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = readWidth() ?? DEFAULT_W;
    const w = clamp(cur + (e.key === 'ArrowLeft' ? 24 : -24), MIN_W, MAX_W);
    applyWidth(w);
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* private mode */
    }
  };

  const reset = () => {
    applyWidth(null);
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {
      /* private mode */
    }
  };

  return (
    <div
      className="rail-resize"
      data-dragging={dragging || undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
      onKeyDown={onKey}
    />
  );
}

/** Runs a command the composer handed over ("!cmd"), once, in this session's folder. */
const consumed = new Set<number>();

function usePendingCommand(sessionId: string, cwd: string) {
  const pending = useStore((s) => s.ui.pendingCommand);
  useEffect(() => {
    if (!pending || pending.sessionId !== sessionId || !cwd) return;
    const st = useStore.getState();
    st.setUi({ pendingCommand: null, ...(st.ui.railTab !== 'terminal' ? { railTab: 'terminal' as const } : {}) });
    if (consumed.has(pending.id)) return;
    consumed.add(pending.id);
    runCommand(sessionId, cwd, pending.command);
  }, [pending, sessionId, cwd]);
}
