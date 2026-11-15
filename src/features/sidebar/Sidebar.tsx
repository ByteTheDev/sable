import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type HTMLAttributes, type KeyboardEvent, type Ref, type ReactNode } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { ContextMenu as RC, DropdownMenu as RM } from 'radix-ui';
import type { SessionMeta } from '@shared/protocol';
import { LogoMark, Wordmark } from '@/art/Logo';
import { Icon, type IconName } from '@/icons';
import { dissolve } from '@/lib/dissolve';
import { closeSession, goHome, pinProject, removeProject } from '@/state/actions';
import { useStore } from '@/state/store';
import { IconButton, Kbd, Modal, Tip, cx } from '@/ui';
import { buildGroups, loadCollapsed, pathKey, saveCollapsed, type ProjectGroup } from './groups';
import { RowContextMenu, SessionRow, SidebarRowContext, setRenaming, type RowCtx } from './SessionRow';
import { SidebarFooter } from './SidebarFooter';
import './sidebar.css';

const EASE = [0.16, 1, 0.3, 1] as const;

type Sessions = Record<string, SessionMeta>;

/** True when two session maps differ only in usage, which the sidebar never shows. */
function sameRows(a: Sessions, b: Sessions): boolean {
  const ids = Object.keys(b);
  if (Object.keys(a).length !== ids.length) return false;
  for (const id of ids) {
    const x = a[id];
    const y = b[id];
    if (x === y) continue;
    if (!x) return false;
    for (const k in y) if (k !== 'usage' && x[k as keyof SessionMeta] !== y[k as keyof SessionMeta]) return false;
    for (const k in x) if (!(k in y)) return false;
  }
  return true;
}

let seenSessions: Sessions | undefined;
let shownSessions: Sessions | undefined;
/** The sessions map, kept as the same object while only usage changes (it ticks while a turn streams). */
function selectSessions(s: { sessions: Sessions }): Sessions {
  if (s.sessions === seenSessions) return shownSessions!;
  const unchanged = seenSessions && shownSessions && sameRows(seenSessions, s.sessions);
  seenSessions = s.sessions;
  if (!unchanged) shownSessions = s.sessions;
  return shownSessions!;
}

/** Memoized whole: the app shell re-renders on navigation, the sidebar parts subscribe to what they show. */
export const Sidebar = memo(function Sidebar() {
  const [deleting, setDeleting] = useState<string | null>(null);
  const ctx = useMemo<RowCtx>(() => ({ setRenaming, askDelete: setDeleting }), []);

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
    </nav>
  );
});

/** Brand and the three actions: nothing here depends on sessions. */
const SidebarTop = memo(function SidebarTop() {
  const setUi = useStore((s) => s.setUi);
  return (
    <div className="side-top">
      <div className="side-brand">
        <button type="button" className="brand" onClick={() => goHome()} aria-label="Sable home">
          <LogoMark size={20} />
          <Wordmark />
        </button>
        <IconButton icon="compose" label="New session" keys="mod+shift+o" onClick={() => goHome()} />
      </div>

      <div className="side-actions">
        <ActionRow icon="plus" label="New session" onClick={() => goHome()} hint="mod+shift+o" hintOnHover />
        <ActionRow icon="search" label="Search" onClick={() => setUi({ paletteOpen: true })} hint="mod+k" />
        <ActionRow icon="history" label="History" onClick={() => setUi({ historyOpen: true })} />
      </div>
    </div>
  );
});

/** Props and ref come from the context menu trigger wrapping it. */
function SidebarList(props: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  const sessions = useStore(selectSessions);
  const projects = useStore((s) => s.projects);
  const ready = useStore((s) => s.ready);
  // The open session's folder, not its id: switching sessions within a folder does not re-render the list.
  const activeKey = useStore(selectActiveKey);
  const setUi = useStore((s) => s.setUi);

  const groups = useMemo(() => buildGroups(sessions, projects), [sessions, projects]);
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
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

  return (
    <div {...props} className="side-list scroll" onKeyDown={onListKey}>
      {empty ? (
        <div className="side-empty">
          <p>Open a folder to start your first session.</p>
          <button type="button" className="btn btn-sm" onClick={() => setUi({ projectPicker: true })}>
            <Icon name="folder-plus" size={14} />
            Open a folder
          </button>
        </div>
      ) : (
        <MotionConfig reducedMotion="user">
          {groups.pinned.length > 0 && (
            <section className="sgroup" aria-label="Pinned">
              <div className="sgroup-head sgroup-head-static">
                <span className="sgroup-icon">
                  <Icon name="pin" size={14} />
                </span>
                <span className="sgroup-name">Pinned</span>
              </div>
              <SessionList ids={idsOf(groups.pinned)} />
            </section>
          )}
          {groups.projects.map((g) => (
            <ProjectSection
              key={g.key}
              group={g}
              collapsed={collapsed.has(g.key)}
              onToggle={toggle}
              hiddenActive={collapsed.has(g.key) && activeKey === g.key}
              busy={collapsed.has(g.key) && g.sessions.some(isBusy)}
            />
          ))}
        </MotionConfig>
      )}
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
              if (id) {
                dissolve(document.querySelector(`.srow[data-row="${CSS.escape(id)}"]`));
                void closeSession(id, true);
              }
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

function ActionRow({ icon, label, onClick, hint, hintOnHover }: { icon: IconName; label: string; onClick: () => void; hint?: string; hintOnHover?: boolean }) {
  return (
    <button type="button" className="side-action" onClick={onClick}>
      <Icon name={icon} size={16} />
      <span className="grow truncate">{label}</span>
      {hint && <Kbd combo={hint} className={cx('side-action-kbd', hintOnHover && 'on-hover')} />}
    </button>
  );
}

function selectActiveKey(s: { ui: { activeSessionId: string | null }; sessions: Sessions }): string | null {
  const a = s.ui.activeSessionId ? s.sessions[s.ui.activeSessionId] : undefined;
  return a && !a.pinned ? pathKey(a.cwd) : null;
}

const isBusy = (s: SessionMeta) => s.status === 'running' || s.status === 'awaiting' || s.status === 'starting';
const idsOf = (list: SessionMeta[]) => list.map((s) => s.id).join(' ');

/** Rows by id (a space-joined string, so the list re-renders only when membership or order changes). */
const SessionList = memo(function SessionList({ ids }: { ids: string }) {
  // Rows that arrive after the first paint animate in; the first paint does not.
  const drawn = useRef(false);
  const enter = drawn.current;
  useEffect(() => {
    drawn.current = true;
  }, []);
  return (
    <div className="srows" role="list">
      {ids
        ? ids.split(' ').map((id) => <SessionRow key={id} id={id} enter={enter} />)
        : null}
    </div>
  );
});

interface SectionProps {
  group: ProjectGroup;
  collapsed: boolean;
  onToggle: (key: string) => void;
  /** Collapsed and holding the open session. */
  hiddenActive: boolean;
  /** Collapsed and holding a session at work. */
  busy: boolean;
}

/** Re-render a project only for what its header and lists show; rows update themselves. */
const sameSection = (a: SectionProps, b: SectionProps) =>
  a.collapsed === b.collapsed &&
  a.onToggle === b.onToggle &&
  a.hiddenActive === b.hiddenActive &&
  a.busy === b.busy &&
  a.group.key === b.group.key &&
  a.group.name === b.group.name &&
  a.group.path === b.group.path &&
  a.group.pinned === b.group.pinned &&
  idsOf(a.group.sessions) === idsOf(b.group.sessions) &&
  idsOf(a.group.archived) === idsOf(b.group.archived);

const ProjectSection = memo(function ProjectSection({ group, collapsed, onToggle, hiddenActive, busy }: SectionProps) {
  const [showArchived, setShowArchived] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const hasSessions = group.sessions.length > 0 || group.archived.length > 0;
  const open = hasSessions && !collapsed;

  return (
    <section className="sgroup" aria-label={group.name}>
      <RC.Root>
        <RC.Trigger asChild>
          <div className="sgroup-head" data-collapsed={collapsed || undefined} data-current={hiddenActive || undefined} data-menu={menuOpen || undefined}>
            <button
              type="button"
              className="sgroup-toggle"
              data-nav
              aria-expanded={hasSessions ? open : undefined}
              title={group.path}
              onClick={() => (hasSessions ? onToggle(group.key) : goHome(group.path))}
            >
              <span className="sgroup-icon">
                <Icon name={open ? 'folder-open' : 'folder'} size={15} />
              </span>
              <span className="sgroup-name truncate">{group.name}</span>
              {collapsed && hasSessions && <span className={cx('sgroup-count num', busy && 'busy')}>{group.sessions.length || ''}</span>}
            </button>
            <span className="sgroup-tools">
              <RM.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
                <RM.Trigger className="sgroup-tool" aria-label={`Actions for ${group.name}`}>
                  <Icon name="dots" size={14} />
                </RM.Trigger>
                <RM.Portal>
                  <RM.Content className="pop" align="start" side="right" sideOffset={6} collisionPadding={10} style={{ minWidth: 220 }}>
                    <ProjectItems group={group} hasSessions={hasSessions} Item={RM.Item} Separator={RM.Separator} />
                  </RM.Content>
                </RM.Portal>
              </RM.Root>
              <Tip label={`New session in ${group.name}`}>
                <button type="button" className="sgroup-tool" aria-label={`New session in ${group.name}`} onClick={() => goHome(group.path)}>
                  <Icon name="plus" size={13} />
                </button>
              </Tip>
              {hasSessions && (
                <button type="button" className="sgroup-tool sgroup-chev" aria-label={collapsed ? 'Expand' : 'Collapse'} onClick={() => onToggle(group.key)}>
                  <Icon name="caret-down" size={11} />
                </button>
              )}
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
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.26, ease: EASE }}
          >
            <SessionList ids={idsOf(group.sessions)} />
            {group.archived.length > 0 && (
              <>
                <button type="button" className="sarchived" data-nav aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
                  <span className="srow-mark">
                    <Icon name="archive" size={13} />
                  </span>
                  <span className="grow">Archived ({group.archived.length})</span>
                  <Icon name="caret-down" size={10} className="sarchived-chev" />
                </button>
                <AnimatePresence initial={false}>
                  {showArchived && (
                    <motion.div
                      key="archived"
                      className="sgroup-body"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.24, ease: EASE }}
                    >
                      <SessionList ids={idsOf(group.archived)} />
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

/** Arrow keys move between rows and folder headers; Enter activates the focused one. */
function onListKey(e: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-nav]')];
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(target.closest<HTMLElement>('[data-nav]') ?? target);
  let next = 0;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else if (i < 0) next = e.key === 'ArrowDown' ? 0 : items.length - 1;
  else next = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  items[next].focus();
  items[next].scrollIntoView({ block: 'nearest' });
}
