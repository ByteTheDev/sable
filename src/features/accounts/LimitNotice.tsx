import { memo, useState } from 'react';
import { DEFAULT_ACCOUNT, type NoticeItem } from '@shared/protocol';
import { PROVIDER_NAME } from '@/art/Logo';
import { Icon } from '@/icons';
import { resetIn } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { switchSessionAccount } from '@/state/actions';
import { accountName, useLimitLevel } from '@/state/hooks';
import { useStore } from '@/state/store';
import { Spinner } from '@/ui';

/** "5-hour limit" stays as it is; any weekly window reads "weekly limit". */
function windowName(window?: string) {
  if (!window) return 'plan limit';
  return /^weekly/i.test(window) ? 'weekly limit' : window.replace(/^(\S)/, (c) => c.toLowerCase());
}

/** When a window resets, as a clock time (with the day when it is not today) and how long until then. */
export function resetLine(resetsAt: number | undefined, now: number): string | undefined {
  if (!resetsAt || resetsAt <= now) return undefined;
  const d = new Date(resetsAt);
  const today = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay = d.toDateString() === today.toDateString();
  const tomorrow = new Date(now + 86_400_000).toDateString() === d.toDateString();
  const day = sameDay ? '' : tomorrow ? 'tomorrow ' : `${d.toLocaleDateString(undefined, { weekday: 'long' })} `;
  const left = resetIn(resetsAt, now);
  return `Resets ${day}at ${time}${left ? `, in ${left}` : ''}`;
}

/**
 * A turn the account's plan limit refused: which account, when the window resets, and, when
 * another signed-in account of the agent has room, one button to carry on with it (the same
 * conversation, the same message). Mounted by the timeline's Notice for notices with `limit`.
 */
export const LimitNotice = memo(function LimitNotice({ item, sessionId }: { item: NoticeItem; sessionId?: string }) {
  const limit = item.limit!;
  const now = useNow();
  const provider = limit.provider;
  const accounts = useStore((s) => (provider ? s.providers[provider]?.accounts : undefined));
  const fallbackSession = useStore((s) => s.ui.activeSessionId);
  const sid = sessionId ?? fallbackSession;
  const busy = useStore((s) => (sid ? s.sessions[sid]?.status === 'running' || s.sessions[sid]?.status === 'starting' : false));
  const [moving, setMoving] = useState(false);

  const self = accounts?.find((a) => a.id === (limit.accountId ?? DEFAULT_ACCOUNT));
  const next = limit.next ? accounts?.find((a) => a.id === limit.next && a.auth.loggedIn) : undefined;
  const nextLevel = useLimitLevel(provider, next?.id);
  const offer = next && nextLevel !== 'cap' ? next : undefined;
  const went = limit.continuedWith ? accounts?.find((a) => a.id === limit.continuedWith) : undefined;

  const who = accounts && accounts.length > 1 && self ? accountName(self) : provider ? PROVIDER_NAME[provider] : 'This account';
  const reset = resetLine(limit.resetsAt, now);

  return (
    <div className="lim" role="status" data-done={limit.continuedWith ? '' : undefined}>
      <Icon name="hourglass" size={16} className="lim-icon" />
      <div className="lim-body">
        <div className="lim-text">
          {who} is at its {windowName(limit.window)}
        </div>
        {(reset || item.detail) && <div className="lim-detail">{reset ?? item.detail}</div>}
      </div>
      {limit.continuedWith ? (
        <span className="lim-went">
          <Icon name="check" size={13} />
          Continued with {went ? accountName(went) : 'another account'}
        </span>
      ) : (
        offer &&
        sid && (
          <button
            type="button"
            className="btn btn-sm lim-go"
            disabled={moving || busy}
            onClick={() => {
              setMoving(true);
              void switchSessionAccount(sid, offer.id, true).finally(() => setMoving(false));
            }}
          >
            {moving ? <Spinner size={12} /> : <Icon name="arrow-right" size={14} />}
            Continue with {accountName(offer)}
          </button>
        )
      )}
    </div>
  );
});
