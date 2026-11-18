import { useState } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import { DEFAULT_ACCOUNT, type RateLimit } from '@shared/protocol';
import { clock } from '@/features/usage/format';
import { limitTitle, useSessionLimits } from '@/features/usage/scope';
import { Icon } from '@/icons';
import { openSettings, switchSessionAccount } from '@/state/actions';
import { accountName } from '@/state/hooks';
import { useStore } from '@/state/store';
import { Spinner, Tip } from '@/ui';
import { AccountUsed, planOf } from './ManyAccounts';

const stateOf = (l: RateLimit) => (l.percent >= 100 ? 'reached' : `at ${Math.round(l.percent)}%`);

/**
 * The account a session runs under, quietly in the session's header, only when its agent has more
 * than one. It opens the other accounts: picking one continues this conversation there.
 *
 * Its mark follows the windows that hold back this chat's model (every model's windows and its
 * own): another model's window at its cap (a sub-agent on Fable hit Fable's week) is a quiet ring,
 * named in the menu with its reset, never red for the whole account.
 */
export function SessionAccount({ sessionId }: { sessionId: string }) {
  const provider = useStore((s) => s.sessions[sessionId]?.provider);
  const accountId = useStore((s) => s.sessions[sessionId]?.accountId ?? DEFAULT_ACCOUNT);
  const busy = useStore((s) => {
    const st = s.sessions[sessionId]?.status;
    return st === 'running' || st === 'awaiting' || st === 'starting';
  });
  const accounts = useStore((s) => (provider ? s.providers[provider]?.accounts : undefined));
  const [moving, setMoving] = useState<string | null>(null);
  const lim = useSessionLimits(sessionId);
  if (!provider || !accounts || accounts.length < 2) return null;
  const current = accounts.find((a) => a.id === accountId);
  const name = accountName(current);

  const level = lim?.level === 'cap' ? 'red' : lim?.level === 'near' ? 'amber' : lim?.otherCap ? 'other' : undefined;
  const rows = lim ? [...lim.own, ...lim.other] : [];
  const goesOn = !!lim?.model && lim.level !== 'cap' && lim.other.some((l) => l.percent >= 100);
  const said = rows.map((l) => `${limitTitle(l.label)} ${stateOf(l)}`).join(', ');
  const tip = said ? `${name}: ${said}${goesOn ? `. ${lim!.model} is not limited` : ''}` : name;

  return (
    <RM.Root modal={false}>
      <Tip label={tip}>
        <RM.Trigger asChild>
          <button type="button" className="sa-trigger" aria-label={`Account: ${tip}. Continue with another account`}>
            <Icon name="user" size={13} />
            <span className="truncate">{name}</span>
            {level && <span className="limit-dot" data-level={level} aria-hidden />}
            {moving && <Spinner size={11} />}
          </button>
        </RM.Trigger>
      </Tip>
      <RM.Portal>
        <RM.Content className="pop sa-pop" data-spot side="bottom" align="start" sideOffset={6} collisionPadding={10} style={{ width: 300 }} loop>
          {rows.length > 0 && (
            <>
              <div className="sa-limits" role="group" aria-label={`Limits of ${name}`}>
                {rows.map((l) => {
                  const mine = lim!.own.includes(l);
                  const tone = mine ? (l.percent >= 100 ? 'red' : 'amber') : 'other';
                  return (
                    <div key={l.id} className="sa-limit">
                      <span className="limit-dot" data-level={tone} aria-hidden />
                      <span className="sa-limit-text">
                        {limitTitle(l.label)} {stateOf(l)}
                      </span>
                      {l.resetsAt && <span className="sa-limit-reset num">{clock(l.resetsAt)}</span>}
                    </div>
                  );
                })}
                {goesOn && (
                  <div className="sa-limit-note">
                    {lim!.model} is not limited. This chat goes on under {name}.
                  </div>
                )}
              </div>
              <RM.Separator className="menu-sep" />
            </>
          )}
          <RM.Label className="menu-label">Continue with</RM.Label>
          {accounts.map((a) => {
            const here = a.id === accountId;
            const plan = a.auth.loggedIn ? planOf(a) : 'Signed out';
            return (
              <RM.Item
                key={a.id}
                className="menu-item acs-row"
                disabled={here || busy || !a.auth.loggedIn || !!moving}
                data-current={here || undefined}
                onSelect={() => {
                  setMoving(a.id);
                  void switchSessionAccount(sessionId, a.id).finally(() => setMoving(null));
                }}
              >
                <span className="acs-name truncate">{accountName(a)}</span>
                <span className="acs-plan">{plan}</span>
                {a.auth.loggedIn ? <AccountUsed provider={provider} accountId={a.id} model={lim ? { id: lim.modelId, name: lim.model } : undefined} /> : <span className="acs-used" aria-hidden />}
                <span className="acs-end">{here && <Icon name="check" size={14} className="acs-check" />}</span>
              </RM.Item>
            );
          })}
          <RM.Separator className="menu-sep" />
          <RM.Item className="menu-item" onSelect={() => openSettings('accounts')}>
            <Icon name="settings" size={16} />
            <span className="grow">Manage accounts</span>
          </RM.Item>
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}
