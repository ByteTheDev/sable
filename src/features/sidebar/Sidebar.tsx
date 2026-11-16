import { memo, useCallback, useEffect, useMemo, useState, type ComponentType, type FocusEvent, type HTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { ContextMenu as RC, DropdownMenu as RM } from 'radix-ui';
import type { ProviderId, SessionMeta } from '@shared/protocol';
import { LogoMark, StatusGlyph, Wordmark } from '@/art/Logo';
import { Icon } from '@/icons';
import { QuickSwitch } from '@/features/session/QuickSwitch';
import { dissolve } from '@/lib/dissolve';
import { reducedMotion } from '@/lib/motion';
import { closeSession, goHome, pinProject, removeProject } from '@/state/actions';
import { useStore } from '@/state/store';
import { IconButton, Modal, Tip } from '@/ui';
import { Flip } from './flip';
import { SideResize } from './Resize';
import { createGroupsSelector, idsOf, loadCollapsed, pathKey, saveCollapsed, type Mix, type ProjectGroup } from './groups';
import { RowContextMenu, SessionRow, SidebarRowContext, setRenaming, type RowCtx } from './SessionRow';
import { SidebarFooter } from './SidebarFooter';
import './sidebar.css';

const EASE = [0.16, 1, 0.3, 1] as const;

/** Memoized whole: the app shell re-renders on navigation, the sidebar parts subscribe to what they show. */
export const Sidebar = memo(function Sidebar() {
  const [deleting, setDeleting] = useState<string | null>(null);
  const ctx = useMemo<RowCtx>(() => ({ setRenaming, askDelete: setDeleting }), []);
  useStageFreeze();

  return (
    <nav className="side" aria-label="Sessions">
      <SidebarTop />
      <SidebarRowContext.Provider value={ctx}>
        {/* The shared row menu wraps the list from outside, so list renders do not re-render the menu. */}
        <RowContextMenu>
          <SidebarList />
        </RowContextMenu>
      </SidebarRowContext.Provider>
      <SidebarFooter />
      <DeleteDialog id={deleting} onClose={() => setDeleting(null)} />
      <SideResize />
      {/* Ctrl+Tab between recent sessions: mounted here because the sidebar is always there. */}
      <QuickSwitch />
    </nav>
  );
});

/** The brand, then one row: a new session, search and history. Nothing here depends on sessions. */
const SidebarTop = memo(function SidebarTop() {
  const setUi = useStore((s) => s.setUi);
  return (
    <div className="side-top">
      <div className="side-brand">
        <button type="button" className="brand" onClick={() => goHome()} aria-label="Sable home">
          <LogoMark size={20} />
          <Wordmark />
        </button>
      </div>
      <div className="side-actions">
        <Tip label="New session" keys="mod+shift+o">
          <button type="button" className="side-new" onClick={() => goHome()}>
            <span className="side-new-icon">
              <Icon name="plus" size={15} />
            </span>
            <span className="truncate">New session</span>
          </button>
        </Tip>
        <IconButton icon="search" label="Search and commands" keys="mod+k" className="side-tool" onClick={() => setUi({ paletteOpen: true })} />
        <IconButton icon="history" label="History" className="side-tool" onClick={() => setUi({ historyOpen: true })} />
      </div>
    </div>
  );
});

const selectGroups = createGroupsSelector();

/** Props and ref come from the context menu trigger wrapping it. */
function SidebarList(props: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  const groups = useStore(selectGroups);
  const ready = useStore((s) => s.ready);
  // The open session's folder, not its id: switching sessions within a folder does not re-render the list.
  const activeKey = useStore(selectActiveKey);
  const setUi = useStore((s) => s.setUi);
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  const toggle = useCallback((key: string, open?: boolean) => {
    setCollapsed((prev) => {
      if (open !== undefined && prev.has(key) !== open) return prev;
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  }, []);

  // Opening a session that sits in a collapsed folder unfolds that folder (also when the folder was
  // collapsed after an earlier session in it was opened, hence the subscription to the id).
  useEffect(() => {
    const unfold = (key: string | null) => {
      if (!key) return;
      setCollapsed((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        saveCollapsed(next);
        return next;
      });
    };
    unfold(selectActiveKey(useStore.getState()));
    return useStore.subscribe((s, p) => {
      if (s.ui.activeSessionId !== p.ui.activeSessionId) unfold(selectActiveKey(s));
    });
  }, []);

  const empty = ready && !groups.pinned.length && !groups.projects.length;
  // Any change of membership, not only of folder order: a folder that grows or shrinks moves the ones below it.
  const order = `pinned:${idsOf(groups.pinned)}` + groups.projects.map((g) => `\n${g.key}:${idsOf(g.sessions)}:${g.archived.length}`).join('');

  return (
    <div {...props} className="side-list scroll" tabIndex={0} aria-label="Sessions list" onKeyDown={onListKey} onFocus={onListFocus} onBlur={onListBlur} onScroll={onListScroll}>
      {!ready ? (
        <SkeletonRows />
      ) : empty ? (
        <div className="side-empty">
          <p>Open a folder to start your first session.</p>
          <button type="button" className="btn btn-sm" onClick={() => setUi({ projectPicker: true })}>
            <Icon name="folder-plus" size={14} />
            Open a folder
          </button>
        </div>
      ) : (
        <MotionConfig reducedMotion="user">
          <div className="side-shield" aria-hidden />
          <Flip order={order} className="side-rows">
            {groups.pinned.length > 0 && (
              <section className="sgroup" data-flip="pinned" aria-label="Pinned">
                <div className="sgroup-head sgroup-head-static">
                  <span className="sgroup-icon">
                    <Icon name="pin" size={15} />
                  </span>
                  <span className="sgroup-name">Pinned</span>
                </div>
                <SessionList ids={idsOf(groups.pinned)} mix={groups.pinnedMix} major={groups.pinnedMajor} />
              </section>
            )}
            {groups.projects.map((g) => (
              <ProjectSection key={g.key} group={g} collapsed={collapsed.has(g.key)} onToggle={toggle} current={activeKey === g.key} />
            ))}
          </Flip>
        </MotionConfig>
      )}
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="side-skel" aria-hidden>
      {[62, 78, 54, 70, 46].map((w, i) => (
        <span key={i} className="side-skel-row">
          <span className="skel" style={{ width: `${w}%` }} />
        </span>
      ))}
    </div>
  );
}

function DeleteDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const title = useStore((s) => (id ? s.sessions[id]?.title : undefined));
  return (
    <Modal
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      title="Delete this session?"
      width={400}
      description={
        <>
          <span className="del-title">{title}</span> will be removed from Sable. The provider keeps its own transcript.
        </>
      }
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            autoFocus
            onClick={() => {
              onClose();
              if (id) removeRow(id);
            }}
          >
            <Icon name="trash" size={14} />
            Delete
          </button>
        </>
      }
    >
      {null}
    </Modal>
  );
}

/** The row breaks into dither cells where it stood; its neighbours close the gap as it goes. */
function removeRow(id: string) {
  const row = document.querySelector<HTMLElement>(`.srow[data-row="${CSS.escape(id)}"]`);
  // The next row takes the keyboard focus the deleted one had.
  const focusNext = row?.contains(document.activeElement) || document.activeElement === document.body;
  const next = row && (row.nextElementSibling ?? row.previousElementSibling)?.querySelector<HTMLElement>('.srow-main');
  dissolve(row);
  if (row) {
    row.style.visibility = 'hidden';
    // Should the bridge refuse, the row comes back.
    window.setTimeout(() => row.isConnected && (row.style.visibility = ''), 2500);
  }
  void closeSession(id, true);
  if (focusNext && next) requestAnimationFrame(() => next.focus());
}

function selectActiveKey(s: { ui: { activeSessionId: string | null }; sessions: Record<string, SessionMeta> }): string | null {
  const a = s.ui.activeSessionId ? s.sessions[s.ui.activeSessionId] : undefined;
  return a && !a.pinned ? pathKey(a.cwd) : null;
}

/** Rows by id (a space-joined string, so the list re-renders only when membership or order changes). */
const SessionList = memo(function SessionList({ ids, mix, major }: { ids: string; mix: Mix; major?: ProviderId }) {
  // Rows that arrive after the first paint animate in; the first paint does not.
  const [drawnAt] = useState(() => performance.now());
  const enter = performance.now() - drawnAt > 400;
  return (
    <Flip order={ids} className="srows" role="list">
      {ids ? ids.split(' ').map((id) => <SessionRow key={id} id={id} enter={enter} mix={mix} major={major} />) : null}
    </Flip>
  );
});

interface SectionProps {
  group: ProjectGroup;
  collapsed: boolean;
  onToggle: (key: string, open?: boolean) => void;
  /** Holds the open session. */
  current: boolean;
}

/** Re-render a project only for what its header and lists show; rows update themselves. */
const sameGroup = (a: ProjectGroup, b: ProjectGroup) =>
  a === b ||
  (a.key === b.key &&
    a.name === b.name &&
    a.path === b.path &&
    a.pinned === b.pinned &&
    a.mix === b.mix &&
    a.major === b.major &&
    a.attention === b.attention &&
    idsOf(a.sessions) === idsOf(b.sessions) &&
    idsOf(a.archived) === idsOf(b.archived));
const sameSection = (a: SectionProps, b: SectionProps) => a.collapsed === b.collapsed && a.onToggle === b.onToggle && a.current === b.current && sameGroup(a.group, b.group);

const ProjectSection = memo(function ProjectSection({ group, collapsed, onToggle, current }: SectionProps) {
  const [showArchived, setShowArchived] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const hasSessions = group.sessions.length > 0 || group.archived.length > 0;
  const open = hasSessions && !collapsed;
  const ids = idsOf(group.sessions);

  return (
    <section className="sgroup" data-flip={group.key} aria-label={group.name}>
      <RC.Root>
        <RC.Trigger asChild>
          <div className="sgroup-head" data-collapsed={!open || undefined} data-current={current || undefined} data-menu={menuOpen || undefined}>
            <button
              type="button"
              className="sgroup-toggle"
              data-nav
              data-folder={group.key}
              tabIndex={-1}
              aria-expanded={hasSessions ? open : undefined}
              title={group.path}
              onClick={() => (hasSessions ? onToggle(group.key) : goHome(group.path))}
            >
              <span className="sgroup-icon">
                <Icon name={open ? 'folder-open' : 'folder'} size={15} />
              </span>
              <span className="sgroup-name truncate">{group.name}</span>
              {collapsed && hasSessions && (
                <span className="sgroup-end">
                  {group.attention ? <StatusGlyph tone={group.attention} /> : <span className="sgroup-count num">{group.sessions.length || ''}</span>}
                </span>
              )}
            </button>
            <span className="sgroup-tools">
              <RM.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
                <RM.Trigger className="sgroup-tool" tabIndex={-1} aria-label={`Actions for ${group.name}`}>
                  <Icon name="dots" size={15} />
                </RM.Trigger>
                <RM.Portal>
                  <RM.Content className="pop" align="start" side="right" sideOffset={6} collisionPadding={10} style={{ minWidth: 220 }}>
                    <ProjectItems group={group} hasSessions={hasSessions} Item={RM.Item} Separator={RM.Separator} />
                  </RM.Content>
                </RM.Portal>
              </RM.Root>
              <Tip label={`New session in ${group.name}`}>
                <button type="button" className="sgroup-tool" tabIndex={-1} aria-label={`New session in ${group.name}`} onClick={() => goHome(group.path)}>
                  <Icon name="plus" size={14} />
                </button>
              </Tip>
            </span>
          </div>
        </RC.Trigger>
        <RC.Portal>
          <RC.Content className="pop" collisionPadding={10} style={{ minWidth: 220 }}>
            <ProjectItems group={group} hasSessions={hasSessions} Item={RC.Item} Separator={RC.Separator} />
          </RC.Content>
        </RC.Portal>
      </RC.Root>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            className="sgroup-body"
            initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
            animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
            exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
            transition={{ height: { duration: 0.26, ease: EASE }, opacity: { duration: 0.18, ease: EASE } }}
          >
            <SessionList ids={ids} mix={group.mix} major={group.major} />
            {group.archived.length > 0 && (
              <>
                <button type="button" className="sarchived" data-nav tabIndex={-1} aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
                  <span className="srow-mark">
                    <Icon name="archive" size={14} />
                  </span>
                  <span className="grow">Archived</span>
                  <span className="sarchived-count num">{group.archived.length}</span>
                </button>
                <AnimatePresence initial={false}>
                  {showArchived && (
                    <motion.div
                      key="archived"
                      className="sgroup-body"
                      initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
                      animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
                      exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
                      transition={{ duration: 0.24, ease: EASE }}
                    >
                      <SessionList ids={idsOf(group.archived)} mix={undefined} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}, sameSection);

type MenuItemPart = ComponentType<{ className?: string; disabled?: boolean; onSelect?: () => void; children?: ReactNode }>;

/** The project header's actions, shared by its "…" menu and its context menu. */
function ProjectItems({ group, hasSessions, Item, Separator }: { group: ProjectGroup; hasSessions: boolean; Item: MenuItemPart; Separator: ComponentType<{ className?: string }> }) {
  return (
    <>
      <Item className="menu-item" onSelect={() => goHome(group.path)}>
        <Icon name="compose" size={16} />
        <span className="grow">New session here</span>
      </Item>
      <Item className="menu-item" onSelect={() => void pinProject(group.path, !group.pinned)}>
        <Icon name={group.pinned ? 'pin-off' : 'pin'} size={16} />
        <span className="grow">{group.pinned ? 'Unpin project' : 'Pin project'}</span>
      </Item>
      <Item className="menu-item" onSelect={() => void navigator.clipboard?.writeText(group.path)}>
        <Icon name="copy" size={16} />
        <span className="grow">Copy path</span>
      </Item>
      <Separator className="menu-sep" />
      <Item className="menu-item sgroup-remove" disabled={hasSessions} onSelect={() => void removeProject(group.path)}>
        <Icon name="x" size={16} />
        <span className="grow">Remove from sidebar</span>
        {hasSessions && <span className="hint">Has sessions</span>}
      </Item>
    </>
  );
}

// ── scrolling: rows passing under a still pointer do not hover ──

/**
 * While the list scrolls, rows stop answering the pointer: otherwise every row that slides under
 * it restyles (and builds its tools), which was nine tenths of a scroll's cost with many rows.
 */
let scrollIdle = 0;
function onListScroll(e: { currentTarget: HTMLElement }) {
  const list = e.currentTarget;
  if (!scrollIdle) list.dataset.scrolling = '';
  window.clearTimeout(scrollIdle);
  scrollIdle = window.setTimeout(() => {
    scrollIdle = 0;
    delete list.dataset.scrolling;
  }, 140);
}

// ── keyboard: one tab stop for the whole list, arrows inside it ──

// Collapsed folders unmount their rows, so every match is a visible item (no layout read per key).
const navItems = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('[data-nav]')];

function focusItem(el: HTMLElement | undefined) {
  if (!el) return;
  el.focus();
  el.scrollIntoView({ block: 'nearest' });
}

/** Tabbing into the list lands on the open session (or the first row); the list itself steps aside. */
function onListFocus(e: FocusEvent<HTMLDivElement>) {
  const list = e.currentTarget;
  if (e.target !== list) {
    list.tabIndex = -1;
    return;
  }
  const items = navItems(list);
  focusItem(items.find((el) => el.getAttribute('aria-current') === 'page') ?? items[0]);
}

function onListBlur(e: FocusEvent<HTMLDivElement>) {
  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) e.currentTarget.tabIndex = 0;
}

/**
 * Up and Down move between rows and folder headers, Home and End to the ends; Right opens a
 * folder, Left closes it (or, on a row, goes to its folder). Enter and Space activate, F2
 * renames, Delete deletes, the menu key or Shift+F10 opens the row's menu.
 */
function onListKey(e: KeyboardEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT') return;
  const list = e.currentTarget;
  const current = target.closest<HTMLElement>('[data-nav]');
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (!current) return;
    e.preventDefault();
    const folder = current.dataset.folder;
    const expanded = current.getAttribute('aria-expanded');
    if (folder && expanded !== null) {
      if ((e.key === 'ArrowRight') !== (expanded === 'true')) current.click();
      else if (e.key === 'ArrowRight') focusItem(navItems(list)[navItems(list).indexOf(current) + 1]);
    } else if (e.key === 'ArrowLeft') {
      focusItem(current.closest('.sgroup')?.querySelector<HTMLElement>('.sgroup-toggle') ?? undefined);
    }
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = navItems(list);
  if (!items.length) return;
  e.preventDefault();
  const i = current ? items.indexOf(current) : -1;
  let next = 0;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else if (i < 0) next = e.key === 'ArrowDown' ? 0 : items.length - 1;
  else next = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  focusItem(items[next]);
}

// ── collapse: the stage widens or narrows without laying the conversation out every frame ──

/**
 * While the sidebar opens or closes, the stage's box animates its width (the sidebar's width
 * transition in app.css) but the view inside it keeps one width, the wider of the two, anchored
 * to the stage's right edge, and slides by half the difference so its centre column glides
 * exactly where the resizing stage puts it. One layout at the start (when the stage grows) or
 * at the end (when it narrows) instead of one per frame; the backdrop's canvas resizes once.
 */
function useStageFreeze() {
  useEffect(() => {
    let timer = 0;
    let anims: Animation[] = [];
    const release = (body: HTMLElement | null) => {
      window.clearTimeout(timer);
      for (const a of anims) a.cancel();
      anims = [];
      if (body) {
        delete body.dataset.freeze;
        body.style.removeProperty('--freeze-w');
      }
    };
    return useStore.subscribe((s, p) => {
      if (s.ui.sidebarOpen === p.ui.sidebarOpen) return;
      const body = document.querySelector<HTMLElement>('.stage > .stage-body');
      const side = document.querySelector<HTMLElement>('.app-side');
      const inner = side?.firstElementChild as HTMLElement | null;
      release(body);
      if (!body || !side || !inner || reducedMotion()) return;
      const cs = getComputedStyle(side);
      const ms = parseFloat(cs.transitionDuration) * (cs.transitionDuration.trim().endsWith('ms') ? 1 : 1000);
      if (!(ms > 20)) return;
      const opening = s.ui.sidebarOpen;
      const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gap')) || 0;
      const w0 = body.clientWidth;
      const delta = inner.offsetWidth + gap;
      const w1 = opening ? w0 - delta : w0 + delta;
      if (w1 <= 0) return;
      const from = opening ? 0 : (w1 - w0) / 2;
      const to = opening ? (w0 - w1) / 2 : 0;
      body.style.setProperty('--freeze-w', `${Math.max(w0, w1)}px`);
      body.dataset.freeze = '';
      const easing = cs.transitionTimingFunction.split(/,(?![^(]*\))/)[0]?.trim() || 'ease-out';
      for (const view of body.querySelectorAll<HTMLElement>(':scope > .stage-view')) {
        anims.push(view.animate([{ translate: `${from}px 0` }, { translate: `${to}px 0` }], { duration: ms, easing }));
      }
      timer = window.setTimeout(() => release(body), ms + 20);
    });
  }, []);
}
