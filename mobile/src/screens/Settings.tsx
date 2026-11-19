import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { conn } from '@m/lib/conn';
import { askNotifications, haptic, isNative, loadPref, notificationsAllowed, savePref } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { useStore } from '@m/lib/store';
import { Field, paletteFor } from '@m/ui/Field';
import { Icon } from '@m/ui/icons';
import { LogoMark, Ring } from '@m/ui/marks';
import { SNAP } from '@m/ui/motion';
import { Sheet } from '@m/ui/Sheet';

export const prefs = { notify: true };
void loadPref('notify', true).then((v) => (prefs.notify = v));

/** The paired computer, notifications, and forgetting the computer. */
export function Settings() {
  const desktop = useStore((s) => s.desktop);
  const state = useStore((s) => s.conn);
  const version = useStore((s) => s.version);
  const defaultProvider = useStore((s) => s.settings?.defaultProvider);
  const [notify, setNotify] = useState(prefs.notify);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState(false);
  const p = conn.pairing;
  const name = desktop ?? p?.desktop ?? 'Desktop';

  useEffect(() => {
    void notificationsAllowed().then(setAllowed);
  }, []);

  const toggleNotify = async () => {
    haptic('select');
    const next = !notify;
    if (next && !allowed) {
      const ok = await askNotifications();
      setAllowed(ok);
      if (!ok) return;
    }
    setNotify(next);
    prefs.notify = next;
    savePref('notify', next);
  };

  const stateWord = state === 'open' ? 'Connected' : state === 'connecting' ? 'Connecting' : state === 'denied' ? 'Not allowed' : 'Offline';

  return (
    <div className="screen settings">
      <header className="sub-head">
        <button type="button" className="icon-btn back-btn" aria-label="Back" onClick={() => (haptic('tap'), nav.pop())}>
          <Icon name="back" size={22} />
        </button>
        <span className="sub-head-title">Settings</span>
        <span className="icon-btn-spacer" />
      </header>
      <div className="settings-scroll">
        <h1 className="page-title">Settings</h1>

        {/* The paired computer: a window onto its field, its name, how it is reached. */}
        <section className="computer" data-state={state}>
          <Field palette={paletteFor(defaultProvider)} amount={1} focusX={0.78} focusY={1.25} spread={0.9} className="computer-field" />
          <div className="computer-top">
            <span className="computer-glyph">
              <Icon name="desktop" size={22} />
            </span>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={stateWord} className="computer-state" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={SNAP}>
                {state === 'connecting' ? <Ring size={11} /> : <i className="conn-dot" />}
                {stateWord}
              </motion.span>
            </AnimatePresence>
          </div>
          <div className="computer-name">{name}</div>
          {p && <div className="computer-addr num">{`${p.lastHost ?? p.hosts[0]}:${p.port}`}</div>}
        </section>

        {isNative && (
          <>
            <h3 className="set-title">Notifications</h3>
            <div className="group-card">
              <button type="button" className="set-row switch-row" role="switch" aria-checked={notify && !!allowed} onClick={() => void toggleNotify()}>
                <Icon name="bell" size={19} />
                <span className="set-label">When a turn ends or waits for you</span>
                <span className="switch" data-on={(notify && !!allowed) || undefined}>
                  <i />
                </span>
              </button>
            </div>
          </>
        )}

        <h3 className="set-title">About</h3>
        <div className="group-card">
          <div className="set-row">
            <LogoMark size={17} className="set-logo" />
            <span className="set-label">Sable on {name}</span>
            <span className="set-val num">{version ?? '–'}</span>
          </div>
        </div>

        <div className="group-card set-danger">
          <button type="button" className="set-row" onClick={() => (haptic('tap'), setConfirm(true))}>
            <Icon name="x" size={19} />
            <span className="set-label">Forget this computer</span>
          </button>
        </div>
      </div>

      <Sheet open={confirm} onClose={() => setConfirm(false)} label="Forget this computer">
        <div className="confirm">
          <h2 className="confirm-title">Forget {name} on this phone?</h2>
          <p className="confirm-sub">You will need to scan its code again.</p>
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            onClick={() => {
              haptic('warning');
              setConfirm(false);
              nav.reset();
              void conn.forget();
            }}
          >
            Forget
          </button>
          <button type="button" className="btn btn-lg btn-block btn-ghost" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      </Sheet>
    </div>
  );
}
