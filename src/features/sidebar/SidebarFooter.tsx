import { memo, useEffect, type CSSProperties } from 'react';
import { DEFAULT_ACCOUNT, type RateLimit } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { AccountSwitcher, AddAccountDialog } from '@/features/accounts';
import { connectableAgents, isSignedIn } from '@/features/connect/plan';
import { Icon } from '@/icons';
import { resetIn } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { openSettings, refreshLimits } from '@/state/actions';
import { useAccountLimits, useFocusAccount } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton } from '@/ui';
import './footer.css';

const REFRESH_MS = 4 * 60_000;

/** Usage limits for the account in focus, then who is signed in. */
export const SidebarFooter = memo(function SidebarFooter() {
  return (
    <div className="side-foot">
      <Usage />
      <Account />
      <AddAccountDialog />
    </div>
  );
});

function Usage() {
  const { provider, accountId } = useFocusAccount();
  const ready = useStore((s) => s.ready);
  const connected = useStore((s) => {
    const p = s.providers[provider];
    const a = p?.accounts?.find((x) => x.id === accountId);
    return !!(a ? a.auth.loggedIn : accountId === DEFAULT_ACCOUNT && p?.auth.loggedIn);
  });
  const limits = useAccountLimits(provider, accountId);

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

  if (!connected || !limits?.length) return null;
  return (
    <div className="usage" aria-label={`${PROVIDER_NAME[provider]} usage`}>
      {limits.map((l) => (
        <LimitRow key={l.id} limit={l} />
      ))}
    </div>
  );
}

function LimitRow({ limit }: { limit: RateLimit }) {
  const now = useNow();
  const pct = Math.max(0, Math.min(100, limit.percent));
  const level = pct > 95 ? 'red' : pct > 80 ? 'amber' : undefined;
  const reset = resetIn(limit.resetsAt, now);
  return (
    <div className="limit" data-level={level} tabIndex={0} aria-label={`${limit.label}: ${Math.round(pct)}% used${reset ? `, resets in ${reset}` : ''}`}>
      <div className="limit-top">
        <span className="limit-label truncate">{limit.label}</span>
        <span className="limit-val num">
          {reset && <span className="limit-reset">Resets in {reset}</span>}
          <span className="limit-pct">{Math.round(pct)}%</span>
        </span>
      </div>
      <span className="limit-track meter" data-level={level}>
        <span className="meter-fill" style={{ '--p': pct / 100 } as CSSProperties} />
      </span>
    </div>
  );
}

/** Who is signed in: the plan first ("Max plan"), the account's name after it when there are several. */
function Account() {
  const providers = useStore((s) => s.providers);
  const { provider: active } = useFocusAccount();
  const ready = useStore((s) => s.ready);

  const connected = connectableAgents(providers).filter((id) => isSignedIn(providers[id]));
  const openAccounts = () => openSettings('accounts');

  if (!ready) return null;
  // An agent without an account to connect still shows while it is the one in focus.
  if (!connected.includes(active) && isSignedIn(providers[active])) connected.push(active);
  if (!connected.length) {
    return (
      <div className="account">
        <button type="button" className="connect" data-spot onClick={openAccounts}>

          <span className="connect-marks" aria-hidden>
            <ProviderMark provider="claude" size={13} />
            <ProviderMark provider="codex" size={13} />
          </span>
          <span className="col grow">
            <span className="connect-title">Connect an agent</span>
            <span className="connect-sub truncate">Sign in to Claude Code or Codex</span>
          </span>
          <Icon name="arrow-right" size={13} className="connect-arrow" />
        </button>
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
