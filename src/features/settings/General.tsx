import { useEffect, useState } from 'react';
import type { ProviderId, SessionOptions } from '@shared/protocol';
import { Icon } from '@/icons';
import { setDefaultSessionOptions, setSettings } from '@/state/actions';
import { useStore } from '@/state/store';
import { Kbd, Segmented, Switch } from '@/ui';
import { Card, ProviderLabel, Row, useInstalled } from './parts';

export function General() {
  const settings = useStore((s) => s.settings);
  const installed = useInstalled();

  return (
    <div className="set-stack">
      <Card>
        {installed.length > 1 && (
          <Row label="Default agent">
            <Segmented<ProviderId>
              id="set-default-provider"
              value={settings.defaultProvider}
              onChange={(defaultProvider) => setSettings({ defaultProvider })}
              options={installed.map((p) => ({ value: p, label: <ProviderLabel provider={p} /> }))}
            />
          </Row>
        )}
        <Row
          label="Send with Enter"
          help={
            settings.sendWithEnter ? (
              <>
                <Kbd combo="shift+enter" /> starts a new line.
              </>
            ) : (
              <>
                <Kbd combo="mod+enter" /> sends, <Kbd combo="enter" /> starts a new line.
              </>
            )
          }
        >
          <Switch label="Send with Enter" checked={settings.sendWithEnter} onChange={(sendWithEnter) => setSettings({ sendWithEnter })} />
        </Row>
        <Row label="Show thinking">
          <Switch label="Show thinking" checked={settings.showThinking} onChange={(showThinking) => setSettings({ showThinking })} />
        </Row>
        <Row label="Short answers" help="The outcome first, and a localhost link when there is something to preview.">
          <Switch label="Short answers" checked={settings.conciseReplies !== false} onChange={(conciseReplies) => setSettings({ conciseReplies })} />
        </Row>
        <Row label="Generative UI">
          <Switch label="Generative UI" checked={settings.generativeUi !== false} onChange={(generativeUi) => setSettings({ generativeUi })} />
        </Row>
        <NotifyRow on={settings.notifyOnDone} />
      </Card>
      <SessionDefaults />
    </div>
  );
}

const CAPS: { key: keyof SessionOptions; label: string; help: string }[] = [
  { key: 'browser', label: 'Browser control', help: 'Claude in Chrome, or the Codex app’s browser plugin.' },
  { key: 'computerUse', label: 'Computer use', help: 'Where the agent offers it. Codex switches it with browser control.' },
  { key: 'remoteControl', label: 'Remote control', help: 'Continue sessions from claude.ai/code or another device.' },
];

/** What new sessions start with, per agent, and whether the agent starts before the first send. */
function SessionDefaults() {
  const settings = useStore((s) => s.settings);
  const installed: ProviderId[] = useInstalled().filter((p) => p !== 'demo');
  const [provider, setProvider] = useState<ProviderId>(() => (installed.includes(settings.defaultProvider) ? settings.defaultProvider : (installed[0] ?? 'claude')));
  const opts = settings.sessionOptions?.[provider] ?? {};
  // Codex: absent means its own config decides (its plugin is on when installed).
  const on = (key: keyof SessionOptions) => opts[key] ?? (provider === 'codex' && key !== 'remoteControl');

  return (
    <Card
      title="New sessions"
      aside={
        installed.length > 1 ? (
          <Segmented<ProviderId> id="set-caps-provider" value={provider} onChange={setProvider} options={installed.map((p) => ({ value: p, label: <ProviderLabel provider={p} /> }))} />
        ) : undefined
      }
    >
      {CAPS.map((c) => (
        <Row key={c.key} label={c.label} help={c.help}>
          <Switch
            label={c.label}
            checked={on(c.key)}
            onChange={(v) => void setDefaultSessionOptions(provider, provider === 'codex' && c.key !== 'remoteControl' ? { browser: v, computerUse: v } : { [c.key]: v })}
          />
        </Row>
      ))}
      <Row label="Start the agent early" help="Starts it while you type on the home screen, so the first reply comes sooner. Sends nothing.">
        <Switch label="Start the agent early" checked={settings.prewarm !== false} onChange={(prewarm) => setSettings({ prewarm })} />
      </Row>
    </Card>
  );
}

type Perm = NotificationPermission | 'unsupported';

const readPerm = (): Perm => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

function NotifyRow({ on }: { on: boolean }) {
  const [perm, setPerm] = useState<Perm>(readPerm);

  useEffect(() => {
    // The permission can change in the browser's site settings while Sable is open.
    const onFocus = () => setPerm(readPerm());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const toggle = async (next: boolean) => {
    void setSettings({ notifyOnDone: next });
    if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') await ask();
  };

  const ask = async () => {
    try {
      setPerm(await Notification.requestPermission());
    } catch {
      setPerm(readPerm());
    }
  };

  const problem = !on
    ? null
    : perm === 'denied'
      ? 'Your browser blocks notifications from Sable. Allow them in the site settings.'
      : perm === 'unsupported'
        ? 'This browser cannot show notifications.'
        : perm === 'default'
          ? 'Your browser has not allowed notifications from Sable yet.'
          : null;

  return (
    <>
      <Row label="Notify when a turn finishes" help="While Sable is in the background.">
        <Switch label="Notify when a turn finishes" checked={on} onChange={(v) => void toggle(v)} />
      </Row>
      {problem && (
        <div className="set-note" data-tone="amber" role="status">
          <Icon name="warning" size={15} />
          <span className="grow">{problem}</span>
          {perm === 'default' && (
            <button type="button" className="btn btn-sm" onClick={() => void ask()}>
              Allow
            </button>
          )}
        </div>
      )}
    </>
  );
}
