import { memo, useEffect } from 'react';
import { DEFAULT_ACCOUNT } from '@shared/protocol';
import { ProviderMark } from '@/art/Logo';
import { AccountSwitcher, AddAccountDialog } from '@/features/accounts';
import { connectableAgents, isSignedIn } from '@/features/connect/plan';
import { Icon } from '@/icons';
import { openSettings, refreshLimits } from '@/state/actions';
import { useFocusAccount } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton } from '@/ui';
import './footer.css';

const REFRESH_MS = 4 * 60_000;

/**
 * One quiet row: who is signed in (it opens the accounts, each with its limits) and Settings.
 * The limits themselves live in that menu; the row only marks an account near or at a cap.
 */
export const SidebarFooter = memo(function SidebarFooter() {
  useLimitRefresh();
  return (
    <div className="side-foot">
      <Account />
      <AddAccountDialog />
    </div>
  );
});

/** Keeps the account in focus's limits fresh while the window is visible, so the row's limit mark is current. */
function useLimitRefresh() {
  const { provider, accountId } = useFocusAccount();
  const ready = useStore((s) => s.ready);
  const connected = useStore((s) => {
    const p = s.providers[provider];
    const a = p?.accounts?.find((x) => x.id === accountId);
    return !!(a ? a.auth.loggedIn : accountId === DEFAULT_ACCOUNT && p?.auth.loggedIn);
  });

  useEffect(() => {
    if (!ready || !connected) return;
    const refresh = () => void refreshLimits(provider, accountId);
    refresh();
    let timer = 0;
    const arm = () => {
      window.clearInterval(timer);
      if (document.visibilityState === 'visible') timer = window.setInterval(refresh, REFRESH_MS);
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') refresh();
      arm();
    };
    arm();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [provider, accountId, ready, connected]);
}

function Account() {
  const providers = useStore((s) => s.providers);
  const { provider: active } = useFocusAccount();
  const ready = useStore((s) => s.ready);

  const connected = connectableAgents(providers).filter((id) => isSignedIn(providers[id]));

  if (!ready) return <div className="account" aria-hidden />;
  // An agent without an account to connect still shows while it is the one in focus.
  if (!connected.includes(active) && isSignedIn(providers[active])) connected.push(active);
  if (!connected.length) {
    return (
      <div className="account">
        <button type="button" className="connect" onClick={() => openSettings('accounts')}>
          <span className="connect-marks" aria-hidden>
            <ProviderMark provider="claude" size={13} />
            <ProviderMark provider="codex" size={13} />
          </span>
          <span className="connect-title grow truncate">Connect an agent</span>
          <Icon name="arrow-right" size={14} className="connect-arrow" />
        </button>
        <IconButton icon="settings" label="Settings" keys="mod+," tipSide="top" onClick={() => openSettings()} />
      </div>
    );
  }

  return (
    <div className="account">
      <AccountSwitcher />
      <IconButton icon="settings" label="Settings" keys="mod+," tipSide="top" onClick={() => openSettings()} />
    </div>
  );
}
