import { memo, useMemo, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { ProviderId, RateLimit } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { Icon } from '@/icons';
import { useNow } from '@/lib/useNow';
import { accountName } from '@/state/hooks';
import { accountKey, useStore } from '@/state/store';
import { Segmented, Tip } from '@/ui';
import { duration, exactTime, isApiKey, planText } from './format';
import { AccountLimits, type AccountRef } from './Limits';
import { livePercent, overview, type RoomInput, type RoomRow, type SortBy } from './room';

const SORT_KEY = 'sable.usage.sort';
const SORTS: { value: SortBy; label: string }[] = [
  { value: 'room', label: 'Room left' },
  { value: 'reset', label: 'Reset' },
  { value: 'agent', label: 'Agent' },
];

function readSort(): SortBy {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return v === 'reset' || v === 'agent' ? v : 'room';
  } catch {
    return 'room';
  }
}

interface Entry extends RoomInput {
  ref: AccountRef;
  /** An API key or an account the agent reports no plan windows for. */
  unmetered: boolean;
}

/** Every account with its windows, one input per account, for ordering (here and in the switcher). */
export function useRoomInputs(refs: AccountRef[]): Entry[] {
  const reports = useStore((s) => s.limitReports);
  const live = useStore((s) => s.limits);
  return useMemo(
    () =>
      refs.map((ref) => {
        const key = accountKey(ref.provider, ref.account.id);
        const known = reports[key]?.limits;
        const multi = (ref.info?.accounts?.length ?? 0) > 1;
        return {
          key,
          ref,
          provider: ref.provider,
          name: multi ? accountName(ref.account) : PROVIDER_NAME[ref.provider],
          usable: !!ref.info?.installed && ref.account.auth.loggedIn,
          limits: known?.length ? known : live[key],
          unmetered: reports[key]?.planLimits === false || isApiKey(ref.account.auth),
        };
      }),
    [refs, reports, live],
  );
}

/** "5h", "7d": the window's length, short enough for a cell. */
export function windowShort(l: RateLimit): string {
  const m = l.windowMins;
  if (!m) return l.label.split(/[\s·-]/)[0] ?? '';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

/** At most two windows per row: the shortest and the longest (the session and the week). */
function cells(limits: RateLimit[] | undefined): RateLimit[] {
  const sorted = [...(limits ?? [])].sort((a, b) => (a.windowMins ?? 0) - (b.windowMins ?? 0));
  return sorted.length > 2 ? [sorted[0], sorted[sorted.length - 1]] : sorted;
}

/**
 * Settings > Usage with many accounts: every account as one line (agent, name, each window as a
 * thin meter with its figure, time to the reset), ordered by room left, by reset or by agent. The
 * accounts at or near a cap sit apart; the one with the most room carries one small mark. A line
 * opens that account's windows in full.
 */
export function LimitsOverview({ refs, pending }: { refs: AccountRef[]; pending: ReadonlySet<string> }) {
  const inputs = useRoomInputs(refs);
  const now = useNow();
  const [sort, setSort] = useState<SortBy>(readSort);
  const [open, setOpen] = useState<string | null>(null);
  const agentOrder = useMemo(() => [...new Set(refs.map((r) => r.provider))], [refs]);
  const view = useMemo(() => overview(inputs, now, sort, agentOrder), [inputs, now, sort, agentOrder]);

  const pick = (v: SortBy) => {
    setSort(v);
    try {
      localStorage.setItem(SORT_KEY, v);
    } catch {
      /* private mode */
    }
  };

  const row = (r: RoomRow<Entry>) => (
    <OverviewRow key={r.input.key} row={r} now={now} best={view.best === r.input.key} open={open === r.input.key} pending={pending.has(r.input.key)} onToggle={() => setOpen((k) => (k === r.input.key ? null : r.input.key))} />
  );

  return (
    <div className="ulo card" data-spot>
      <div className="ulo-head">
        <span className="ulo-count num">
          {view.open.length} of {view.open.length + view.tight.length} with room
        </span>
        <Segmented id="ulo-sort" className="ulo-sort" value={sort} onChange={pick} options={SORTS} />
      </div>
      <div className="ulo-cols" aria-hidden>
        <span>Account</span>
        <span>Used</span>
        <span>Resets in</span>
      </div>
      <div className="ulo-list" role="list">
        {view.open.map(row)}
        {view.tight.length > 0 && (
          <div className="ulo-sep" role="presentation">
            <span>At or near a cap</span>
            <span className="num">{view.tight.length}</span>
          </div>
        )}
        {view.tight.map(row)}
        {view.off.length > 0 && (
          <div className="ulo-sep" role="presentation">
            <span>Not signed in</span>
            <span className="num">{view.off.length}</span>
          </div>
        )}
        {view.off.map(row)}
      </div>
    </div>
  );
}

const OverviewRow = memo(function OverviewRow({ row, now, best, open, pending, onToggle }: { row: RoomRow<Entry>; now: number; best: boolean; open: boolean; pending: boolean; onToggle: () => void }) {
  const { input, state, resetsAt } = row;
  const { ref } = input;
  const plan = planText(ref.account.auth);
  const windows = cells(input.limits);
  const label = `${PROVIDER_NAME[input.provider as ProviderId]}, ${input.name}${row.room !== undefined ? `, ${row.room}% left` : ''}${best ? ', most room right now' : ''}`;
  return (
    <div className="ulo-item" role="listitem" data-state={state} data-open={open || undefined}>
      <button type="button" className="ulo-row" aria-expanded={open} aria-label={label} onClick={onToggle}>
        <ProviderMark provider={input.provider} size={14} className="ulo-mark" />
        <span className="ulo-who">
          <span className="ulo-name truncate">{input.name}</span>
          {plan && <span className="ulo-plan truncate">{plan}</span>}
          {best && (
            <Tip label="Most room right now">
              <span className="ulo-best" aria-hidden />
            </Tip>
          )}
        </span>
        <span className="ulo-windows">
          {state === 'off' ? (
            <span className="ulo-none">{ref.info?.installed ? 'Not signed in' : 'Not installed'}</span>
          ) : windows.length ? (
            windows.map((l) => <Cell key={l.id} limit={l} now={now} />)
          ) : (
            <span className="ulo-none">{input.unmetered ? 'No plan limits' : pending ? 'Reading' : 'No figures yet'}</span>
          )}
        </span>
        <span className="ulo-reset num" title={resetsAt ? exactTime(resetsAt) : undefined}>
          {resetsAt ? duration(resetsAt - now) : ''}
        </span>
        <Icon name="caret-down" size={12} className="ulo-caret" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="ulo-detail" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 460, damping: 40 }}>
            <AccountLimits refs={ref} pending={pending} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

function Cell({ limit, now }: { limit: RateLimit; now: number }) {
  const pct = Math.round(livePercent(limit, now));
  const level = pct >= 100 ? 'red' : pct >= 80 ? 'amber' : undefined;
  return (
    <span className="ulo-cell" title={limit.label}>
      <span className="ulo-win">{windowShort(limit)}</span>
      <span className="meter ulo-meter" data-level={level} role="progressbar" aria-label={limit.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span className="meter-fill" style={{ '--p': Math.max(pct, pct > 0 ? 3 : 0) / 100 } as CSSProperties} />
      </span>
      <span className="ulo-pct num" data-level={level}>
        {pct}%
      </span>
    </span>
  );
}
