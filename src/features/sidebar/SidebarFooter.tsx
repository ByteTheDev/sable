import { memo, useEffect, type CSSProperties } from 'react';
import { DEFAULT_ACCOUNT, type RateLimit } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { connectableAgents, isSignedIn, planLabel } from '@/features/connect/plan';
import { Icon } from '@/icons';
import { resetIn } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { homeAccountId, openSettings, refreshLimits, setHomeAccount } from '@/state/actions';
import { accountName, useAccountLimits, useFocusAccount } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSep, MenuTrigger } from '@/ui';
import './footer.css';

const REFRESH_MS = 4 * 60_000;

/** Usage limits for the account in focus, then who is signed in. */
export const SidebarFooter = memo(function SidebarFooter() {
  return (
    <div className="side-foot">
      <Usage />
      <Account />
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

/** Who is signed in: the plan first ("Max plan"), the email quietly after it. */
function Account() {
  const providers = useStore((s) => s.providers);
  const { provider: active, accountId } = useFocusAccount();
  const homeId = useStore((s) => homeAccountId(active, s));
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

  const focus = connected.includes(active) ? active : connected[0];
  const accounts = providers[focus]?.accounts ?? [];
  const account = focus === active ? accounts.find((a) => a.id === accountId) : accounts.find((a) => a.isDefault);
  const auth = account?.auth ?? providers[focus]?.auth;
  const plan = planLabel(auth);
  const email = auth?.loggedIn ? auth.email : undefined;
  const name = account ? accountName(account) : email;
  const multi = focus === active && accounts.length > 1;
  const described = [PROVIDER_NAME[focus], plan ?? (auth?.loggedIn ? 'signed in' : 'not signed in'), email].filter(Boolean).join(', ');

  const main = (
    <>
      <span className="account-marks" aria-hidden>
        {connected.map((id) => (
          <span key={id} className="account-mark" data-focus={id === focus || undefined}>
            <ProviderMark provider={id} size={12} />
          </span>
        ))}
      </span>
      <span className="account-who">
        <span className="account-plan">{plan ?? (auth?.loggedIn ? PROVIDER_NAME[focus] : 'Not signed in')}</span>
        {email && !plan && <span className="account-email-dim truncate">{email}</span>}
      </span>
      {multi && <Icon name="caret-updown" size={13} className="account-caret" />}
    </>
  );

  return (
    <div className="account">
      {multi ? (
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="account-main" title={name} aria-label={`${described}. Switch account`}>
              {main}
            </button>
          </MenuTrigger>
          <MenuContent side="top" align="start" width={252}>
            <MenuLabel>New {PROVIDER_NAME[focus]} sessions use</MenuLabel>
            {accounts.map((a) => (
              <MenuItem key={a.id} icon="user" checked={a.id === homeId} hint={a.auth.loggedIn ? (planLabel(a.auth) ?? undefined) : 'Not signed in'} onSelect={() => setHomeAccount(focus, a.id)}>
                {accountName(a)}
              </MenuItem>
            ))}
            <MenuSep />
            <MenuItem icon="settings" onSelect={openAccounts}>
              Manage accounts
            </MenuItem>
          </MenuContent>
        </Menu>
      ) : (
        <button type="button" className="account-main" onClick={openAccounts} title={name} aria-label={`${described}. Accounts`}>
          {main}
        </button>
      )}
      <IconButton icon="settings" label="Settings" keys="mod+," tipSide="top" onClick={() => openSettings()} />
    </div>
  );
}
