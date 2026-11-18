import { useShallow } from 'zustand/react/shallow';
import type { CapabilityState, SessionOptions } from '@shared/protocol';
import { Icon, type IconName } from '@/icons';
import { useAndroidAvailable } from '@/features/rail/device-status';
import { setSessionOptions } from '@/state/actions';
import { useStore } from '@/state/store';
import { Popover, PopoverContent, PopoverTrigger, Switch, Tip } from '@/ui';

type Key = keyof SessionOptions;

const ROWS: { key: Key; icon: IconName; label: string }[] = [
  { key: 'browserTab', icon: 'globe', label: 'Browser tab' },
  { key: 'device', icon: 'device', label: 'Device' },
  { key: 'browser', icon: 'browser', label: 'Browser control' },
  { key: 'computerUse', icon: 'cursor-click', label: 'Computer use' },
  { key: 'remoteControl', icon: 'devices', label: 'Remote control' },
];

/** Whether a capability is on: Codex's plugin follows the user's own config until switched. */
export function optionOn(key: Key, options: SessionOptions | undefined, linked?: boolean, android?: boolean) {
  const v = options?.[key];
  // The agent sees Sable's own Browser tab unless switched off.
  if (key === 'browserTab') return v !== false;
  // The device tools are on where adb is, unless switched off.
  if (key === 'device') return v ?? !!android;
  return v ?? (key !== 'remoteControl' && !!linked);
}

/** The session top bar's capability switches. Hidden when the agent offers none here. */
export function CapabilitiesButton({ sessionId }: { sessionId: string }) {
  const features = useStore((s) => s.data[sessionId]?.caps?.features);
  const session = useStore(
    useShallow((s) => {
      const m = s.sessions[sessionId];
      return m ? { id: m.id, status: m.status, options: m.options, remote: m.remote, capState: m.capState } : undefined;
    }),
  );
  const android = useAndroidAvailable();
  // Every agent gets the Browser tab tools once its capabilities are known, and the device tools where adb is.
  const rows = ROWS.filter((r) => (r.key === 'browserTab' ? !!features : r.key === 'device' ? !!features && !!android : features?.[r.key]));
  if (!session || !rows.length) return null;
  const linked = !!features?.linkedBrowserComputer;
  // The dot marks capabilities switched on beyond the defaults: the Browser tab and the device are on unless switched off.
  const anyOn = rows.some((r) => r.key !== 'browserTab' && r.key !== 'device' && optionOn(r.key, session.options, linked));

  const toggle = (key: Key, on: boolean) => {
    // Codex: one plugin gives both, so they switch together.
    const patch: SessionOptions = linked && key !== 'remoteControl' && key !== 'browserTab' && key !== 'device' ? { browser: on, computerUse: on } : { [key]: on };
    void setSessionOptions(session.id, patch);
  };

  return (
    <Popover>
      <Tip label="Capabilities">
        <PopoverTrigger asChild>
          <button type="button" className="icon-btn caps-trigger" aria-label="Capabilities">
            <Icon name="capabilities" size={16} />
            {anyOn && <span className="caps-dot" aria-hidden />}
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" width={280} className="caps-pop">
        <div className="menu-label">Capabilities</div>
        {rows.map((r) => {
          const on = optionOn(r.key, session.options, linked, !!android);
          const state: CapabilityState | undefined =
            r.key === 'remoteControl' ? (session.remote ? { ...session.remote } : undefined) : r.key === 'browserTab' || r.key === 'device' ? undefined : session.capState?.[r.key as 'browser' | 'computerUse'];
          return (
            <div key={r.key} className="menu-item caps-row" data-on={on || undefined}>
              <Icon name={r.icon} size={16} />
              <div className="caps-text">
                <span className="caps-label">{r.label}</span>
                {on && state && (
                  <span className="caps-state" data-tone={state.tone}>
                    {state.status}
                  </span>
                )}
                {on && r.key === 'remoteControl' && (state?.url || state?.code) && <RemoteLink url={state.url} code={state.code} />}
              </div>
              <Switch label={r.label} checked={on} onChange={(v) => toggle(r.key, v)} />
            </div>
          );
        })}
        {session.status === 'running' && (
          <>
            <div className="menu-sep" />
            <div className="caps-foot">Changes that need a restart apply after this turn</div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function RemoteLink({ url, code }: { url?: string; code?: string }) {
  const copy = (text: string, what: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => useStore.getState().toast(`${what} copied`, 'success'))
      .catch(() => useStore.getState().toast(`Could not copy the ${what.toLowerCase()}`, 'error'));
  };
  return (
    <div className="caps-remote">
      {url && (
        <a className="caps-link truncate" href={url} target="_blank" rel="noreferrer">
          {url.replace(/^https?:\/\//, '')}
        </a>
      )}
      {code && !url && <code className="caps-code">{code}</code>}
      <Tip label={url ? 'Copy link' : 'Copy code'}>
        <button type="button" className="icon-btn caps-copy" aria-label={url ? 'Copy link' : 'Copy code'} onClick={() => copy(url ?? code!, url ? 'Link' : 'Code')}>
          <Icon name="copy" size={14} />
        </button>
      </Tip>
    </div>
  );
}
