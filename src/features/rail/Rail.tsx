import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Icon, type IconName } from '@/icons';
import { clamp } from '@/lib/format';
import { useStore, type RailTab } from '@/state/store';
import { IconButton, Tip, cx } from '@/ui';
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

/** The side panel: working-tree changes, files, a browser, a command runner, tasks and context for one session. */
export function Rail({ sessionId }: { sessionId: string }) {
  return <RailInner key={sessionId} sessionId={sessionId} />;
}

function RailInner({ sessionId }: { sessionId: string }) {
  const tab = useStore((s) => s.ui.railTab);
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

  const root = useRef<HTMLDivElement>(null);
  const compact = useCompact(root);

  const panes: Record<RailTab, ReactNode> = {
    changes: <ChangesTab sessionId={sessionId} cwd={cwd} />,
    files: <FilesTab sessionId={sessionId} cwd={cwd} />,
    browser: <BrowserTab sessionId={sessionId} active={tab === 'browser'} />,
    terminal: <TerminalTab sessionId={sessionId} cwd={cwd} active={tab === 'terminal'} />,
    tasks: <TasksTab sessionId={sessionId} />,
    context: <ContextTab sessionId={sessionId} active={tab === 'context'} />,
  };

  return (
    <div className="rail" ref={root} data-spot="">
      <ResizeHandle />
      <header className="rail-head">
        <RailTabs sessionId={sessionId} cwd={cwd} tab={tab} compact={compact} onPick={(t) => setUi({ railTab: t })} />
        <IconButton icon="x" label="Close panel" keys="mod+j" size={14} className="rail-close" onClick={() => setUi({ railOpen: false })} />
      </header>
      <div className="rail-body">
        {TABS.map((t) =>
          visited.has(t.id) ? (
            <section key={t.id} className="rail-pane" data-active={t.id === tab || undefined} inert={t.id !== tab} aria-label={t.label} role="tabpanel" id={`rail-pane-${t.id}`}>
              {panes[t.id]}
            </section>
          ) : null,
        )}
      </div>
    </div>
  );
}

type Density = 'full' | 'compact' | 'icons';

/**
 * How much of the tab row fits: every label, the active tab's label only, or icons only
 * (the narrowest panel).
 */
function useCompact(ref: React.RefObject<HTMLElement | null>): Density {
  const [density, setDensity] = useState<Density>('full');
  useEffect(() => {
    // The tab row itself: its width excludes the close button and, in the desktop app, the window controls.
    const el = ref.current?.querySelector<HTMLElement>('.rail-tabs');
    if (!el) return;
    const measure = (w: number) => setDensity(w >= 520 ? 'full' : w >= 300 ? 'compact' : 'icons');
    measure(el.clientWidth);
    const ro = new ResizeObserver(([e]) => measure(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return density;
}

function RailTabs({ sessionId, cwd, tab, compact, onPick }: { sessionId: string; cwd: string; tab: RailTab; compact: Density; onPick: (t: RailTab) => void }) {
  const changes = useChangeCount(sessionId, cwd);
  const tasks = useOpenTaskCount(sessionId);
  const counts: Partial<Record<RailTab, number>> = { changes, tasks };
  const list = useRef<HTMLDivElement>(null);

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
      {TABS.map((t) => {
        const active = t.id === tab;
        const count = counts[t.id];
        const iconOnly = compact === 'icons' || (compact === 'compact' && !active);
        const button = (
            <button
              key={t.id}
              type="button"
              role="tab"
              data-tab={t.id}
              aria-selected={active}
              aria-controls={`rail-pane-${t.id}`}
              aria-label={count ? `${t.label}, ${count}` : t.label}
              tabIndex={active ? 0 : -1}
              className={cx('tab', 'rail-tab')}
              data-on={active || undefined}
              data-icon-only={iconOnly || undefined}
              onClick={() => onPick(t.id)}
            >
              {active && <motion.span layoutId="rail-tab-pill" className="rail-tab-pill dither-sel" transition=
{{ type: 'spring', stiffness: 520, damping: 40 }} />}
              <Icon name={t.icon} size={15} />
              {!iconOnly && <span className="rail-tab-label">{t.label}</span>}
              {!!count && <span className="count num">{count > 999 ? '999+' : count}</span>}
            </button>
        );
        return iconOnly ? (
          <Tip key={t.id} label={t.label}>
            {button}
          </Tip>
        ) : (
          button
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
    const move = (ev: PointerEvent) => {
      w = clamp(startW + (startX - ev.clientX) / z, MIN_W, max);
      applyWidth(w);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
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
