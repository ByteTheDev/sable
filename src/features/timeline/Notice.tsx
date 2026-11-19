import { memo, useState } from 'react';
import type { NoticeItem } from '@shared/protocol';
import { Collapse } from '@/components/Collapse';
import { Markdown } from '@/components/Markdown';
import { Icon, type IconName } from '@/icons';
import { LimitNotice } from '@/features/accounts';
import { AgentSwitchLine } from './AgentSwitch';

const ICON: Record<NoticeItem['variant'], IconName> = {
  info: 'info',
  error: 'error',
  interrupted: 'hand',
  compact: 'collapse',
  retry: 'refresh',
  mode: 'shield',
  model: 'cube',
  command: 'prompt',
  rewind: 'rewind',
};

/** Things that happened to the conversation rather than in it: dividers, errors, command output. */
export const Notice = memo(function Notice({ item }: { item: NoticeItem }) {
  const [open, setOpen] = useState(true);

  // A turn refused at a plan limit: the accounts feature says when it resets and offers another account.
  if (item.limit) return <LimitNotice item={item} />;
  // The chat switched agents here (AgentSwitch.tsx).
  if (item.agentSwitch) return <AgentSwitchLine item={item} />;

  if (item.variant === 'error') {
    return (
      <div className="notice-error" role="alert">
        <Icon name="error" size={16} />
        <div className="notice-error-body">
          <div className="notice-error-text">{item.text}</div>
          {item.detail && <div className="notice-error-detail">{item.detail}</div>}
        </div>
      </div>
    );
  }

  if (item.variant === 'command') {
    const has = !!item.detail?.trim();
    return (
      <div className="notice-cmd" data-spot data-open={(open && has) || undefined}>
        <button type="button" className="notice-cmd-head" aria-expanded={has ? open : undefined} onClick={() => has && setOpen((o) => !o)} data-static={!has || undefined}>
          <Icon name="prompt" size={15} />
          <span className="grow truncate">{item.text}</span>
          {has && <Icon name="caret-right" size={11} className="row-caret" />}
        </button>
        {has && (
          <Collapse open={open}>
            <div className="notice-cmd-body">
              <Markdown text={item.detail!} />
            </div>
          </Collapse>
        )}
      </div>
    );
  }

  return (
    <div className="notice" data-variant={item.variant}>
      <div className="notice-line">
        <span className="notice-rule" />
        <span className="notice-label">
          <Icon name={ICON[item.variant] ?? 'info'} size={13} />
          {item.text}
        </span>
        <span className="notice-rule" />
      </div>
      {item.detail && <div className="notice-detail">{item.detail}</div>}
    </div>
  );
});
