import { Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { DEFAULT_ACCOUNT, type AccountInfo, type LimitPace, type LimitsReport, type ProviderId, type ProviderInfo, type RateLimit } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { useNow } from '@/lib/useNow';
import { openSettings, readLimitsNow, refreshLimits, setSettings } from '@/state/actions';
import { accountName, useLimitsReport } from '@/state/hooks';
import { accountKey, useStore } from '@/state/store';
import { cx, IconButton, Switch, Tip } from '@/ui';
import { clock, duration, exactTime, isApiKey, NUMBER_LOCALE, orderWindows, planText, STALE_MS, windowLevel } from './format';
import { LimitsOverview, LimitsTotals } from './Overview';
import { livePercent } from './room';
import { LimitReset, resetTarget } from './LimitReset';
import { useLimitsTicker } from './ticker';
import './usage.css';

/** From this many accounts on, the Usage page lists them as an overview instead of one block each. */
const OVERVIEW_FROM = 3;

/** Figures older than this are read for real while the Usage view stays open. */
const AGED_MS = 10 * 60_000;

/** One sentence about where the pace leads, or nothing. */
export function paceText(l: RateLimit, p: LimitPace | undefined, now: number, short = false): { text: string; warn: boolean } | undefined {
  if (!p || l.percent >= 100 || (l.resetsAt && l.resetsAt <= now)) return undefined;
  if (p.fullAt) return { text: short ? `runs out at ${clock(p.fullAt, now)}` : `On pace to run out at ${clock(p.fullAt, now)}`, warn: true };
  if (p.perHour <= 0.01) return l.resetsAt ? { text: short ? 'steady' : 'Steady until the reset', warn: false } : undefined;
  if (p.atReset !== undefined) return { text: short ? `${p.atReset}% by then` : `On pace for ${p.atReset}% at the reset`, warn: false };
  return undefined;
}

/** One plan-limit window: name, figure, meter, reset and pace, for popovers and the side panel (`compact`); Settings › Usage uses WindowLine. */
// `samples` (the window's history) is still accepted; the small curve it drew was too small to read.
export const WindowRow = memo(function WindowRow({ limit, pace, now, compact }: { limit: RateLimit; samples?: [number, number][]; pace?: LimitPace; now: number; compact?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(limit.percent)));
  const past = !!limit.resetsAt && limit.resetsAt <= now;
  const level = windowLevel(limit, now);
  const p = paceText(limit, pace, now, compact);
  // No reset yet: the window has not started (it starts, and its clock runs, with the next message).
  const reset = limit.resetsAt ? (past ? `Reset at ${clock(limit.resetsAt, now)}` : `Resets in ${duration(limit.resetsAt - now)}`) : pct === 0 ? 'Starts with your next message' : undefined;
  return (
    <div className="ul-row" data-compact={compact || undefined} data-level={level} data-past={past || undefined}>
      <div className="ul-top">
        <span className="ul-label truncate">{limit.label}</span>
        <span className="ul-pct num">
          {pct}
          <span className="ul-pct-sign">%</span>
        </span>
      </div>
      <span className="meter ul-meter" data-level={level} role="progressbar" aria-label={limit.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span className="meter-fill" style={{ '--p': past ? 0 : Math.max(pct, pct > 0 ? 1.5 : 0) / 100 } as CSSProperties} />
      </span>
      {(reset || p) && (
        <div className="ul-meta">
          {reset && limit.resetsAt && (
            <Tip label={exactTime(limit.resetsAt)} side="bottom">
              <span className="ul-reset num" tabIndex={0}>
                {reset}
              </span>
            </Tip>
          )}
          {reset && !limit.resetsAt && <span className="ul-reset">{reset}</span>}
          {p && (
            <span className="ul-pace" data-warn={p.warn || undefined} data-short={compact || undefined}>
              {p.warn && <span className="ul-pace-mark" aria-hidden />}
              {p.text}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * One plan-limit window on the Usage page, one line in the columns of the overview: its name, a
 * thin meter with the percent used, and the time to its reset; where the pace leads on a quiet
 * line under the meter.
 */
export const WindowLine = memo(function WindowLine({ limit, pace, now }: { limit: RateLimit; pace?: LimitPace; now: number }) {
  const past = !!limit.resetsAt && limit.resetsAt <= now;
  const pct = Math.round(livePercent(limit, now));
  const level = windowLevel(limit, now);
  const p = paceText(limit, pace, now);
  // No reset yet: the window has not started (it starts, and its clock runs, with the next message).
  const note = p?.text ?? (past ? `Reset at ${clock(limit.resetsAt!, now)}` : !limit.resetsAt && pct === 0 ? 'Starts with your next message' : undefined);
  return (
    <div className="ulw" data-level={level} data-past={past || undefined}>
      <span className="ulw-label truncate">{limit.label}</span>
      <span className="ulw-bar">
        <span className="meter ulw-meter" data-level={level} role="progressbar" aria-label={limit.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span className="meter-fill" style={{ '--p': Math.max(pct, pct > 0 ? 1.5 : 0) / 100 } as CSSProperties} />
        </span>
        <span className="ulw-pct num">{pct}%</span>
      </span>
      {limit.resetsAt && !past ? (
        <Tip label={exactTime(limit.resetsAt)} side="bottom">
          <span className="ulw-reset num" tabIndex={0} aria-label={`Resets in ${duration(limit.resetsAt - now)}`}>
            {duration(limit.resetsAt - now)}
          </span>
        </Tip>
      ) : (
        <span className="ulw-reset" />
      )}
      {note && (
        <span className="ulw-note" data-warn={p?.warn || undefined}>
          {p?.warn && <span className="ul-pace-mark" aria-hidden />}
          {note}
        </span>
      )}
    </div>
  );
});

/** Rows while the first read is on its way. */
export function WindowSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="ul-skel" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ul-skel-row">
          <span className="skel" style={{ width: i ? '34%' : '26%', height: 10 }} />
          <span className="skel" style={{ width: '100%', height: 4 }} />
        </div>
      ))}
    </div>
  );
}

export interface AccountRef {
  provider: ProviderId;
  info: ProviderInfo | undefined;
  account: AccountInfo;
}

/** Every account the Usage view lists: Claude Code and Codex always, other agents when present; the default account first. */
export function useAccountRefs(): AccountRef[] {
  const providers = useStore((s) => s.providers);
  return useMemo(() => {
    const ids: ProviderId[] = ['claude', 'codex', ...(Object.keys(providers) as ProviderId[]).filter((id) => id !== 'claude' && id !== 'codex' && providers[id]?.installed)];
    return ids.flatMap((provider) => {
      const info = providers[provider];
      const accounts = info?.accounts?.length ? info.accounts : [{ id: DEFAULT_ACCOUNT, provider, label: 'Main', isDefault: true, auth: info?.auth ?? { loggedIn: false } }];
      // A missing agent is one line, not one per account.
      return (info?.installed ? accounts : accounts.slice(0, 1)).map((account) => ({ provider, info, account }));
    });
  }, [providers]);
}

/**
 * Keeps limits current while a view shows them: a cheap read for every signed-in account when it
 * opens, and a forced one (which may start a short agent process) for an account never read.
 */
export function useLimitsRefresh(refs: AccountRef[], ready: boolean) {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  /** Accounts a forced read just came back empty for: asking again now will not help. */
  const [dry, setDry] = useState<ReadonlySet<string>>(() => new Set());
  const signedIn = refs.filter((r) => r.info?.installed && r.account.auth.loggedIn);
  const sig = signedIn.map((r) => accountKey(r.provider, r.account.id)).join(',');

  const run = (force: boolean, only?: AccountRef[]) => {
    for (const r of only ?? signedIn) {
      const key = accountKey(r.provider, r.account.id);
      const known = useStore.getState().limitReports[key];
      setPending((s) => new Set(s).add(key));
      const forced = force || !known?.readAt;
      void (forced ? readLimitsNow : refreshLimits)(r.provider, r.account.id)
        .then((rows) => {
          if (!forced) return;
          const empty = !rows.length && !useStore.getState().limitReports[key]?.limits.length;
          setDry((s) => {
            const next = new Set(s);
            if (empty) next.add(key);
            else next.delete(key);
            return next;
          });
        })
        .finally(() =>
        setPending((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        }),
      );
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (ready && sig) runRef.current(false);
  }, [ready, sig]);
  // And again while the view stays open. A cheap read keeps an account with a live agent current;
  // one whose figures have aged (no agent of it running) is read for real, at most this often.
  useLimitsTicker(ready && !!sig, () => {
    const now = Date.now();
    for (const r of signedIn) {
      const readAt = useStore.getState().limitReports[accountKey(r.provider, r.account.id)]?.readAt;
      runRef.current(!!readAt && now - readAt > AGED_MS, [r]);
    }
  });

  return { pending, dry, refresh: () => run(true, signedIn.filter((r) => !dry.has(accountKey(r.provider, r.account.id)))) };
}

/** What an account without limits waits for, in one line. */
export const NO_DATA = 'Limits appear after the next turn';

/** Lines while the first read is on its way, in the columns of the window lines. */
function LineSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="ulw-list" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ulw">
          <span className="skel ulw-skel-label" style={{ width: i ? '72%' : '54%' }} />
          <span className="ulw-bar">
            <span className="skel ulw-skel-meter" />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * One account's windows on the Usage page: every window it has as one line each (the 5-hour one,
 * the week, the week of each model), extra usage or credits, a reset where one is granted. As a
 * card with the agent, name and plan (few accounts), or `inline` under its line in the overview.
 */
export function AccountLimits({ refs, pending, inline }: { refs: AccountRef; pending: boolean; inline?: boolean }) {
  const { provider, info, account } = refs;
  const report = useLimitsReport(provider, account.id);
  const live = useStore((s) => s.limits[accountKey(provider, account.id)]);
  const now = useNow();
  // The bridge's record first (it has the history); the last event otherwise.
  const limits = report?.limits.length ? report.limits : live;
  const ordered = useMemo(() => orderWindows(limits ?? []), [limits]);
  const plan = planText(account.auth);
  const multi = (info?.accounts?.length ?? 0) > 1;
  // One account: the agent's name says it all. Several: each by its email (or label).
  const name = multi && info?.installed ? accountName(account) : PROVIDER_NAME[provider];
  const stale = report?.readAt && now - report.readAt > STALE_MS ? report.readAt : undefined;
  const resetOn = report?.resets?.available ? resetTarget(limits, report.resets.windows) : undefined;
  const asOf = stale ? (
    <Tip label={`Read ${exactTime(stale)}`}>
      <span className={cx('ul-asof num', pending && 'is-pending')} tabIndex={0}>
        as of {clock(stale, now)}
      </span>
    </Tip>
  ) : null;

  let body;
  if (!info?.installed) body = <p className="ulw-msg">Not installed</p>;
  else if (!account.auth.loggedIn)
    body = (
      <p className="ulw-msg">
        <span>Not signed in</span>
        <button type="button" className="btn btn-sm ul-note-btn" onClick={() => openSettings('accounts')}>
          Accounts
        </button>
      </p>
    );
  else if (report?.planLimits === false || (!limits?.length && isApiKey(account.auth))) body = <p className="ulw-msg">No plan limits on this account</p>;
  else if (ordered.length)
    body = (
      <div className="ulw-list">
        {ordered.map((l) => (
          <Fragment key={l.id}>
            <WindowLine limit={l} pace={report?.pace[l.id]} now={now} />
            {l.id === resetOn?.id && (
              <div className="ulw-sub">
                <LimitReset provider={provider} accountId={account.id} limit={l} />
              </div>
            )}
          </Fragment>
        ))}
        <Extra report={report} now={now} />
        {!inline && offersCredits(report) && (
          <div className="ulw-sub ulw-sub-wide">
            <CreditsSetting provider={provider} accountId={account.id} />
          </div>
        )}
      </div>
    );
  else if (pending) body = <LineSkeleton />;
  // Nothing to read on demand: the agent reports its limits while it works.
  else body = <p className="ulw-msg">{NO_DATA}</p>;

  if (inline)
    return (
      <div className="ul-account" data-inline>
        {body}
        {asOf && <div className="ulw-asof">{asOf}</div>}
      </div>
    );
  return (
    <section className="ul-account card" data-spot aria-label={`${PROVIDER_NAME[provider]}: ${name}`}>
      <header className="ul-account-head">
        <ProviderMark provider={provider} size={15} className="ul-account-mark" />
        <span className="ul-account-who">
          <span className="ul-account-name truncate">{name}</span>
          {plan && <span className="ul-account-plan truncate">{plan}</span>}
          {asOf && <span className="ul-account-asof">{asOf}</span>}
        </span>
        {ordered.length > 0 && <span className="ul-account-col">Resets in</span>}
      </header>
      {body}
    </section>
  );
}

/** The agent reports credits or extra usage for this account (the credits setting applies to it). */
export const offersCredits = (r: LimitsReport | undefined) => !!(r?.extra?.enabled || r?.credits?.has || r?.credits?.balance || r?.credits?.unlimited);

/** Where each agent's own billing page is (opened in the user's browser). */
const BILLING: Partial<Record<ProviderId, string>> = {
  claude: 'https://claude.ai/settings/usage',
  codex: 'https://chatgpt.com/codex/settings/usage',
};

/**
 * "Use credits at a limit" for one account, shown only where its agent reports credits or extra
 * usage. Neither agent lets Sable switch them per session: the account's own setting decides
 * whether they are spent, so the line says that and links to the provider's billing page.
 */
export function CreditsSetting({ provider, accountId, name, className }: { provider: ProviderId; accountId: string; name?: string; className?: string }) {
  const report = useLimitsReport(provider, accountId);
  const key = `${provider}:${accountId}`;
  const on = useStore((s) => !!s.settings.creditsAtLimit?.[key]);
  if (!offersCredits(report)) return null;
  const label = name ? `Use credits at a limit: ${name}` : 'Use credits at a limit';
  const url = BILLING[provider];
  return (
    <div className={cx('ul-credits', className)} data-spot={className ? true : undefined}>
      <label className="ul-credits-row">
        <span className="ul-label truncate">{label}</span>
        <Switch checked={on} onChange={(v) => void setSettings({ creditsAtLimit: { ...useStore.getState().settings.creditsAtLimit, [key]: v } })} label={label} />
      </label>
      <p className="ul-credits-note">
        Whether credits are spent is set on your {PROVIDER_NAME[provider]} account.
        {url && (
          <>
            {' '}
            <a href={url} target="_blank" rel="noreferrer">
              Billing
            </a>
          </>
        )}
      </p>
    </div>
  );
}

/** Extra usage beyond the plan (Claude) or a credits balance (Codex), as a window line, when the agent reports one. */
function Extra({ report, now }: { report: LimitsReport | undefined; now: number }) {
  const ex = report?.extra;
  if (ex?.enabled && (ex.limit || ex.used)) {
    const money = (v?: number) => (v === undefined ? '' : new Intl.NumberFormat(NUMBER_LOCALE, { style: 'currency', currency: ex.currency || 'USD' }).format(v / 100));
    const pct = ex.percent ?? (ex.limit && ex.used !== undefined ? Math.round((ex.used / ex.limit) * 100) : undefined);
    const spent = ex.limit ? `${money(ex.used ?? 0)} of ${money(ex.limit)}` : money(ex.used);
    const note = [pct !== undefined ? spent : '', ex.inUse ? 'Running on extra usage' : ''].filter(Boolean).join(' · ');
    return (
      <div className="ulw">
        <span className="ulw-label truncate">Extra usage</span>
        <span className="ulw-bar">
          {pct !== undefined ? (
            <>
              <span className="meter ulw-meter" role="progressbar" aria-label="Extra usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <span className="meter-fill" style={{ '--p': Math.min(100, pct) / 100 } as CSSProperties} />
              </span>
              <span className="ulw-pct num">{Math.min(100, pct)}%</span>
            </>
          ) : (
            <span className="ulw-value num">{spent}</span>
          )}
        </span>
        <ResetCell at={ex.resetsAt} now={now} />
        {note && <span className="ulw-note num">{note}</span>}
      </div>
    );
  }
  const cr = report?.credits;
  if (cr && (cr.balance || cr.unlimited))
    return (
      <div className="ulw">
        <span className="ulw-label truncate">Credits</span>
        <span className="ulw-bar">
          <span className="ulw-value num">{cr.unlimited ? 'Unlimited' : balance(cr.balance)}</span>
        </span>
        <ResetCell at={cr.resetsAt} now={now} />
        {cr.inUse && <span className="ulw-note">Running on credits</span>}
      </div>
    );
  return null;
}

/** The time to a reset in the reset column, the exact time in its tooltip; empty when none is ahead. */
function ResetCell({ at, now }: { at?: number; now: number }) {
  if (!at || at <= now) return <span className="ulw-reset" />;
  return (
    <Tip label={exactTime(at)} side="bottom">
      <span className="ulw-reset num" tabIndex={0} aria-label={`Resets in ${duration(at - now)}`}>
        {duration(at - now)}
      </span>
    </Tip>
  );
}

/** A credits balance as the agent sends it ("43106.95142") reads as a number with at most two decimals. */
function balance(raw?: string) {
  const n = Number(raw);
  return raw && Number.isFinite(n) ? n.toLocaleString(NUMBER_LOCALE, { maximumFractionDigits: 2 }) : raw;
}

/** The Limits part of the Usage page: one block per account, one refresh for all. */
export function LimitsSection() {
  const ready = useStore((s) => s.ready);
  const refs = useAccountRefs();
  const { pending, dry, refresh } = useLimitsRefresh(refs, ready);
  const [turning, setTurning] = useState(false);
  // The refresh shows only when it can bring something: an account whose last forced read was empty is left alone.
  const anySignedIn = refs.some((r) => r.info?.installed && r.account.auth.loggedIn && !dry.has(accountKey(r.provider, r.account.id)));
  return (
    <section className="set-group" aria-labelledby="ul-limits-title">
      <header className="set-group-head">
        <h3 className="set-group-title" id="ul-limits-title">
          Limits
        </h3>
        <div className="set-group-aside">
          {anySignedIn && (
            <IconButton
              icon="refresh"
              label="Read limits now"
              size={14}
              className="ul-refresh"
              // The icon turns once per click.
              data-turning={turning || undefined}
              onAnimationEnd={() => setTurning(false)}
              onClick={() => {
                setTurning(true);
                refresh();
              }}
            />
          )}
        </div>
      </header>
      <LimitsTotals refs={refs} />
      {refs.length >= OVERVIEW_FROM ? (
        // Many accounts: one line each, the windows in full on demand.
        <>
          <LimitsOverview refs={refs} pending={pending} />
          <div className="ul-credit-list">
            {refs.map((r) => (
              <CreditsSetting key={`${r.provider}:${r.account.id}`} className="card ul-credit-card" provider={r.provider} accountId={r.account.id} name={accountName(r.account)} />
            ))}
          </div>
        </>
      ) : (
        <div className="ul-accounts">
          {refs.map((r) => (
            <AccountLimits key={`${r.provider}:${r.account.id}`} refs={r} pending={pending.has(accountKey(r.provider, r.account.id))} />
          ))}
        </div>
      )}
    </section>
  );
}
