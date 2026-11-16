import { useEffect, useState } from 'react';
import { DEFAULT_ACCOUNT, type ProviderId } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { Icon } from '@/icons';
import { useNow } from '@/lib/useNow';
import { openUsage, refreshLimits } from '@/state/actions';
import { accountName, useLimitLevel, useLimitsReport } from '@/state/hooks';
import { accountKey, useStore } from '@/state/store';
import { cx } from '@/ui';
import { clock, exactTime, isApiKey, planText, STALE_MS } from './format';
import { NO_DATA, WindowRow, WindowSkeleton } from './Limits';

/**
 * One account's plan limits in compact form, for a popover (sidebar footer, account switcher):
 * each window with its figure, meter, reset and pace, then a row that opens the Usage page.
 * Reads the limits once when it mounts (cheap: from a running agent, or the last known).
 */
export function LimitsGlance({ provider, accountId = DEFAULT_ACCOUNT, header = true, onOpenUsage }: { provider: ProviderId; accountId?: string; header?: boolean; onOpenUsage?: () => void }) {
  const account = useStore((s) => s.providers[provider]?.accounts?.find((a) => a.id === accountId));
  const signedIn = useStore((s) => {
    const p = s.providers[provider];
    const a = p?.accounts?.find((x) => x.id === accountId);
    return !!(a ? a.auth.loggedIn : accountId === DEFAULT_ACCOUNT && p?.auth.loggedIn);
  });
  const live = useStore((s) => s.limits[accountKey(provider, accountId)]);
  const report = useLimitsReport(provider, accountId);
  const now = useNow();
  const limits = report?.limits.length ? report.limits : live;
  const stale = report?.readAt && now - report.readAt > STALE_MS ? report.readAt : undefined;

  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    setPending(true);
    void refreshLimits(provider, accountId).finally(() => live && setPending(false));
    return () => {
      live = false;
    };
  }, [provider, accountId, signedIn]);

  let body;
  if (!signedIn) body = <p className="ul-note">Not signed in</p>;
  else if (report?.planLimits === false || (!limits?.length && isApiKey(account?.auth))) body = <p className="ul-note">No plan limits on this account</p>;
  else if (limits?.length)
    body = (
      <div className="ul-rows">
        {limits.map((l) => (
          <WindowRow key={l.id} limit={l} samples={report?.history[l.id]} pace={report?.pace[l.id]} now={now} compact />
        ))}
      </div>
    );
  else if (pending) body = <WindowSkeleton />;
  else body = <p className="ul-note">{NO_DATA}</p>;

  return (
    <div className="ul-glance">
      {header && (
        <div className="ul-glance-head">
          <ProviderMark provider={provider} size={14} />
          <span className="ul-account-name truncate">{account ? accountName(account) : PROVIDER_NAME[provider]}</span>
          {planText(account?.auth) && <span className="ul-account-plan">{planText(account?.auth)}</span>}
          {stale && (
            <span className="ul-asof num" title={`Read ${exactTime(stale)}`}>
              as of {clock(stale, now)}
            </span>
          )}
        </div>
      )}
      {body}
      <button
        type="button"
        className="ul-glance-open"
        onClick={() => {
          onOpenUsage?.();
          openUsage();
        }}
      >
        <Icon name="gauge" size={15} />
        <span>Usage</span>
        <Icon name="caret-right" size={12} className="ul-glance-caret" />
      </button>
    </div>
  );
}

/**
 * A tiny amber dot when an account is at 80% or more of a plan window, red when one is used up;
 * nothing otherwise. For the sidebar footer, the account switcher and the composer.
 */
export function LimitDot({ provider, accountId, className }: { provider: ProviderId; accountId?: string; className?: string }) {
  const level = useLimitLevel(provider, accountId);
  if (!level) return null;
  return <span className={cx('limit-dot', className)} data-level={level === 'cap' ? 'red' : 'amber'} role="img" aria-label={level === 'cap' ? 'A plan limit is used up' : 'Near a plan limit'} />;
}
