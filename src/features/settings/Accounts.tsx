import { useEffect } from 'react';
import type { ProviderId } from '@shared/protocol';
import { ConnectCard } from '@/features/connect/Connect';
import { connectableAgents } from '@/features/connect/plan';
import { Icon } from '@/icons';
import { refreshLimits, setSettings } from '@/state/actions';
import { useStore } from '@/state/store';
import { Switch } from '@/ui';
import '@/features/accounts/accounts.css';

export function Accounts() {
  const providers = useStore((s) => s.providers);
  const ready = useStore((s) => s.ready);
  const carryOn = useStore((s) => !!s.settings.continueAtLimit);
  const order = connectableAgents(providers);

  // Fresh limits for every signed-in account, once per visit (and when one signs in).
  const signedIn = order.flatMap((id) => (providers[id]?.accounts ?? []).filter((a) => a.auth.loggedIn).map((a) => `${id}/${a.id}`)).join(',');
  useEffect(() => {
    if (!ready) return;
    for (const key of signedIn.split(',').filter(Boolean)) {
      const [provider, accountId] = key.split('/') as [ProviderId, string];
      void refreshLimits(provider, accountId);
    }
  }, [ready, signedIn]);

  // Only one bright button per view: the first agent waiting for a sign-in gets it.
  const firstOut = order.find((id) => providers[id]?.installed && !providers[id]?.auth.loggedIn && !providers[id]?.accounts?.some((a) => a.auth.loggedIn));

  return (
    <div className="set-stack">
      <div className="acct-list">
        {order.map((id) => (
          <ConnectCard key={id} provider={id} primary={id === firstOut} />
        ))}
      </div>
      <label className="acct-auto" data-spot>
        <span className="acct-auto-label">Continue with the next account at a limit</span>
        <Switch checked={carryOn} onChange={(v) => void setSettings({ continueAtLimit: v })} label="Continue with the next account at a limit" />
      </label>
      <p className="set-foot-note">
        <Icon name="lock" size={14} />
        <span>You sign in through each agent's own CLI in your browser: Sable never sees passwords or tokens. Each account keeps its own settings and history.</span>
      </p>
    </div>
  );
}
