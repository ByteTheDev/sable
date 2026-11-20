import { animate } from 'motion';
import { AnimatePresence, motion, usePresence } from 'motion/react';
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SessionMeta } from '@shared/protocol';
import { goBack, pushBack } from '@m/lib/back';
import { conn } from '@m/lib/conn';
import { haptic, inForeground, keepAlive, notify, onAppState, onBackButton, onNotificationTap, onPairLink } from '@m/lib/native';
import { chatOf, nav, routeKey, useNav, type Route } from '@m/lib/nav';
import { rowOf, takeOrigin, type Origin } from '@m/lib/open';
import { pruneComments } from '@m/lib/comments';
import { takeSwap } from '@m/lib/race';
import { closeSessionData, getState, hasCachedHome, loadCachedHome, refresh, setState, subscribeStore, useStore } from '@m/lib/store';
import '@m/lib/keyboard';
import { fieldBeat } from '@m/ui/Field';
import { Launch } from '@m/ui/Launch';
import { ProviderMark, StatusMark } from '@m/ui/marks';
import { nowOf, reduced, SNAP, SPRING } from '@m/ui/motion';
import { Home } from './screens/Home';
import { Pair } from './screens/Pair';
import { prefs, Settings } from './screens/Settings';

// The conversation (markdown, steps, composer) loads as its own chunk: home draws first, then it is fetched while idle.
const loadChat = () => import('./screens/Chat');
const Chat = lazy(() => loadChat().then((m) => ({ default: m.Chat })));
// A chat's changes and a file's diff: their own chunk, fetched after the chat's.
const loadChanges = () => import('./screens/Changes');
const ChangesScreen = lazy(() => loadChanges().then((m) => ({ default: m.ChangesScreen })));
const DiffScreen = lazy(() => loadChanges().then((m) => ({ default: m.DiffScreen })));

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
      if (ended && s.status === 'idle') {
        // The ring closes on the composer of the chat on screen (or on home's field).
        fieldBeat('done', [...document.querySelectorAll('.layer')].pop()?.querySelector('.composer') ?? document.querySelector('.home-dock'));
        if (inForeground() && chatOf(nav.stack[nav.stack.length - 1]) === s.id) haptic('select');
      }
      if (!waits && !ended) continue;
      if (waits && inForeground()) {
        // Waiting on you somewhere else than on screen: felt once, and said at the top when home is covered.
        const top = nav.stack[nav.stack.length - 1];
        if (chatOf(top) !== s.id) {
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
  // The launch plays once per start, over home (from the cache, or right after pairing).
  const [launch, setLaunch] = useState<'pending' | 'on' | 'done'>(() => (hasCachedHome() ? 'on' : 'pending'));
  const wasPairing = useRef(false);

  useEffect(() => {
    const offs = [
      conn.onOpen(() => {
        const open = nav.stack.filter((r) => r.name === 'chat').map((r) => (r as { id: string }).id);
        void refresh(open)
          .then(() => {
            nav.prune((id) => !!getState().sessions[id]);
            pruneComments((id) => !!getState().sessions[id]);
          })
          .catch(() => {});
      }),
      onAppState((active) => (active ? conn.wake() : conn.sleep())),
      onBackButton(goBack),
      pushBack(() => nav.pop()),
      onPairLink((url) => setLink(url)),
      onNotificationTap((id) => nav.chat(id)),
    ];
    const stopWatch = subscribeStore(watchTurns());
    const idle = window.setTimeout(() => void loadChat().then(() => window.setTimeout(() => void loadChanges(), 800)), 400);
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
    const open = new Set(stack.map(chatOf).filter(Boolean));
    for (const id of Object.keys(getState().data)) if (!open.has(id)) closeSessionData(id);
  }, [stack]);

  const unpaired = state === 'unpaired' || (state === 'denied' && !getState().loaded);
  const pairing = unpaired || !!link;
  // Leaving the pairing screen for home: the launch plays from the pairing mark.
  useEffect(() => {
    if (pairing) wasPairing.current = true;
    else if (wasPairing.current && ready) {
      wasPairing.current = false;
      setLaunch('on');
    } else if (ready && launch === 'pending') setLaunch('done');
  }, [pairing, ready, launch]);

  if (!ready && !link) return <div className="app" />;
  const top = stack[stack.length - 1];

  if (pairing) {
    return (
      <>
        <Pair link={link} onLinkUsed={() => setLink(null)} denied={state === 'denied' ? error : undefined} />
        <Toast />
      </>
    );
  }

  return (
    <>
      <div className="app">
        <Home under={!!top} />
        <AnimatePresence>
          {stack.map((r, i) => (
            <Layer key={routeKey(r)} route={r} index={i} covered={i < stack.length - 1}>
              <Screen route={r} />
            </Layer>
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
      </div>
      {launch === 'on' && <Launch onDone={() => setLaunch('done')} />}
      <Toast />
    </>
  );
}

/** What a layer shows. */
function Screen({ route: r }: { route: Route }) {
  if (r.name === 'settings') return <Settings />;
  if (r.name === 'chat')
    return (
      <Suspense fallback={<div className="screen chat" />}>
        <Chat id={r.id} />
      </Suspense>
    );
  return (
    <Suspense fallback={<div className="screen changes" />}>
      {r.name === 'changes' ? <ChangesScreen id={r.id} items={r.items} lead={r.lead} /> : <DiffScreen id={r.id} path={r.path} items={r.items} />}
    </Suspense>
  );
}

const W = () => window.innerWidth;
const H = () => window.innerHeight;
const inset = (o: Origin) => {
  const { top, left, width, height } = o.rect;
  return `inset(${top.toFixed(1)}px ${(W() - left - width).toFixed(1)}px ${(H() - top - height).toFixed(1)}px ${left.toFixed(1)}px round ${o.radius}px)`;
};
const FULL = 'inset(0px 0px 0px 0px round 0px)';

/**
 * A screen over home. A chat grows out of the row (or card, or field) it was opened from: its
 * window opens from that rectangle while the conversation resolves inside it, and home steps back.
 * Going back it folds into its row again when that row is on screen; otherwise screens slide.
 */
function Layer({ route, index, covered, children }: { route: Route; index: number; covered: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const plate = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [present, safeToRemove] = usePresence();
  // Taken once (a development double run of the effect must not lose it).
  const origin = useRef<Origin | null | undefined>(undefined);
  if (origin.current === undefined) origin.current = route.name === 'chat' ? takeOrigin(route.id) : null;
  // A race's rival taking this chat's place: the two slide together, as columns side by side.
  const swapIn = useRef<1 | -1 | null | undefined>(undefined);
  if (swapIn.current === undefined) swapIn.current = route.name === 'chat' ? takeSwap(route.id, 'in') : null;

  useLayoutEffect(() => {
    const el = ref.current;
    const b = body.current;
    const pl = plate.current;
    if (!el || !b || !pl) return;
    const o = origin.current;
    if (reduced()) {
      animate(el, { opacity: [0, 1] }, { duration: 0.14 });
      return;
    }
    if (o) {
      // The window opens out of what was tapped: at first it is that row (a copy of it on the card's ink),
      // then the conversation resolves inside it as it grows.
      el.dataset.grow = '';
      const ghost = place(pl, o);
      const a = animate(el, { clipPath: [inset(o), FULL] }, SPRING);
      const dy = (o.rect.top + o.rect.height / 2 - H() / 2) * 0.24;
      animate(pl, { opacity: [1, 0] }, { duration: 0.28, delay: 0.12, ease: 'easeOut' });
      if (ghost) animate(ghost, { opacity: [1, 0] }, { duration: 0.1, ease: 'easeOut' });
      animate(b, { opacity: [0, 1] }, { duration: 0.22, delay: 0.05, ease: 'easeOut' });
      animate(b, { transform: [`translateY(${dy.toFixed(1)}px) scale(0.93)`, 'translateY(0px) scale(1)'] }, SPRING);
      void a.finished.then(() =>
        // After the animation has written its last frame: no clip may stay (even a full one makes
        // the conversation's scrolling draw again every frame).
        requestAnimationFrame(() => {
          delete el.dataset.grow;
          el.style.removeProperty('clip-path');
          el.getAnimations().forEach((x) => x.cancel());
          ghost?.remove();
        }),
      );
      // The chat's field swells up as it opens (after its listeners are in).
      requestAnimationFrame(() => fieldBeat('open'));
      return;
    }
    const dir = swapIn.current ?? 1;
    animate(el, { transform: [`translateX(${dir * 100}%)`, 'translateX(0%)'] }, SPRING);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Covered by a newer screen: it steps back, as home does.
  const wasCovered = useRef(covered);
  useEffect(() => {
    const b = body.current;
    if (!b || !present || wasCovered.current === covered) return;
    wasCovered.current = covered;
    const n = nowOf(b);
    animate(b, { transform: [`scale(${n.scale})`, `scale(${covered ? 0.94 : 1})`], opacity: [n.opacity, covered ? 0.4 : 1] }, SPRING);
  }, [covered, present]);

  // The animations of a layer on its way out: the same screen opened again at once brings it back from where it is.
  const leaving = useRef<{ stop: () => void }[] | null>(null);
  useEffect(() => {
    const el = ref.current;
    const b = body.current;
    const pl = plate.current;
    if (present) {
      const going = leaving.current;
      if (!going || !el || !b || !pl) return;
      leaving.current = null;
      going.forEach((a) => a.stop());
      el.style.pointerEvents = '';
      pl.querySelectorAll('.layer-ghost').forEach((g) => g.remove());
      void animate(el, { transform: 'translateX(0%)', clipPath: FULL, opacity: 1 }, SPRING).finished.then(() => {
        delete el.dataset.grow;
        el.style.removeProperty('clip-path');
      });
      animate(b, { transform: 'translateY(0px) scale(1)', opacity: 1 }, SPRING);
      animate(pl, { opacity: 0 }, { duration: 0.12 });
      return;
    }
    if (!el || !b || !pl) return void safeToRemove();
    el.style.pointerEvents = 'none';
    const list: { stop: () => void }[] = [];
    leaving.current = list;
    const done = () => leaving.current === list && safeToRemove();
    const go = <T extends { stop: () => void }>(a: T) => (list.push(a), a);
    if (reduced()) {
      void go(animate(el, { opacity: 0 }, { duration: 0.12 })).finished.then(done);
      return;
    }
    // Replaced by its race rival: it leaves toward its own side while the rival comes in from the other.
    const swapOut = route.name === 'chat' ? takeSwap(route.id, 'out') : null;
    if (swapOut) {
      void go(animate(el, { transform: ['translateX(0%)', `translateX(${-swapOut * 100}%)`] }, SPRING)).finished.then(done);
      return;
    }
    const row = route.name === 'chat' ? rowOf(route.id) : null;
    if (row) {
      // Folds back into its row: the conversation fades as the window closes on it, the row resolves where it lands.
      el.dataset.grow = '';
      const ghost = place(pl, row);
      const fold = { ...SPRING, stiffness: 470 };
      const a = go(animate(el, { clipPath: [FULL, inset(row)] }, fold));
      const dy = (row.rect.top + row.rect.height / 2 - H() / 2) * 0.24;
      go(animate(b, { transform: ['translateY(0px) scale(1)', `translateY(${dy.toFixed(1)}px) scale(0.93)`] }, fold));
      go(animate(b, { opacity: [1, 0] }, { duration: 0.16, delay: 0.06, ease: 'easeIn' }));
      go(animate(pl, { opacity: [0, 1] }, { duration: 0.16, delay: 0.04, ease: 'easeOut' }));
      if (ghost) go(animate(ghost, { opacity: [0, 1] }, { duration: 0.12, delay: 0.16, ease: 'easeOut' }));
      void a.finished.then(done);
      return;
    }
    void go(animate(el, { transform: ['translateX(0%)', 'translateX(100%)'] }, { type: 'spring', stiffness: 520, damping: 50, restDelta: 1 })).finished.then(done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present]);

  return (
    <div ref={ref} className="layer" style={{ zIndex: 10 + index }} data-route={route.name}>
      <div ref={plate} className="layer-plate" aria-hidden />
      <div ref={body} className="layer-body">
        {children}
      </div>
    </div>
  );
}

/** A copy of what was tapped, where it was, on the plate the window opens from. */
function place(plate: HTMLElement, o: Origin): HTMLElement | null {
  if (!o.el) return null;
  const g = o.el.cloneNode(true) as HTMLElement;
  g.removeAttribute('data-chat');
  g.classList.add('layer-ghost');
  g.style.cssText = `position:absolute;margin:0;top:${o.rect.top}px;left:${o.rect.left}px;width:${o.rect.width}px;height:${o.rect.height}px;transform:none`;
  plate.appendChild(g);
  return g;
}

/** Another chat waits on you while a chat or settings covers home: one line at the top, a tap goes there. */
function Attention({ top }: { top?: Route }) {
  const attention = useStore((s) => s.attention);
  const s = useStore((st) => (attention ? st.sessions[attention.id] : undefined));
  const show = !!attention && !!s && s.status === 'awaiting' && !!top && chatOf(top) !== attention.id;
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
          className="attn-top glass-liquid"
          initial={{ opacity: 0, y: -24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -24, scale: 0.96 }}
          transition={SNAP}
          onClick={() => {
            haptic('tap');
            setState({ attention: undefined });
            nav.chat(s!.id);
          }}
        >
          <ProviderMark provider={s!.provider} size={16} />
          <span className="attn-text">
            <span className="attn-title">{s!.title}</span>
            <span className="attn-sub">
              <StatusMark tone="awaiting" size={10} /> Waiting for you
            </span>
          </span>
          <span className="attn-go">Open</span>
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
          className="toast"
          data-level={toast.level}
          initial={{ opacity: 0, y: -20, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -14, scale: 0.98 }}
          transition={SNAP}
          role="status"
        >
          {toast.level === 'success' ? <span className="toast-check" aria-hidden /> : toast.level === 'error' ? <span className="toast-dot" aria-hidden /> : null}
          <span>{toast.text}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
