import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { baseName } from '@desk/lib/format';
import { conn } from '@m/lib/conn';
import { onKeyboard } from '@m/lib/keyboard';
import { haptic, openExternal } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { applyOlder, fetchOlder, getState, openSession, sessionData, showCached, useStore } from '@m/lib/store';
import { buildTurns, reuseTurns, shapeKey, type Turn } from '@m/lib/turns';
import { Field, paletteFor } from '@m/ui/Field';
import { Icon } from '@m/ui/icons';
import { ProviderMark, Ring } from '@m/ui/marks';
import { IME_EASE, SNAP } from '@m/ui/motion';
import { Sheet } from '@m/ui/Sheet';
import { Composer } from './Composer';
import { Prompts } from './Prompts';
import { TurnView } from './Timeline';

const PAGE = 24;
const FIRST = 5;

/** A conversation: header, turns (the newest ones mounted, older ones as you scroll up), composer. */
export function Chat({ id }: { id: string }) {
  const s = useStore((st) => st.sessions[id]);
  const loaded = useStore((st) => !!st.data[id]);
  const listed = useStore((st) => !!st.fresh);
  const connState = useStore((st) => st.conn);
  const desktop = useStore((st) => st.desktop);
  const [error, setError] = useState<string>();
  const [remote, setRemote] = useState(false);

  // The newest page as the phone last had it shows at once; the desktop's follows.
  useLayoutEffect(() => {
    setError(undefined);
    showCached(id);
    // A connection replaced meanwhile loads it again by itself (the skeleton stays).
    if (getState().conn === 'open') void openSession(id).catch((err) => !/connection to the desktop was lost/i.test((err as Error).message) && setError((err as Error).message));
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
  const waiting = s.status === 'awaiting';
  const remoteOn = !!s.options?.remoteControl || !!s.remote;

  return (
    <div className="screen chat" data-live={live || undefined} data-waiting={waiting || undefined}>
      <Field palette={paletteFor(s.provider)} amount={0.95} focusY={1.1} spread={0.56} active={live} waiting={waiting} />
      <ChatHead
        title={s.title}
        sub={connState === 'open' ? (s.chat ? undefined : baseName(s.cwd)) : undefined}
        status={connState === 'open' ? undefined : connState === 'denied' ? 'Not paired' : listed ? 'Reconnecting' : 'Connecting'}
        mark={<ProviderMark provider={s.provider} size={16} />}
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
      {loaded ? (
        <Thread id={id} />
      ) : (
        <div className="thread-skel">
          {error ? <p className="empty">{error}</p> : connState === 'offline' ? <p className="empty">This chat opens when {desktop ?? 'the computer'} is back.</p> : <ThreadSkeleton />}
        </div>
      )}
      <div className="chat-foot">
        <Prompts sid={id} />
        <Composer sid={id} />
      </div>
      <RemoteSheet id={id} open={remote} onClose={() => setRemote(false)} />
    </div>
  );
}

function ChatHead({ title, sub, status, mark, onBack, right }: { title: string; sub?: string; status?: string; mark?: React.ReactNode; onBack: () => void; right?: React.ReactNode }) {
  return (
    <header className="chat-head">
      <button type="button" className="icon-btn back-btn" aria-label="Back" onClick={() => (haptic('tap'), onBack())}>
        <Icon name="back" size={22} />
      </button>
      <div className="chat-titles">
        <div className="chat-title">
          {mark}
          <span>{title}</span>
        </div>
        <AnimatePresence mode="popLayout" initial={false}>
          {status ? (
            <motion.div key="status" className="chat-sub chat-status" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={SNAP}>
              <Ring size={11} /> {status}
            </motion.div>
          ) : sub ? (
            <motion.div key="sub" className="chat-sub" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={SNAP}>
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
  const cursor = useStore((st) => sessionData(st, id).cursor);
  const key = shapeKey(roots, items);
  // Turn structure depends only on order and kinds: recomputed when those change, not on every streamed word.
  // Turns that did not change keep their object, so their rows do not render again.
  const prevTurns = useRef<Turn[]>([]);
  const turns = useMemo(() => {
    const t = reuseTurns(buildTurns(roots, items), prevTurns.current);
    prevTurns.current = t;
    return t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const [older, setOlder] = useState(false);
  const olderBusy = useRef(false);
  // The newest few turns first (the chat opens at once), the rest of the page right after it has opened.
  const [count, setCount] = useState(FIRST);
  useEffect(() => {
    const t = window.setTimeout(() => setCount((c) => Math.max(c, PAGE)), 520);
    return () => clearTimeout(t);
  }, []);
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
      // A short page that does not fill the screen: the one before it comes at once.
      const sc = scroller.current;
      if (sc && sc.scrollHeight < sc.clientHeight + 400) olderRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);

  // The keyboard: the room it takes is added under the newest line, and (when reading the newest)
  // the conversation glides up with it on its curve instead of jumping.
  useEffect(
    () =>
      onKeyboard((lift, prev, ms) => {
        const sc = scroller.current;
        const c = content.current;
        if (!sc || !c) return;
        c.style.paddingBottom = lift ? `${lift + 28}px` : '';
        if (!atBottom.current) return;
        const before = sc.scrollTop;
        sc.scrollTop = sc.scrollHeight;
        const d = sc.scrollTop - before;
        if (d && ms > 0) c.animate([{ transform: `translate3d(0, ${d}px, 0)` }, { transform: 'none' }], { duration: ms, easing: `cubic-bezier(${IME_EASE.join(',')})` });
        void prev;
      }),
    [],
  );

  // Only your own scrolling lets go of the newest line (a smooth jump or a growing answer never does).
  const touch = useRef({ down: false, at: 0 });
  const frame = useRef(0);
  // While the conversation moves, the prompt bar drops its blur (drawn again every frame otherwise); at rest it is glass again.
  const moving = useRef(0);
  const onScroll = () => {
    if (!frame.current) frame.current = requestAnimationFrame(measure);
    const chat = scroller.current?.parentElement;
    if (!chat) return;
    if (!moving.current) chat.setAttribute('data-moving', '');
    clearTimeout(moving.current);
    moving.current = window.setTimeout(() => {
      moving.current = 0;
      chat.removeAttribute('data-moving');
    }, 200);
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
    if (el.scrollTop < 600 && !anchor.current) {
      if (start > 0) {
        anchor.current = { h: el.scrollHeight, top: el.scrollTop };
        setCount((c) => c + PAGE);
      } else olderRef.current();
    }
  };

  // Scrolling up past what the phone holds asks the desktop for the page before (kept in place: no jump).
  const loadOlder = () => {
    if (olderBusy.current || !cursor || start > 0) return;
    olderBusy.current = true;
    setOlder(true);
    void fetchOlder(id)
      .then((pages) => {
        const sc = scroller.current;
        if (!pages.length || !sc) return;
        const a = (anchor.current = { h: sc.scrollHeight, top: sc.scrollTop });
        let added = 0;
        for (const r of pages) {
          applyOlder(id, r);
          added += r.page.items.length;
        }
        setCount((c) => c + added);
        // Steps that went into a folded line add no height: then nothing moves and the next scroll may ask again.
        requestAnimationFrame(() => requestAnimationFrame(() => anchor.current === a && (anchor.current = null)));
      })
      .catch(() => {})
      .finally(() => {
        olderBusy.current = false;
        setOlder(false);
      });
  };
  const olderRef = useRef(loadOlder);
  olderRef.current = loadOlder;

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
        {(start > 0 || cursor) && (
          <div className="thread-more" aria-busy={older || undefined}>
            {older ? <Ring size={13} /> : <span className="thread-more-line" />}
          </div>
        )}
        {turns.length === 0 && <p className="empty thread-empty">Send a message to start.</p>}
        {shown.map((t, i) => (
          <TurnView key={t.user ?? `t${start + i}`} sid={id} turn={t} live={live && start + i === turns.length - 1} />
        ))}
      </div>
      <AnimatePresence>
        {showJump && (
          <motion.button
            type="button"
            className="jump"
            aria-label="Jump to the newest"
            initial={{ opacity: 0, y: 10, scale: 0.85 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.85 }}
            transition={SNAP}
            whileTap={{ scale: 0.9 }}
            onClick={() => {
              haptic('tap');
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
    <div className="thread-skel-body" aria-hidden>
      <span className="skel skel-bubble" />
      <span className="skel skel-line" style={{ width: '42%' }} />
      <span className="skel" style={{ width: '88%' }} />
      <span className="skel" style={{ width: '76%' }} />
      <span className="skel" style={{ width: '82%' }} />
      <span className="skel" style={{ width: '54%' }} />
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
        <div className="group-card">
          <button type="button" className="set-row switch-row" onClick={() => void toggle()} disabled={busy} role="switch" aria-checked={on}>
            <Icon name="link" size={19} />
            <span className="set-label">Remote control</span>
            <span className="switch" data-on={on || undefined}>
              <i />
            </span>
          </button>
          {r && (
            <div className="set-row remote-state" data-tone={r.tone ?? 'waiting'}>
              <span className="remote-state-dot" />
              <span className="set-label">{r.status}</span>
            </div>
          )}
        </div>
        {r?.url && (
          <>
            <div className="remote-link">{r.url}</div>
            <div className="remote-actions">
              <button type="button" className="btn btn-lg" onClick={() => void navigator.clipboard?.writeText(r.url!).then(() => haptic('success'))}>
                <Icon name="copy" size={18} /> Copy link
              </button>
              <button type="button" className="btn btn-primary btn-lg" onClick={() => openExternal(r.url!)}>
                <Icon name="external" size={18} /> Open
              </button>
            </div>
          </>
        )}
        {r?.code && <div className="remote-code num">{r.code}</div>}
      </div>
    </Sheet>
  );
}
