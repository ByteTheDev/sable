import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { baseName } from '@desk/lib/format';
import { conn } from '@m/lib/conn';
import { haptic, openExternal } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { getState, openSession, sessionData, useStore } from '@m/lib/store';
import { buildTurns, shapeKey } from '@m/lib/turns';
import { Field, paletteFor } from '@m/ui/Field';
import { Icon } from '@m/ui/icons';
import { ProviderMark, Ring, StatusMark } from '@m/ui/marks';
import { Sheet } from '@m/ui/Sheet';
import { Composer } from './Composer';
import { toneOf } from './Home';
import { Prompts } from './Prompts';
import { TurnView } from './Timeline';

const PAGE = 24;

/** A conversation: header, turns (the newest ones mounted, older ones as you scroll up), composer. */
export function Chat({ id }: { id: string }) {
  const s = useStore((st) => st.sessions[id]);
  const loaded = useStore((st) => !!st.data[id]);
  const listed = useStore((st) => st.loaded);
  const connState = useStore((st) => st.conn);
  const [error, setError] = useState<string>();
  const [remote, setRemote] = useState(false);

  useEffect(() => {
    setError(undefined);
    if (getState().conn === 'open') void openSession(id).catch((err) => setError((err as Error).message));
  }, [id]);

  if (!s) {
    return (
      <div className="screen chat">
        <ChatHead title="" onBack={() => nav.pop()} />
        {listed ? <p className="empty">This chat is no longer on the desktop.</p> : <div className="thread-skel"><ThreadSkeleton /></div>}
      </div>
    );
  }
  const live = s.status === 'running' || s.status === 'starting';
  const remoteOn = !!s.options?.remoteControl || !!s.remote;

  return (
    <div className="screen chat">
      <Field palette={paletteFor(s.provider)} amount={0.95} focusY={1.1} spread={0.52} active={live} />
      <ChatHead
        title={s.title}
        sub={connState === 'open' ? baseName(s.cwd) : undefined}
        status={connState === 'open' ? undefined : connState === 'denied' ? 'Not paired' : 'Reconnecting'}
        mark={<ProviderMark provider={s.provider} size={17} />}
        tone={toneOf(s)}
        onBack={() => nav.pop()}
        right={
          s.provider === 'claude' || s.provider === 'demo' || remoteOn ? (
            <button type="button" className="icon-btn remote-btn" data-tone={s.remote?.tone ?? (remoteOn ? 'waiting' : 'off')} aria-label="Remote control" onClick={() => (haptic('tap'), setRemote(true))}>
              <Icon name="link" size={20} />
              {remoteOn && <i className="remote-dot" />}
            </button>
          ) : undefined
        }
      />
      {loaded ? <Thread id={id} /> : <div className="thread-skel">{error ? <p className="empty">{error}</p> : <ThreadSkeleton />}</div>}
      <div className="chat-foot">
        <Prompts sid={id} />
        <Composer sid={id} />
      </div>
      <RemoteSheet id={id} open={remote} onClose={() => setRemote(false)} />
    </div>
  );
}

function ChatHead({
  title,
  sub,
  status,
  mark,
  tone,
  onBack,
  right,
}: {
  title: string;
  sub?: string;
  status?: string;
  mark?: React.ReactNode;
  tone?: ReturnType<typeof toneOf>;
  onBack: () => void;
  right?: React.ReactNode;
}) {
  return (
    <header className="chat-head glass-bar">
      <button type="button" className="icon-btn" aria-label="Back" onClick={() => (haptic('tap'), onBack())}>
        <Icon name="back" size={22} />
      </button>
      <div className="chat-titles">
        <div className="chat-title">
          {mark}
          <span>{title}</span>
          {tone && tone !== 'idle' && tone !== 'unread' && <StatusMark tone={tone} />}
        </div>
        <AnimatePresence mode="popLayout" initial={false}>
          {status ? (
            <motion.div key="status" className="chat-sub chat-status" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.16 }}>
              <Ring size={11} /> {status}
            </motion.div>
          ) : sub ? (
            <motion.div key="sub" className="chat-sub" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.16 }}>
              {sub}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      {right ?? <span className="icon-btn-spacer" />}
    </header>
  );
}

function Thread({ id }: { id: string }) {
  const roots = useStore((st) => sessionData(st, id).roots);
  const items = useStore((st) => sessionData(st, id).items);
  const status = useStore((st) => st.sessions[id]?.status);
  const key = shapeKey(roots, items);
  // Turn structure depends only on order and kinds: recomputed when those change, not on every streamed word.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const turns = useMemo(() => buildTurns(roots, items), [key]);
  const [count, setCount] = useState(PAGE);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const anchor = useRef<{ h: number; top: number } | null>(null);
  const live = status === 'running' || status === 'starting' || status === 'awaiting';
  const start = Math.max(0, turns.length - count);
  const shown = turns.slice(start);

  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // Stays at the newest line while it grows, unless you scrolled up to read.
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    toBottom();
    const ro = new ResizeObserver(() => {
      if (anchor.current && scroller.current) {
        const sc = scroller.current;
        sc.scrollTop = anchor.current.top + (sc.scrollHeight - anchor.current.h);
        anchor.current = null;
        return;
      }
      if (atBottom.current) toBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);

  // Only your own scrolling lets go of the newest line (a smooth jump or a growing answer never does).
  const touch = useRef({ down: false, at: 0 });
  const frame = useRef(0);
  const onScroll = () => {
    if (!frame.current) frame.current = requestAnimationFrame(measure);
  };
  // Read once per frame, not once per scroll event.
  const measure = () => {
    frame.current = 0;
    const el = scroller.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const byHand = touch.current.down || performance.now() - touch.current.at < 1200;
    if (gap < 48) atBottom.current = true;
    else if (byHand) atBottom.current = false;
    setShowJump(gap > 600);
    if (el.scrollTop < 400 && start > 0 && !anchor.current) {
      anchor.current = { h: el.scrollHeight, top: el.scrollTop };
      setCount((c) => c + PAGE);
    }
  };

  // Sending scrolls to the newest.
  const lastUser = useMemo(() => [...turns].reverse().find((t) => t.user)?.user, [turns]);
  useEffect(() => {
    atBottom.current = true;
    toBottom(true);
  }, [lastUser, toBottom]);

  return (
    <div
      className="thread"
      ref={scroller}
      onScroll={onScroll}
      onTouchStart={() => (touch.current.down = true)}
      onTouchEnd={() => (touch.current = { down: false, at: performance.now() })}
      onTouchCancel={() => (touch.current = { down: false, at: performance.now() })}
    >
      <div className="thread-content" ref={content}>
        {start > 0 && <div className="thread-more">Earlier messages</div>}
        {turns.length === 0 && <p className="empty thread-empty">Send a message to start.</p>}
        {shown.map((t, i) => (
          <TurnView key={t.user ?? `t${start + i}`} sid={id} turn={t} live={live && start + i === turns.length - 1} />
        ))}
      </div>
      <AnimatePresence>
        {showJump && (
          <motion.button
            type="button"
            className="jump glass"
            aria-label="Jump to the newest"
            initial={{ opacity: 0, y: 8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.9 }}
            onClick={() => {
              atBottom.current = true;
              toBottom(true);
            }}
          >
            <Icon name="down" size={18} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="list-skel" aria-hidden>
      <span className="skel skel-bubble" />
      <span className="skel" style={{ width: '82%' }} />
      <span className="skel" style={{ width: '64%' }} />
      <span className="skel" style={{ width: '74%' }} />
    </div>
  );
}

/** Claude's Remote Control for this chat: the link to continue on claude.ai/code, and the switch. */
function RemoteSheet({ id, open, onClose }: { id: string; open: boolean; onClose: () => void }) {
  const s = useStore((st) => st.sessions[id]);
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const on = !!s.options?.remoteControl;
  const r = s.remote;
  const toggle = async () => {
    setBusy(true);
    haptic('select');
    try {
      await conn.call('session.setOptions', { sessionId: id, options: { remoteControl: !on } });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} label="Remote control">
      <div className="remote">
        <button type="button" className="switch-row" onClick={() => void toggle()} disabled={busy} role="switch" aria-checked={on}>
          <span>Remote control</span>
          <span className="switch" data-on={on || undefined}>
            <i />
          </span>
        </button>
        {r && (
          <div className="remote-state" data-tone={r.tone ?? 'waiting'}>
            <span className="remote-state-dot" />
            <span>{r.status}</span>
          </div>
        )}
        {r?.url && (
          <>
            <div className="remote-link">{r.url}</div>
            <div className="remote-actions">
              <button type="button" className="btn btn-lg" onClick={() => void navigator.clipboard?.writeText(r.url!).then(() => haptic('success'))}>
                Copy link
              </button>
              <button type="button" className="btn btn-primary btn-lg" onClick={() => openExternal(r.url!)}>
                <Icon name="external" size={17} /> Open
              </button>
            </div>
          </>
        )}
        {r?.code && <div className="remote-code num">{r.code}</div>}
      </div>
    </Sheet>
  );
}
