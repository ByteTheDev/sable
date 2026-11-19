import { useEffect, useState } from 'react';
import { conn } from '@m/lib/conn';
import { askNotifications, haptic, isNative, loadPref, notificationsAllowed, savePref } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { useStore } from '@m/lib/store';
import { Icon } from '@m/ui/icons';
import { LogoMark } from '@m/ui/marks';

export const prefs = { notify: true };
void loadPref('notify', true).then((v) => (prefs.notify = v));

/** The paired computer, notifications, and forgetting the computer. */
export function Settings() {
  const desktop = useStore((s) => s.desktop);
  const state = useStore((s) => s.conn);
  const version = useStore((s) => s.version);
  const [notify, setNotify] = useState(prefs.notify);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState(false);
  const p = conn.pairing;

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

  return (
    <div className="screen settings">
      <header className="chat-head glass-bar">
        <button type="button" className="icon-btn" aria-label="Back" onClick={() => (haptic('tap'), nav.pop())}>
          <Icon name="back" size={22} />
        </button>
        <div className="chat-titles">
          <div className="chat-title">
            <span>Settings</span>
          </div>
        </div>
        <span className="icon-btn-spacer" />
      </header>
      <div className="settings-scroll">
        <h3 className="set-title">Computer</h3>
        <div className="set-card">
          <div className="set-row">
            <Icon name="desktop" size={19} />
            <span className="set-label">{desktop ?? p?.desktop ?? 'Desktop'}</span>
            <span className="set-val" data-state={state}>
              <i className="conn-dot" />
              {state === 'open' ? 'Connected' : state === 'connecting' ? 'Connecting' : state === 'denied' ? 'Not allowed' : 'Offline'}
            </span>
          </div>
          {p && (
            <div className="set-row">
              <Icon name="link" size={19} />
              <span className="set-label">Address</span>
              <span className="set-val num">{`${p.lastHost ?? p.hosts[0]}:${p.port}`}</span>
            </div>
          )}
          {version && (
            <div className="set-row">
              <LogoMark size={17} className="set-logo" />
              <span className="set-label">Sable</span>
              <span className="set-val num">{version}</span>
            </div>
          )}
        </div>

        {isNative && (
          <>
            <h3 className="set-title">Notifications</h3>
            <div className="set-card">
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

        <div className="set-card set-danger">
          {confirm ? (
            <div className="set-confirm">
              <span>Forget {desktop ?? 'this computer'} on this phone?</span>
              <div className="set-confirm-actions">
                <button type="button" className="btn" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    haptic('warning');
                    nav.reset();
                    void conn.forget();
                  }}
                >
                  Forget
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="set-row" onClick={() => setConfirm(true)}>
              <Icon name="x" size={19} />
              <span className="set-label">Forget this computer</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
