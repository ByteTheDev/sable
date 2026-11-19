import { animate } from 'motion';
import { AnimatePresence, motion } from 'motion/react';
import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Project, SessionMeta } from '@shared/protocol';
import { baseName, timeAgo } from '@desk/lib/format';
import { pushBack } from '@m/lib/back';
import { conn } from '@m/lib/conn';
import { haptic } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { openFrom } from '@m/lib/open';
import { getState, refresh, setState, useStore } from '@m/lib/store';
import { useNow } from '@m/lib/useNow';
import { Field, fieldBeat, paletteFor } from '@m/ui/Field';
import { Icon } from '@m/ui/icons';
import { LogoMark, ProviderMark, Ring, StatusMark, Tiles, type Tone } from '@m/ui/marks';
import { nowOf, REVEAL, SNAP, SPRING } from '@m/ui/motion';
import { Pull } from '@m/ui/Pull';
import { ditherStrip } from '@m/ui/strip';
import { veil } from '@m/ui/veil';
import { HomeDock } from './HomeDock';
import { LimitsSheet } from './Limits';

const PER_FOLDER = 6;

export const toneOf = (s: SessionMeta): Tone =>
  s.status === 'running' || s.status === 'starting' ? 'working' : s.status === 'awaiting' ? 'awaiting' : s.status === 'error' ? 'error' : s.unread ? 'unread' : 'idle';

const isLive = (s: SessionMeta) => !s.archived && (s.status === 'running' || s.status === 'starting' || s.status === 'awaiting');

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

interface Group {
  key: string;
  name: string;
  sessions: SessionMeta[];
}

function groupSessions(sessions: SessionMeta[], projects: Project[], order: string | undefined, q: string, skip: Set<string>): Group[] {
  const byDir = new Map<string, SessionMeta[]>();
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const s of sessions) {
    if (s.archived || skip.has(s.id)) continue;
    if (words.length) {
      const hay = `${s.title} ${baseName(s.cwd)}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
    }
    // Chats without a folder of their own go together.
    const k = s.chat ? '::chats' : norm(s.cwd);
    let list = byDir.get(k);
    if (!list) byDir.set(k, (list = []));
    list.push(s);
  }
  const proj = new Map(projects.map((p) => [norm(p.path), p]));
  const groups: (Group & { order: number; last: number })[] = [];
  for (const [k, list] of byDir) {
    const p = proj.get(k);
    if (p?.hidden) continue;
    list.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt - a.updatedAt));
    groups.push({ key: k, name: k === '::chats' ? 'Chats' : (p?.name ?? baseName(list[0].cwd)), sessions: list, order: p?.order ?? Number.MAX_SAFE_INTEGER, last: list.reduce((m, s) => Math.max(m, s.updatedAt), 0) });
  }
  if (order === 'name') groups.sort((a, b) => a.name.localeCompare(b.name));
  else if (order === 'recent') groups.sort((a, b) => b.last - a.last);
  else groups.sort((a, b) => a.order - b.order || b.last - a.last);
  return groups;
}

export function Home({ under }: { under: boolean }) {
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const folderOrder = useStore((s) => s.settings?.folderOrder);
  const defaultProvider = useStore((s) => s.settings?.defaultProvider);
  const desktop = useStore((s) => s.desktop);
  const connState = useStore((s) => s.conn);
  const loaded = useStore((s) => s.loaded);
  // Reached the desktop in this run: a lost connection is then "Reconnecting".
  const fresh = useStore((s) => !!s.fresh);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const q = useDeferredValue(searching ? query : '');
  const [limits, setLimits] = useState(false);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [peek, setPeek] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const root = useRef<HTMLDivElement>(null);

  // What runs or waits now, the waiting ones first: the cards at the top (not repeated below).
  const live = useMemo(
    () =>
      Object.values(sessions)
        .filter(isLive)
        .sort((a, b) => Number(b.status === 'awaiting') - Number(a.status === 'awaiting') || b.updatedAt - a.updatedAt),
    [sessions],
  );
  const liveIds = useMemo(() => new Set(q ? [] : live.map((s) => s.id)), [live, q]);
  const groups = useMemo(() => groupSessions(Object.values(sessions), projects, folderOrder, q, liveIds), [sessions, projects, folderOrder, q, liveIds]);
  const waiting = live.filter((s) => s.status === 'awaiting');
  const working = live.length - waiting.length;
  const name = desktop ?? 'Sable';

  // For start-up timing (DevTools: performance.getEntriesByName('sable:list')).
  useEffect(() => {
    if (groups.length && !performance.getEntriesByName('sable:list').length) performance.mark('sable:list');
  }, [groups.length]);

  // Under a chat or settings, home steps back (smaller, dimmer) on the same spring as the screen over it.
  // Once a screen covers it whole, home is not drawn at all (it was drawn under every frame of the chat's scrolling).
  const wasUnder = useRef(under);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || wasUnder.current === under) return;
    wasUnder.current = under;
    el.style.visibility = '';
    const n = nowOf(el);
    const a = animate(el, { transform: [`scale(${n.scale})`, `scale(${under ? 0.94 : 1})`], opacity: [n.opacity, under ? 0.45 : 1] }, SPRING);
    if (under) void a.finished.then(() => wasUnder.current && (el.style.visibility = 'hidden'));
  }, [under]);

  useEffect(() => (searching ? pushBack(() => (closeSearch(), true)) : undefined), [searching]);

  // While the list moves, the new-chat bar drops its blur (it would be drawn again every frame) and
  // stands on denser ink; at rest it is glass again.
  useEffect(() => {
    const el = root.current;
    const sc = el?.querySelector('.home-scroll');
    if (!el || !sc) return;
    let t = 0;
    const on = () => {
      if (!t) el.setAttribute('data-moving', '');
      clearTimeout(t);
      t = window.setTimeout(() => {
        t = 0;
        el.removeAttribute('data-moving');
      }, 180);
    };
    sc.addEventListener('scroll', on, { passive: true });
    return () => {
      sc.removeEventListener('scroll', on);
      clearTimeout(t);
    };
  }, []);
  const closeSearch = () => {
    setSearching(false);
    setQuery('');
    (document.activeElement as HTMLElement | null)?.blur?.();
  };

  // A waiting chat out of sight (scrolled past the cards): one line above the field says so.
  const nowRef = useRef<HTMLElement>(null);
  const [nowSeen, setNowSeen] = useState(true);
  useEffect(() => {
    const el = nowRef.current;
    if (!el) return setNowSeen(true);
    const io = new IntersectionObserver(([e]) => setNowSeen(e.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, [live.length > 0]);

  const archive = (id: string) => {
    // A row dissolves first; a card (it runs or waits) simply goes.
    if (live.some((s) => s.id === id)) void conn.call('session.update', { sessionId: id, patch: { archived: true } }).catch(() => {});
    else setLeaving((cur) => new Set(cur).add(id));
  };
  const archived = (id: string, ok: boolean) => {
    if (!ok) setLeaving((cur) => ((cur = new Set(cur)), cur.delete(id), cur));
  };

  return (
    <div className="screen home" ref={root} data-under={under || undefined}>
      <Field palette={paletteFor(defaultProvider)} amount={0.9} focusX={0.62} focusY={1.12} spread={0.95} active={live.length > 0 && !under} hidden={under} />
      <header className="home-bar">
        <LogoMark size={20} cells className="home-mark" />
        <span className="home-bar-title">{name}</span>
        <div className="home-tools">
          <button type="button" className="icon-btn" aria-label="Search" aria-pressed={searching} onClick={() => (haptic('tap'), searching ? closeSearch() : setSearching(true))}>
            <Icon name="search" size={21} />
          </button>
          <button type="button" className="icon-btn" aria-label="Limits" onClick={() => (haptic('tap'), setLimits(true))}>
            <Icon name="gauge" size={21} />
          </button>
          <button type="button" className="icon-btn" aria-label="Settings" onClick={() => (haptic('tap'), nav.push({ name: 'settings' }))}>
            <Icon name="gear" size={21} />
          </button>
        </div>
      </header>

      <Pull
        className="home-scroll"
        onRefresh={async () => {
          fieldBeat('pulse', { x: innerWidth / 2, y: 0 });
          if (getState().conn !== 'open') return conn.wake();
          await refresh([]);
        }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {searching ? (
            <motion.div key="search" className="home-hero home-search" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={SNAP}>
              <label className="search">
                <Icon name="search" size={18} />
                <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search chats" enterKeyHint="search" />
                {query && (
                  <button type="button" className="search-clear" aria-label="Clear" onClick={() => setQuery('')}>
                    <Icon name="x" size={14} weight="bold" />
                  </button>
                )}
              </label>
              <button type="button" className="link-btn" onClick={closeSearch}>
                Cancel
              </button>
            </motion.div>
          ) : (
            <motion.div key="hero" className="home-hero" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={SNAP}>
              <h1 className="home-title">{name}</h1>
              <HomeStatus conn={connState} fresh={fresh} working={working} waiting={waiting.length} />
            </motion.div>
          )}
        </AnimatePresence>

        {!loaded && connState === 'offline' ? (
          <div className="unreachable">
            <Icon name="offline" size={24} />
            <p>Can't reach {desktop ?? 'the computer'}</p>
            <p className="unreachable-hint">Sable must be running there with Phone on.</p>
            <button type="button" className="btn" onClick={() => (haptic('tap'), conn.wake())}>
              Try again
            </button>
          </div>
        ) : !loaded ? (
          <div className="home-skel" aria-hidden>
            {[5, 3].map((n, g) => (
              <div key={g} className="home-skel-card">
                {Array.from({ length: n }, (_, i) => (
                  <span key={i} className="skel" style={{ width: `${78 - ((i * 17 + g * 9) % 30)}%` }} />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <>
            {!q && live.length > 0 && (
              <section className="now" ref={nowRef} aria-label="Now">
                <AnimatePresence initial={false}>
                  {live.map((s) => (
                    <LiveCard key={s.id} s={s} onMenu={(rect) => setPeek({ id: s.id, rect })} />
                  ))}
                </AnimatePresence>
              </section>
            )}
            {groups.length === 0 && !live.length ? (
              <p className="empty">{q ? 'No chats match.' : 'No chats yet.'}</p>
            ) : (
              groups.map((g) => {
                const open = more[g.key] || !!q;
                const shown = open ? g.sessions : g.sessions.slice(0, PER_FOLDER);
                return (
                  <section key={g.key} className="group">
                    <h2 className="group-name">
                      <span>{g.name}</span>
                      {g.sessions.length > 1 && <span className="group-count num">{g.sessions.length}</span>}
                    </h2>
                    <ul className="rows">
                      {shown.map((s) => (
                        <Row key={s.id} s={s} leaving={leaving.has(s.id)} onLeft={archived} onMenu={(rect) => setPeek({ id: s.id, rect })} />
                      ))}
                    </ul>
                    {g.sessions.length > shown.length && (
                      <button type="button" className="more-row" onClick={() => (haptic('tap'), setMore((m) => ({ ...m, [g.key]: true })))}>
                        {g.sessions.length - shown.length} more
                      </button>
                    )}
                  </section>
                );
              })
            )}
          </>
        )}
        <div className="home-pad" />
      </Pull>

      {/* Waiting on you and scrolled past the cards: one line above the field brings it back. */}
      <AnimatePresence>
        {waiting.length > 0 && fresh && !nowSeen && !searching && (
          <motion.button
            key="attn"
            type="button"
            className="attn"
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.97 }}
            transition={SNAP}
            whileTap={{ scale: 0.98 }}
            onClick={(e) => {
              haptic('tap');
              openFrom(waiting[0].id, e.currentTarget, 20);
              nav.chat(waiting[0].id);
            }}
          >
            <StatusMark tone="awaiting" size={12} />
            <span className="attn-text">
              <span className="attn-title">{waiting[0].title}</span>
              <span className="attn-sub">{waiting.length > 1 ? `Waiting for you · ${waiting.length - 1} more` : 'Waiting for you'}</span>
            </span>
            <span className="attn-go">Review</span>
          </motion.button>
        )}
      </AnimatePresence>

      <HomeDock covered={under} />

      <LimitsSheet open={limits} onClose={() => setLimits(false)} />
      <Peek peek={peek} onClose={() => setPeek(null)} onArchive={archive} />
    </div>
  );
}

/** Under the title: the connection when it is not there, else what runs and waits (nothing when all is quiet). */
function HomeStatus({ conn: state, fresh, working, waiting }: { conn: string; fresh: boolean; working: number; waiting: number }) {
  let body: React.ReactNode = null;
  let key = 'none';
  if (state === 'denied') (key = 'denied'), (body = <span className="home-status-warn">Not paired</span>);
  else if (state !== 'open')
    (key = 'conn'),
      (body = (
        <>
          <Ring size={12} /> {fresh ? 'Reconnecting' : 'Connecting'}
        </>
      ));
  else if (working || waiting)
    (key = `live`),
      (body = (
        <>
          {working > 0 && (
            <span className="home-status-part">
              <Tiles size={11} /> {working} working
            </span>
          )}
          {waiting > 0 && (
            <span className="home-status-part">
              <StatusMark tone="awaiting" size={10} /> {waiting} waiting for you
            </span>
          )}
        </>
      ));
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {body && (
        <motion.p key={key} className="home-status" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={SNAP}>
          {body}
        </motion.p>
      )}
    </AnimatePresence>
  );
}

/** A long press: the chat's actions. Also used by the cards. */
function useLongPress(onLong: (el: HTMLElement) => void) {
  const press = useRef<{ timer: number; fired: boolean; x: number; y: number } | null>(null);
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
  };
  return {
    fired: () => !!press.current?.fired,
    handlers: {
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        cancel();
        const el = e.currentTarget;
        const p = { fired: false, timer: 0, x: e.clientX, y: e.clientY };
        p.timer = window.setTimeout(() => {
          p.fired = true;
          haptic('select');
          onLong(el);
        }, 440);
        press.current = p;
      },
      onPointerMove: (e: React.PointerEvent) => {
        const p = press.current;
        if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancel();
      },
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
  };
}

/** A chat at work or waiting: a card with what it does now, its agent's light at its foot. */
const LiveCard = memo(function LiveCard({ s, onMenu }: { s: SessionMeta; onMenu: (rect: DOMRect) => void }) {
  const tone = toneOf(s);
  const waiting = tone === 'awaiting';
  const lp = useLongPress((el) => onMenu(el.getBoundingClientRect()));
  return (
    <motion.button
      layout="position"
      type="button"
      className="live"
      data-tone={tone}
      data-chat={s.id}
      data-radius="22"
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.16 } }}
      transition={SNAP}
      {...lp.handlers}
      onClick={(e) => {
        if (lp.fired()) return;
        haptic('tap');
        openFrom(s.id, e.currentTarget, 22);
        nav.chat(s.id);
      }}
    >
      <span className="live-glow" aria-hidden>
        <i style={{ backgroundImage: `url(${ditherStrip(waiting ? 'amber' : paletteFor(s.provider))})` } as CSSProperties} />
      </span>
      <span className="live-line">
        <ProviderMark provider={s.provider} size={18} />
        <span className="live-title">{s.title}</span>
        <span className="live-end">{waiting ? <StatusMark tone="awaiting" size={13} /> : <Tiles size={14} />}</span>
      </span>
      <span className={waiting ? 'live-sub' : 'live-sub shimmer'}>{waiting ? 'Waiting for you' : (s.activity ?? 'Working')}</span>
    </motion.button>
  );
});

const Row = memo(function Row({ s, leaving, onLeft, onMenu }: { s: SessionMeta; leaving: boolean; onLeft: (id: string, ok: boolean) => void; onMenu: (rect: DOMRect) => void }) {
  const now = useNow();
  const tone = toneOf(s);
  const li = useRef<HTMLLIElement>(null);
  const lp = useLongPress((el) => onMenu(el.getBoundingClientRect()));

  // Archived: the row dissolves into the card in dither order, the gap closes, then the desktop is told.
  useEffect(() => {
    const el = li.current;
    if (!leaving || !el) return;
    let live = true;
    const v = veil(el, 'cover', { color: 'rgb(18 18 21)', duration: 300, bands: 3, from: 'top', cell: 3, z: 3 });
    void v.done
      .then(() => animate(el, { height: [el.offsetHeight, 0], opacity: [1, 0] }, { ...REVEAL, restDelta: 0.5 }).finished)
      .then(() => conn.call('session.update', { sessionId: s.id, patch: { archived: true } }))
      .then(
        () => live && onLeft(s.id, true),
        () => {
          if (!live) return;
          v.remove();
          el.style.height = '';
          el.style.opacity = '';
          onLeft(s.id, false);
          setState({ toast: { text: 'Could not archive it', level: 'error', at: Date.now() } });
        },
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  return (
    <li ref={li}>
      <button
        type="button"
        className="row"
        data-tone={tone}
        data-chat={s.id}
        data-radius="16"
        {...lp.handlers}
        onClick={(e) => {
          if (lp.fired() || leaving) return;
          haptic('tap');
          openFrom(s.id, e.currentTarget, 16);
          nav.chat(s.id);
        }}
      >
        <ProviderMark provider={s.provider} size={16} />
        <span className="row-title">{s.title}</span>
        <span className="row-end">
          {tone === 'error' ? <StatusMark tone="error" /> : tone === 'unread' ? <StatusMark tone="unread" size={10} /> : null}
          {s.pinned && <Icon name="pin" size={13} className="row-pin" />}
          <span className="row-time num">{timeAgo(s.updatedAt, now)}</span>
        </span>
      </button>
    </li>
  );
});

/**
 * A long press lifts the chat out of the list: the row (as it was) over a dimmed screen, its
 * actions under it. Rename turns the menu into a field in place.
 */
function Peek({ peek, onClose, onArchive }: { peek: { id: string; rect: DOMRect } | null; onClose: () => void; onArchive: (id: string) => void }) {
  const s = useStore((st) => (peek ? st.sessions[peek.id] : undefined));
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const show = !!peek && !!s;
  useEffect(() => {
    setRenaming(false);
    setTitle(s?.title ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peek?.id]);
  useEffect(() => (show ? pushBack(() => (renaming ? setRenaming(false) : onClose(), true)) : undefined), [show, renaming, onClose]);
  if (!peek) return null;
  const r = peek.rect;
  // The menu goes under the row, or over it when the row is low on the screen.
  const below = r.bottom + 200 < innerHeight - 40;
  const pin = () => {
    if (!s) return;
    haptic('select');
    void conn.call('session.update', { sessionId: s.id, patch: { pinned: !s.pinned } }).catch(() => {});
    onClose();
  };
  return createPortal(
    <AnimatePresence>
      {show && (
        <div className="peek-layer" key={peek.id}>
          <motion.div className="peek-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} onClick={onClose} />
          <motion.div
            className="peek-row"
            style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
            initial={{ scale: 1 }}
            animate={{ scale: 1.035 }}
            exit={{ scale: 1, opacity: 0, transition: { duration: 0.14 } }}
            transition={SNAP}
          >
            <ProviderMark provider={s!.provider} size={16} />
            <span className="row-title">{s!.title}</span>
          </motion.div>
          <motion.div
            className="peek-menu"
            style={below ? { top: r.bottom + 12, left: 16, right: 16 } : { bottom: innerHeight - r.top + 12, left: 16, right: 16 }}
            initial={{ opacity: 0, scale: 0.92, y: below ? -12 : 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
            transition={SNAP}
          >
            {renaming ? (
              <form
                className="rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  const t = title.trim();
                  if (t && t !== s!.title) void conn.call('session.rename', { sessionId: s!.id, title: t }).catch(() => {});
                  haptic('success');
                  onClose();
                }}
              >
                <input className="field-input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Chat name" enterKeyHint="done" />
                <button type="submit" className="btn btn-primary">
                  Save
                </button>
              </form>
            ) : (
              <>
                <button type="button" className="peek-item" onClick={pin}>
                  <span>{s!.pinned ? 'Unpin' : 'Pin to top'}</span>
                  <Icon name={s!.pinned ? 'unpin' : 'pin'} size={19} />
                </button>
                <button type="button" className="peek-item" onClick={() => (haptic('tap'), setRenaming(true))}>
                  <span>Rename</span>
                  <Icon name="edit" size={19} />
                </button>
                <button
                  type="button"
                  className="peek-item"
                  onClick={() => {
                    haptic('select');
                    onClose();
                    onArchive(s!.id);
                  }}
                >
                  <span>Archive</span>
                  <Icon name="archive" size={19} />
                </button>
              </>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
