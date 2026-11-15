import { useEffect } from 'react';
import type { ProviderId } from '@shared/protocol';
import { ConnectCard } from '@/features/connect/Connect';
import { connectableAgents } from '@/features/connect/plan';
import { Icon } from '@/icons';
import { refreshLimits } from '@/state/actions';
import { useStore } from '@/state/store';

export function Accounts() {
  const providers = useStore((s) => s.providers);
  const ready = useStore((s) => s.ready);
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
      <p className="set-foot-note">
        <Icon name="lock" size={14} />
        <span>Sign-in happens in your browser through each agent's own CLI, so Sable never sees your password or tokens. Every account you add is a separate profile with its own settings and history.</span>
      </p>
    </div>
  );
}
