import { useState } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import { DEFAULT_ACCOUNT } from '@shared/protocol';
import { LimitDot } from '@/features/usage';
import { Icon } from '@/icons';
import { openSettings, switchSessionAccount } from '@/state/actions';
import { accountName } from '@/state/hooks';
import { useStore } from '@/state/store';
import { Spinner } from '@/ui';
import { planWord } from './model';

/**
 * The account a session runs under, quietly in the session's header, only when its agent has more
 * than one. It opens the other accounts: picking one continues this conversation there.
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
  if (!provider || !accounts || accounts.length < 2) return null;
  const current = accounts.find((a) => a.id === accountId);
  const name = accountName(current);

  return (
    <RM.Root modal={false}>
      <RM.Trigger asChild>
        <button type="button" className="sa-trigger" aria-label={`Account: ${name}. Continue with another account`}>
          <Icon name="user" size={13} />
          <span className="truncate">{name}</span>
          <LimitDot provider={provider} accountId={accountId} />
          {moving && <Spinner size={11} />}
        </button>
      </RM.Trigger>
      <RM.Portal>
        <RM.Content className="pop sa-pop" data-spot side="bottom" align="start" sideOffset={6} collisionPadding={10} style={{ width: 236 }} loop>
          <RM.Label className="menu-label">Continue with</RM.Label>
          {accounts.map((a) => {
            const here = a.id === accountId;
            const plan = a.auth.loggedIn ? planWord(a) : 'Signed out';
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
                <span className="acs-end">
                  <LimitDot provider={provider} accountId={a.id} />
                  {here && <Icon name="check" size={14} className="acs-check" />}
                </span>
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
