import { AnimatePresence, motion } from 'motion/react';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { SessionMeta } from '@shared/protocol';
import { goBack, pushBack } from '@m/lib/back';
import { conn } from '@m/lib/conn';
import { haptic, inForeground, keepAlive, notify, onAppState, onBackButton, onNotificationTap, onPairLink } from '@m/lib/native';
import { nav, useNav } from '@m/lib/nav';
import { closeSessionData, getState, hasCachedHome, loadCachedHome, refresh, setState, subscribeStore, useStore } from '@m/lib/store';
import { StatusMark } from '@m/ui/marks';
import { SPRING } from '@m/ui/Sheet';
import { fieldBeat } from '@m/ui/Field';
import { Home } from './screens/Home';
import { Pair } from './screens/Pair';
import { prefs, Settings } from './screens/Settings';

// The conversation (markdown, steps, composer) loads as its own chunk: home draws first, then it is fetched while idle.
const loadChat = () => import('./screens/Chat');
const Chat = lazy(() => loadChat().then((m) => ({ default: m.Chat })));

/** Notifies when a turn ends or starts waiting on you while the app is in the background. */
function watchTurns() {
  let last: Record<string, SessionMeta['status']> = {};
  let seeded = false;
  let prev = getState().sessions;
  let listAt = getState().listAt;
  return () => {
    const { sessions } = getState();
    if (sessions === prev) return;
    prev = sessions;
    // A whole new list on screen (a reconnect after time away): what changed meanwhile is not news (no
    // wave, no haptic); it seeds again. In the background it still is: the phone was following.
    if (getState().listAt !== listAt) {
      listAt = getState().listAt;
      if (inForeground()) seeded = false;
    }
    const next: typeof last = {};
    for (const s of Object.values(sessions)) {
      next[s.id] = s.status;
      const was = last[s.id];
      if (!seeded || !was || was === s.status) continue;
      const ended = (was === 'running' || was === 'awaiting') && (s.status === 'idle' || s.status === 'error');
      const waits = s.status === 'awaiting' && was !== 'awaiting';
      if (ended && s.status === 'idle') fieldBeat('done');
      if (!waits && !ended) continue;
      if (waits && inForeground()) {
        // Waiting on you somewhere else than on screen: felt once, and said at the top when home is covered.
        const top = nav.stack[nav.stack.length - 1];
        if (!(top?.name === 'chat' && top.id === s.id)) {
          haptic('warning');
          if (top) setState({ attention: { id: s.id, at: Date.now() } });
        }
      }
      if (inForeground() || !prefs.notify) continue;
      if (waits) void notify(s.title, 'Waiting for you', s.id);
      else if (ended) void notify(s.title, s.status === 'error' ? (s.lastError ?? 'Stopped with an error') : 'Done', s.id);
    }
    last = next;
    seeded = true;
    // Something at work: the connection stays when the app leaves the screen (to say when it ends or waits).
    const busy = Object.values(sessions).filter((s) => !s.archived && (s.status === 'running' || s.status === 'starting' || s.status === 'awaiting'));
    keepAlive(prefs.notify && busy.length && getState().conn !== 'unpaired' ? (busy.length === 1 ? busy[0].title : `${busy.length} chats`) : null);
  };
}

export function App() {
  const state = useStore((s) => s.conn);
  const error = useStore((s) => s.connError);
  const stack = useNav();
  const [link, setLink] = useState<string | null>(null);
  // The list from the last run draws in the first frame (read synchronously); without one, nothing is drawn
  // until the saved pairing is read (a few ms), so no pairing screen flashes at a cold start.
  const [ready, setReady] = useState(() => {
    if (!hasCachedHome()) return false;
    loadCachedHome();
    nav.restore();
    return true;
  });

  useEffect(() => {
    const offs = [
      conn.onOpen(() => {
        const open = nav.stack.filter((r) => r.name === 'chat').map((r) => (r as { id: string }).id);
        void refresh(open)
          .then(() => nav.prune((id) => !!getState().sessions[id]))
          .catch(() => {});
      }),
      onAppState((active) => (active ? conn.wake() : conn.sleep())),
      onBackButton(goBack),
      pushBack(() => nav.pop()),
      onPairLink((url) => setLink(url)),
      onNotificationTap((id) => nav.chat(id)),
    ];
    const stopWatch = subscribeStore(watchTurns());
    const idle = window.setTimeout(() => void loadChat(), 400);
    // Back where it was: Android may have closed the app in the background.
    void conn.init().then(() => {
      // The list of chats as it was last time, at once; the desktop's answer replaces it.
      if (conn.pairing) loadCachedHome(), nav.restore();
      setReady(true);
    });
    return () => {
      offs.forEach((f) => f());
      stopWatch();
      clearTimeout(idle);
    };
  }, []);

  // Data for chats that are no longer on screen is dropped (the snapshot reloads it).
  useEffect(() => {
    const open = new Set(stack.filter((r) => r.name === 'chat').map((r) => (r as { id: string }).id));
    for (const id of Object.keys(getState().data)) if (!open.has(id)) closeSessionData(id);
  }, [stack]);

  const unpaired = state === 'unpaired' || (state === 'denied' && !getState().loaded);
  if (!ready && !link) return <div className="app" />;
  const top = stack[stack.length - 1];

  if (unpaired || link) {
    return (
      <>
        <Pair
          link={link}
          onLinkUsed={() => setLink(null)}
          denied={state === 'denied' ? error : undefined}
        />
        <Toast />
      </>
    );
  }

  return (
    <div className="app">
      <Home under={!!top} />
      <AnimatePresence>
        {stack.map((r, i) => (
          <motion.div
            key={r.name === 'chat' ? `chat:${r.id}` : r.name}
            className="layer"
            style={{ zIndex: 10 + i }}
            initial={{ x: '100%' }}
            animate={{ x: i === stack.length - 1 ? 0 : '-18%' }}
            exit={{ x: '100%', transition: { type: 'spring', stiffness: 520, damping: 48 } }}
            transition={SPRING}
          >
            {r.name === 'chat' ? (
              <Suspense fallback={<div className="screen chat" />}>
                <Chat id={r.id} />
              </Suspense>
            ) : (
              <Settings />
            )}
          </motion.div>
        ))}
      </AnimatePresence>
      <Attention top={top} />
      {state === 'denied' && (
        <div className="banner glass" role="alert">
          <span>{error ?? 'This phone is no longer allowed'}</span>
          <button type="button" className="btn btn-sm" onClick={() => void conn.forget()}>
            Pair again
          </button>
        </div>
      )}
      <Toast />
    </div>
  );
}

/** Another chat waits on you while a chat or settings covers home: one line at the top, a tap goes there. */
function Attention({ top }: { top?: { name: string; id?: string } }) {
  const attention = useStore((s) => s.attention);
  const s = useStore((st) => (attention ? st.sessions[attention.id] : undefined));
  const show = !!attention && !!s && s.status === 'awaiting' && !!top && !(top.name === 'chat' && top.id === attention.id);
  useEffect(() => {
    if (!attention) return;
    const t = setTimeout(() => setState({ attention: undefined }), 7000);
    return () => clearTimeout(t);
  }, [attention]);
  return (
    <AnimatePresence>
      {show && (
        <motion.button
          key={attention!.at}
          type="button"
          className="attn-top waiting glass"
          initial={{ opacity: 0, y: -14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -14 }}
          transition={SPRING}
          onClick={() => {
            haptic('tap');
            setState({ attention: undefined });
            nav.chat(s!.id);
          }}
        >
          <StatusMark tone="awaiting" />
          <span className="attn-text">
            <span className="attn-title">{s!.title}</span>
            <span className="attn-sub">Waiting for you</span>
          </span>
          <span className="waiting-go">Open</span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}

function Toast() {
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setState({ toast: undefined }), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <AnimatePresence>
      {toast && (
        <motion.div
          key={toast.at}
          className="toast glass"
          data-level={toast.level}
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={SPRING}
          role="status"
        >
          {toast.text}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
