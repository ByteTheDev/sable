import { createContext, memo, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ContextMenu as RC, DropdownMenu as RM } from 'radix-ui';
import type { SessionMeta } from '@shared/protocol';
import { PROVIDER_NAME, StatusGlyph, type StatusTone } from '@/art/Logo';
import { Icon, type IconName } from '@/icons';
import { timeAgo } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { interrupt, openSession, renameSession, updateSession } from '@/state/actions';
import { useStore } from '@/state/store';
import { cx } from '@/ui';

// ── shared row state (rename / delete confirm) ──

export interface RowCtx {
  setRenaming: (id: string | null) => void;
  askDelete: (id: string) => void;
}

/** Which row is being renamed, outside React state so only the two rows involved re-render. */
let renamingId: string | null = null;
const renameListeners = new Set<() => void>();
export function setRenaming(id: string | null) {
  if (id === renamingId) return;
  renamingId = id;
  for (const l of renameListeners) l();
}
const subscribeRename = (l: () => void) => {
  renameListeners.add(l);
  return () => renameListeners.delete(l);
};
const useRenaming = (id: string) => useSyncExternalStore(subscribeRename, () => renamingId === id);

export const SidebarRowContext = createContext<RowCtx>({ setRenaming, askDelete: () => {} });

/** The fields a row shows. Anything else changing on a session (usage, model, options) must not re-render it. */
const SHOWN = ['id', 'title', 'status', 'unread', 'pinned', 'archived', 'updatedAt', 'activity', 'lastError', 'provider'] as const;
const sameShown = (a: SessionMeta, b: SessionMeta) => SHOWN.every((k) => a[k] === b[k]);

/** The session as the row shows it: the same object while only unshown fields change. */
function useRowSession(id: string): SessionMeta | undefined {
  const last = useRef<SessionMeta | undefined>(undefined);
  const select = useCallback(
    (s: { sessions: Record<string, SessionMeta> }) => {
      const next = s.sessions[id];
      const prev = last.current;
      if (prev && next && sameShown(prev, next)) return prev;
      last.current = next;
      return next;
    },
    [id],
  );
  return useStore(select);
}

// ── sliding active pill ──

/**
 * Where the pill was drawn last, in the list's scroll coordinates, so the next one can slide in
 * from there (a one-element FLIP). Measured in the frame after mounting, never during a commit:
 * forcing layout while a session view is being built is what made opening one slow.
 */
let lastPill: number | null = null;

function ActivePill() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      const list = el.closest('.side-list');
      if (!list) return;
      const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      const dy = lastPill === null ? 0 : lastPill - top;
      lastPill = top;
      el.style.opacity = '';
      if (dy && Math.abs(dy) < 480 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(0.2, 0.9, 0.25, 1.04)' });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  // Hidden for the one frame before it knows where it slides from. Decided once at mount: reading
  // `lastPill` on a later render (after the frame above set it) would hide the pill again.
  const [hidden] = useState(() => lastPill !== null);
  return <span ref={ref} className="srow-pill dither-sel" style={hidden ? { opacity: 0 } : undefined} />;

}

// ── status mark ──

export function statusTone(s: SessionMeta): StatusTone {
  if (s.status === 'running' || s.status === 'starting') return 'working';
  if (s.status === 'awaiting') return 'awaiting';
  if (s.status === 'error') return 'error';
  return s.unread ? 'unread' : 'idle';
}

export function StatusMark({ session }: { session: SessionMeta }) {
  return <StatusGlyph tone={statusTone(session)} />;
}

export function statusLabel(s: SessionMeta): string | null {
  if (s.status === 'running' || s.status === 'starting') return s.activity || 'Working';
  if (s.status === 'awaiting') return 'Needs approval';
  if (s.status === 'error') return s.lastError ? `Error: ${s.lastError}` : 'Error';
  return null;
}

// ── row menu (dropdown and context menu share one list) ──

interface MenuAction {
  icon: IconName;
  label: string;
  tone?: 'danger';
  run: () => void;
  sepBefore?: boolean;
}

function rowActions(s: SessionMeta, ctx: RowCtx): MenuAction[] {
  const running = s.status === 'running' || s.status === 'starting' || s.status === 'awaiting';
  const list: MenuAction[] = [
    { icon: 'pencil', label: 'Rename', run: () => ctx.setRenaming(s.id) },
    { icon: 'pin', label: s.pinned ? 'Unpin' : 'Pin', run: () => void updateSession(s.id, { pinned: !s.pinned }) },
  ];
  if (!s.unread) list.push({ icon: 'circle', label: 'Mark unread', run: () => void updateSession(s.id, { unread: true }) });
  list.push({ icon: 'archive', label: s.archived ? 'Unarchive' : 'Archive', run: () => void updateSession(s.id, { archived: !s.archived, ...(s.archived ? {} : { pinned: false }) }) });
  if (running) list.push({ icon: 'stop', label: 'Stop', run: () => void interrupt(s.id), sepBefore: true });
  list.push({ icon: 'trash', label: 'Delete', tone: 'danger', run: () => ctx.askDelete(s.id), sepBefore: !running });
  return list;
}

/** Keeps focus where the action wants it (the rename field) instead of the trigger. */
let keepFocus = false;
const holdFocus = (fn: () => void) => () => {
  keepFocus = true;
  fn();
};
const onCloseAutoFocus = (e: Event) => {
  if (keepFocus) {
    e.preventDefault();
    keepFocus = false;
  }
};

function DropdownItems({ actions }: { actions: MenuAction[] }) {
  return (
    <>
      {actions.map((a) => (
        <Frag key={a.label}>
          {a.sepBefore && <RM.Separator className="menu-sep" />}
          <RM.Item className="menu-item" data-tone={a.tone} onSelect={a.label === 'Rename' ? holdFocus(a.run) : a.run}>
            <Icon name={a.icon} size={16} />
            <span className="grow truncate">{a.label}</span>
          </RM.Item>
        </Frag>
      ))}
    </>
  );
}

function ContextItems({ actions }: { actions: MenuAction[] }) {
  return (
    <>
      {actions.map((a) => (
        <Frag key={a.label}>
          {a.sepBefore && <RC.Separator className="menu-sep" />}
          <RC.Item className="menu-item" data-tone={a.tone} onSelect={a.label === 'Rename' ? holdFocus(a.run) : a.run}>
            <Icon name={a.icon} size={16} />
            <span className="grow truncate">{a.label}</span>
          </RC.Item>
        </Frag>
      ))}
    </>
  );
}

const Frag = ({ children }: { children: ReactNode }) => <>{children}</>;

// ── rename field ──

function RenameField({ session, onDone }: { session: SessionMeta; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(session.title);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // After the menu has finished closing, so focus lands here and stays.
    const t = window.setTimeout(() => {
      el.focus();
      el.select();
    }, 20);
    return () => window.clearTimeout(t);
  }, []);

  const commit = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const title = value.trim();
    if (save && title && title !== session.title) void renameSession(session.id, title);
    onDone();
  };

  return (
    <input
      ref={ref}
      className="srow-rename"
      value={value}
      aria-label="Session title"
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      // The list's shared context menu stays out of the way: the field keeps the native one (paste).
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit(true);
        else if (e.key === 'Escape') commit(false);
      }}
      onBlur={() => commit(true)}
    />
  );
}

// ── the row ──

/**
 * A sidebar row. It reads its own session and active state from the store, so a status change
 * in one session re-renders only that row. `enter` is read once: rows added after the list
 * first drew fade in (plain CSS), the first paint does not animate.
 */
export const SessionRow = memo(function SessionRow({ id, enter }: { id: string; enter?: boolean }) {
  const session = useRowSession(id);
  const active = useStore((s) => s.ui.activeSessionId === id);
  const renaming = useRenaming(id);
  const ctx = useContext(SidebarRowContext);
  const now = useNow();
  const [menuOpen, setMenuOpen] = useState(false);
  // The dropdown is mounted the first time it is asked for: a menu per row is most of a row's cost.
  const [menuArmed, setMenuArmed] = useState(false);
  const [animateIn] = useState(!!enter);
  if (!session) return null;
  const label = statusLabel(session);
  const more = (
    <button
      type="button"
      className="srow-more"
      aria-label={`Actions for ${session.title}`}
      aria-haspopup="menu"
      onClick={
        menuArmed
          ? undefined
          : () => {
              setMenuArmed(true);
              setMenuOpen(true);
            }
      }
    >
      <Icon name="dots" size={15} />
    </button>
  );

  return (
    <div
      className={cx('srow', session.archived && 'srow-archived')}
      data-row={id}
      data-enter={animateIn || undefined}
      data-active={active || undefined}
      data-menu={menuOpen || undefined}
      data-status={session.status}
      data-unread={session.unread || undefined}
    >
      {active && <ActivePill />}
      <span className="srow-mark">
        <StatusMark session={session} />
      </span>
      {renaming ? (
        <RenameField session={session} onDone={() => ctx.setRenaming(null)} />
      ) : (
        <button
          type="button"
          className="srow-main"
          data-nav
          data-id={session.id}
          aria-current={active ? 'page' : undefined}
          title={label ?? undefined}
          onClick={() => openSession(session.id)}
          onDoubleClick={() => ctx.setRenaming(session.id)}
        >
          <span className="srow-title truncate">{session.title}</span>
          <span className="sr-only">
            {PROVIDER_NAME[session.provider]}
            {label ? `, ${label}` : ''}
          </span>
        </button>
      )}
      {!renaming && (
        <span className="srow-end">
          <span className="srow-time num">{timeAgo(session.updatedAt, now)}</span>
          {menuArmed ? (
            <RM.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
              <RM.Trigger asChild>{more}</RM.Trigger>
              <RM.Portal>
                <RM.Content className="pop" align="start" side="right" sideOffset={6} collisionPadding={10} style={{ minWidth: 188 }} onCloseAutoFocus={onCloseAutoFocus}>
                  <DropdownItems actions={rowActions(session, ctx)} />
                </RM.Content>
              </RM.Portal>
            </RM.Root>
          ) : (
            more
          )}
        </span>
      )}
    </div>
  );
}, (a, b) => a.id === b.id);

/**
 * One context menu for every row in the list (a context menu per row costs more than the row).
 * The row under the pointer is found from the event; a renaming row keeps the native menu.
 */
export function RowContextMenu({ children }: { children: ReactNode }) {
  const ctx = useContext(SidebarRowContext);
  const [target, setTarget] = useState<string | null>(null);
  const session = useStore((s) => (target ? s.sessions[target] : undefined));
  const mark = (id: string | null, on: boolean) => {
    if (id) document.querySelector(`.srow[data-row="${CSS.escape(id)}"]`)?.toggleAttribute('data-menu', on);
  };
  return (
    <RC.Root onOpenChange={(open) => !open && mark(target, false)}>
      <RC.Trigger
        asChild
        onContextMenu={(e) => {
          const row = (e.target as HTMLElement).closest<HTMLElement>('.srow[data-row]');
          // Not on a row (or a folder header handled it already): no menu from here.
          if (!row || e.defaultPrevented) return e.preventDefault();
          setTarget(row.dataset.row!);
          mark(row.dataset.row!, true);
        }}
      >
        {children}
      </RC.Trigger>
      <RC.Portal>
        <RC.Content className="pop" collisionPadding={10} style={{ minWidth: 188 }} onCloseAutoFocus={onCloseAutoFocus}>
          {session && <ContextItems actions={rowActions(session, ctx)} />}
        </RC.Content>
      </RC.Portal>
    </RC.Root>
  );
}
