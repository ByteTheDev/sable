import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import type { AccountInfo, ProviderId, ProviderInfo } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { planText } from '@/features/usage/format';
import { livePercent, roomCount, roomRow, sortRows, type RoomInput, type RoomRow } from '@/features/usage/room';
import { Icon } from '@/icons';
import { useNow } from '@/lib/useNow';
import { accountName } from '@/state/hooks';
import { accountKey, useStore } from '@/state/store';
import { accountsOf, planWord } from './model';

/** From this many accounts on, the switcher filters, groups and orders by room left. */
export const MANY_ACCOUNTS = 8;

const COLLAPSED_KEY = 'sable.accounts.collapsed';

function loadCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

interface Entry extends RoomInput {
  account: AccountInfo;
}

/** Whether an account answers a filter: every word must be in its name, email, plan or agent. */
export function matchesAccount(query: string, hay: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = hay.filter(Boolean).join('\n').toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * The switcher's list for many accounts: a filter on top (typing anywhere in the list goes to it),
 * one group per agent that folds, and within a group the account with the most room first.
 */
export function ManyAccounts({
  agents,
  providers,
  inUse,
  onPeek,
  onPick,
}: {
  agents: ProviderId[];
  providers: Partial<Record<ProviderId, ProviderInfo>>;
  inUse: { provider: ProviderId; accountId: string | undefined };
  onPeek: (p: { provider: ProviderId; accountId: string } | null) => void;
  onPick: (provider: ProviderId, account: AccountInfo) => void;
}) {
  const reports = useStore((s) => s.limitReports);
  const live = useStore((s) => s.limits);
  const now = useNow();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const groups = useMemo(
    () =>
      agents.map((id) => {
        const info = providers[id];
        const entries: Entry[] = accountsOf(info).map((account) => {
          const key = accountKey(id, account.id);
          const known = reports[key]?.limits;
          return { key, account, provider: id, name: accountName(account), usable: account.auth.loggedIn, limits: known?.length ? known : live[key] };
        });
        const rows = entries.map((e) => roomRow(e, now));
        // Usable accounts by room left; signed-out ones after them.
        const sorted = [...sortRows(rows.filter((r) => r.state !== 'off'), 'room'), ...sortRows(rows.filter((r) => r.state === 'off'), 'agent')];
        return { id, rows: sorted, total: sorted.length };
      }),
    [agents, providers, reports, live, now],
  );

  const q = query.trim();
  const shown = groups
    .map((g) => ({
      ...g,
      rows: g.rows.filter((r) => matchesAccount(q, [r.input.name, r.input.account.auth.loggedIn ? r.input.account.auth.email : undefined, planOf(r.input.account), PROVIDER_NAME[g.id]])),
    }))
    .filter((g) => g.rows.length);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* private mode */
      }
      return next;
    });

  const rowEls = () => [...(list.current?.querySelectorAll<HTMLElement>('.acs-row') ?? [])];

  /** Typing on a row goes to the filter (the menu's own type-ahead would only jump by first letters). */
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target === input.current || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1 && e.key !== ' ') {
      e.preventDefault();
      e.stopPropagation();
      setQuery((v) => v + e.key);
      input.current?.focus();
    } else if (e.key === 'Backspace' && query) {
      e.preventDefault();
      e.stopPropagation();
      setQuery((v) => v.slice(0, -1));
      input.current?.focus();
    }
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (!query) return;
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
      return;
    }
    if (e.key === 'Tab') return;
    // The menu must not treat what is typed here as type-ahead or as its own keys.
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const els = rowEls();
      (e.key === 'ArrowDown' ? els[0] : els[els.length - 1])?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      rowEls()[0]?.click();
    }
  };

  return (
    <div className="acs-many" onKeyDown={onListKey}>
      <label className="acs-filter">
        <Icon name="search" size={14} />
        <input
          ref={input}
          className="acs-filter-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          onFocus={() => onPeek(null)}
          placeholder="Filter accounts"
          aria-label="Filter accounts"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <div className="acs-list scroll" ref={list}>
        {shown.length === 0 && <p className="acs-empty">No account matches</p>}
        {shown.map((g) => {
          const folded = !q && collapsed.has(g.id);
          const free = g.rows.filter((r) => r.state === 'room' || r.state === 'unknown').length;
          // An agent's only account is one row under the agent's name: nothing to fold.
          if (g.total === 1)
            return (
              <RM.Group key={g.id} className="acs-group">
                <ManyRow row={g.rows[0]} now={now} single inUse={inUse.provider === g.id} onPeek={() => onPeek({ provider: g.id, accountId: g.rows[0].input.account.id })} onSelect={() => onPick(g.id, g.rows[0].input.account)} />
              </RM.Group>
            );
          return (
            <RM.Group key={g.id} className="acs-group">
              <RM.Item
                className="menu-item acs-group-head"
                aria-expanded={!folded}
                aria-label={`${PROVIDER_NAME[g.id]}, ${free} of ${g.rows.length} with room`}
                onFocus={() => onPeek(null)}
                onSelect={(e) => {
                  e.preventDefault();
                  if (!q) toggle(g.id);
                }}
              >
                <ProviderMark provider={g.id} size={14} className="acs-mark" />
                <span className="acs-name truncate">{PROVIDER_NAME[g.id]}</span>
                <span className="acs-group-count num">
                  {free} of {g.rows.length}
                </span>
                <span className="acs-end">
                  <Icon name="caret-down" size={11} className="acs-fold" />
                </span>
              </RM.Item>
              {!folded && g.rows.map((r) => <ManyRow key={r.input.key} row={r} now={now} inUse={inUse.provider === g.id && inUse.accountId === r.input.account.id} onPeek={() => onPeek({ provider: g.id, accountId: r.input.account.id })} onSelect={() => onPick(g.id, r.input.account)} />)}
            </RM.Group>
          );
        })}
      </div>
    </div>
  );
}

/** The plan as one word, the Demo's made-up plans included. */
const planOf = (a: AccountInfo) => (a.auth.loggedIn ? (planWord(a) ?? planText(a.auth)?.replace(/\s+plan$/i, '')) : undefined);

function ManyRow({ row, now, inUse, single, onPeek, onSelect }: { row: RoomRow<Entry>; now: number; inUse: boolean; single?: boolean; onPeek: () => void; onSelect: () => void }) {
  const { account, provider } = row.input;
  const plan = planOf(account);
  const used = row.tight ? Math.round(livePercent(row.tight, now)) : undefined;
  const level = row.state === 'cap' ? 'red' : row.state === 'near' ? 'amber' : undefined;
  return (
    <RM.Item
      className="menu-item acs-row acs-row-in"
      data-current={account.isDefault || undefined}
      data-in-use={inUse || undefined}
      onFocus={onPeek}
      onSelect={onSelect}
      aria-label={`${PROVIDER_NAME[provider]}, ${row.input.name}${plan ? `, ${plan}` : ''}${used !== undefined ? `, ${used}% used` : ''}${account.auth.loggedIn ? '' : ', not signed in'}${account.isDefault ? ', default' : ''}`}
    >
      {single ? (
        <ProviderMark provider={provider} size={14} className="acs-mark" />
      ) : (
        <span className="acs-check-col" aria-hidden>
          {account.isDefault && <Icon name="check" size={13} className="acs-check" />}
        </span>
      )}
      <span className="acs-name truncate">{single ? PROVIDER_NAME[provider] : row.input.name}</span>
      <span className="acs-plan">{account.auth.loggedIn ? plan : 'Sign in'}</span>
      <span className="acs-used num" data-level={level}>
        {used !== undefined ? `${used}%` : ''}
      </span>
    </RM.Item>
  );
}

/**
 * How many accounts have room, of those signed in ("14/22"): the one figure the sidebar footer
 * shows once there are several accounts, so "who has room" needs no click. Nothing below four.
 */
export function RoomFigure({ agents, providers }: { agents: ProviderId[]; providers: Partial<Record<ProviderId, ProviderInfo>> }) {
  const reports = useStore((s) => s.limitReports);
  const live = useStore((s) => s.limits);
  const now = useNow();
  const { free, of } = useMemo(() => {
    const inputs: RoomInput[] = agents.flatMap((id) =>
      accountsOf(providers[id]).map((a) => {
        const key = accountKey(id, a.id);
        const known = reports[key]?.limits;
        return { key, provider: id, name: accountName(a), usable: a.auth.loggedIn, limits: known?.length ? known : live[key] };
      }),
    );
    return roomCount(inputs, now);
  }, [agents, providers, reports, live, now]);
  if (of < 4) return null;
  return (
    <span className="acs-room num" title={`${free} of ${of} accounts have room`}>
      {free}/{of}
    </span>
  );
}
