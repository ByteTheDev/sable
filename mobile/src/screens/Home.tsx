import { motion } from 'motion/react';
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, SessionMeta } from '@shared/protocol';
import { baseName, timeAgo } from '@desk/lib/format';
import { conn } from '@m/lib/conn';
import { haptic } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { useStore } from '@m/lib/store';
import { useNow } from '@m/lib/useNow';
import { Field, paletteFor } from '@m/ui/Field';
import { Icon } from '@m/ui/icons';
import { LogoMark, ProviderMark, StatusMark, type Tone } from '@m/ui/marks';
import { Sheet } from '@m/ui/Sheet';
import { LimitsSheet } from './Limits';
import { NewChatSheet } from './NewChat';

const PER_FOLDER = 6;

export const toneOf = (s: SessionMeta): Tone =>
  s.status === 'running' || s.status === 'starting' ? 'working' : s.status === 'awaiting' ? 'awaiting' : s.status === 'error' ? 'error' : s.unread ? 'unread' : 'idle';

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

interface Group {
  key: string;
  name: string;
  sessions: SessionMeta[];
}

function groupSessions(sessions: SessionMeta[], projects: Project[], order: string | undefined, q: string): Group[] {
  const byDir = new Map<string, SessionMeta[]>();
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const s of sessions) {
    if (s.archived) continue;
    if (words.length) {
      const hay = `${s.title} ${baseName(s.cwd)}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
    }
    const k = norm(s.cwd);
    let list = byDir.get(k);
    if (!list) byDir.set(k, (list = []));
    list.push(s);
  }
  const proj = new Map(projects.map((p) => [norm(p.path), p]));
  const groups: (Group & { order: number; last: number; hidden?: boolean })[] = [];
  for (const [k, list] of byDir) {
    const p = proj.get(k);
    if (p?.hidden) continue;
    list.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt - a.updatedAt));
    groups.push({ key: k, name: p?.name ?? baseName(list[0].cwd), sessions: list, order: p?.order ?? Number.MAX_SAFE_INTEGER, last: list.reduce((m, s) => Math.max(m, s.updatedAt), 0) });
  }
  if (order === 'name') groups.sort((a, b) => a.name.localeCompare(b.name));
  else if (order === 'recent') groups.sort((a, b) => b.last - a.last);
  else groups.sort((a, b) => a.order - b.order || b.last - a.last);
  // Anything waiting on you comes first, whatever the order.
  return groups.sort((a, b) => Number(b.sessions.some((s) => s.status === 'awaiting')) - Number(a.sessions.some((s) => s.status === 'awaiting')));
}

export function Home({ under }: { under: boolean }) {
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const folderOrder = useStore((s) => s.settings?.folderOrder);
  const defaultProvider = useStore((s) => s.settings?.defaultProvider);
  const desktop = useStore((s) => s.desktop);
  const connState = useStore((s) => s.conn);
  const loaded = useStore((s) => s.loaded);
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query);
  const [limits, setLimits] = useState(false);
  const [newChat, setNewChat] = useState(false);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<string | null>(null);
  const groups = useMemo(() => groupSessions(Object.values(sessions), projects, folderOrder, q), [sessions, projects, folderOrder, q]);
  const running = useMemo(() => Object.values(sessions).some((s) => s.status === 'running'), [sessions]);

  return (
    <div className="screen home" data-under={under || undefined}>
      <Field palette={paletteFor(defaultProvider)} amount={1.05} focusY={1.04} spread={0.5} active={running && !under} />
      <header className="home-head">
        <div className="home-brand">
          <LogoMark size={18} />
          <span className="home-name">{desktop ?? 'Sable'}</span>
          {connState !== 'open' && (
            <span className="conn-pill" data-state={connState}>
              {connState === 'connecting' ? 'Connecting' : connState === 'denied' ? 'Not paired' : 'Offline'}
            </span>
          )}
        </div>
        <div className="home-tools">
          <button type="button" className="icon-btn" aria-label="Limits" onClick={() => (haptic('tap'), setLimits(true))}>
            <Icon name="gauge" size={21} />
          </button>
          <button type="button" className="icon-btn" aria-label="Settings" onClick={() => (haptic('tap'), nav.push({ name: 'settings' }))}>
            <Icon name="gear" size={21} />
          </button>
        </div>
      </header>

      <div className="home-scroll">
        <label className="search">
          <Icon name="search" size={17} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search chats" enterKeyHint="search" />
          {query && (
            <button type="button" className="search-clear" aria-label="Clear" onClick={() => setQuery('')}>
              <Icon name="x" size={14} weight="bold" />
            </button>
          )}
        </label>

        {!loaded && connState === 'offline' ? (
          <div className="unreachable">
            <Icon name="offline" size={22} />
            <p>Can't reach {desktop ?? 'the computer'}</p>
            <button type="button" className="btn" onClick={() => conn.wake()}>
              Try again
            </button>
          </div>
        ) : !loaded ? (
          <div className="list-skel" aria-hidden>
            {Array.from({ length: 7 }, (_, i) => (
              <span key={i} className="skel" style={{ width: `${86 - ((i * 13) % 34)}%` }} />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <p className="empty">{q ? 'No chats match.' : 'No chats yet.'}</p>
        ) : (
          groups.map((g) => {
            const open = more[g.key] || !!q;
            const shown = open ? g.sessions : g.sessions.slice(0, PER_FOLDER);
            return (
              <section key={g.key} className="group">
                <h2 className="group-name">
                  <Icon name="folder" size={15} />
                  <span>{g.name}</span>
                </h2>
                <ul className="rows">
                  {shown.map((s) => (
                    <Row key={s.id} s={s} onMenu={setMenu} />
                  ))}
                </ul>
                {g.sessions.length > shown.length && (
                  <button type="button" className="more-row" onClick={() => setMore((m) => ({ ...m, [g.key]: true }))}>
                    {g.sessions.length - shown.length} more
                  </button>
                )}
              </section>
            );
          })
        )}
        <div className="home-pad" />
      </div>

      <motion.button
        type="button"
        className="fab"
        whileTap={{ scale: 0.96 }}
        onClick={() => {
          haptic('tap');
          setNewChat(true);
        }}
        disabled={connState !== 'open'}
      >
        <Icon name="plus" size={18} weight="bold" /> New chat
      </motion.button>

      <LimitsSheet open={limits} onClose={() => setLimits(false)} />
      <NewChatSheet open={newChat} onClose={() => setNewChat(false)} />
      <ChatActions id={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

const Row = memo(function Row({ s, onMenu }: { s: SessionMeta; onMenu: (id: string) => void }) {
  const now = useNow();
  const tone = toneOf(s);
  const busy = tone === 'working' || tone === 'awaiting';
  const press = useRef<{ timer: number; fired: boolean } | null>(null);
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
  };
  return (
    <li>
      <button
        type="button"
        className="row"
        data-tone={tone}
        // A long press opens the chat's actions (pin, rename, archive).
        onPointerDown={() => {
          cancel();
          const p = { fired: false, timer: 0 };
          p.timer = window.setTimeout(() => {
            p.fired = true;
            haptic('select');
            onMenu(s.id);
          }, 480);
          press.current = p;
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          if (press.current?.fired) return;
          haptic('tap');
          nav.chat(s.id);
        }}
      >
        <ProviderMark provider={s.provider} size={16} />
        <span className="row-text">
          <span className="row-title">{s.title}</span>
          {busy && s.activity && <span className="row-sub">{tone === 'awaiting' ? 'Waiting for you' : s.activity}</span>}
          {tone === 'awaiting' && !s.activity && <span className="row-sub">Waiting for you</span>}
        </span>
        <span className="row-end">{tone === 'idle' ? <span className="row-time num">{timeAgo(s.updatedAt, now)}</span> : <StatusMark tone={tone} />}</span>
      </button>
    </li>
  );
});

/** A chat's actions from a long press: pin, rename, archive. */
function ChatActions({ id, onClose }: { id: string | null; onClose: () => void }) {
  const s = useStore((st) => (id ? st.sessions[id] : undefined));
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  useEffect(() => {
    setRenaming(false);
    setTitle(s?.title ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const update = (patch: { pinned?: boolean; archived?: boolean }) => {
    if (!s) return;
    haptic('select');
    void conn.call('session.update', { sessionId: s.id, patch }).catch(() => {});
    onClose();
  };
  return (
    <Sheet open={!!id && !!s} onClose={onClose} label="Chat">
      {s && (
        <div className="actions">
          <div className="actions-head">
            <ProviderMark provider={s.provider} size={16} />
            <span>{s.title}</span>
          </div>
          {renaming ? (
            <form
              className="rename"
              onSubmit={(e) => {
                e.preventDefault();
                const t = title.trim();
                if (t && t !== s.title) void conn.call('session.rename', { sessionId: s.id, title: t }).catch(() => {});
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
            <div className="choices">
              <button type="button" className="choice" onClick={() => update({ pinned: !s.pinned })}>
                <span className="choice-icon">
                  <Icon name="pin" size={17} />
                </span>
                <span className="choice-label">{s.pinned ? 'Unpin' : 'Pin to top'}</span>
              </button>
              <button type="button" className="choice" onClick={() => setRenaming(true)}>
                <span className="choice-icon">
                  <Icon name="edit" size={17} />
                </span>
                <span className="choice-label">Rename</span>
              </button>
              <button type="button" className="choice" onClick={() => update({ archived: true })}>
                <span className="choice-icon">
                  <Icon name="archive" size={17} />
                </span>
                <span className="choice-label">Archive</span>
              </button>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
