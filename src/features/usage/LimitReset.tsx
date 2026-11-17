import { useEffect, useRef, useState } from 'react';
import { DEFAULT_ACCOUNT, type ProviderId, type RateLimit, type ResetOutcome } from '@shared/protocol';
import { readLimitsNow, spendLimitReset } from '@/state/actions';
import { accountName, useLimitsReport } from '@/state/hooks';
import { useStore } from '@/state/store';
import { cx } from '@/ui';

/** "2 resets", "1 reset". */
export const resetsText = (n: number) => `${n} ${n === 1 ? 'reset' : 'resets'}`;

/** The window a reset is offered on: the weekly one when it restores several (it restores them all). */
export function resetTarget(limits: RateLimit[] | undefined, windows: string[] | undefined): RateLimit | undefined {
  const own = (limits ?? []).filter((l) => !windows?.length || windows.includes(l.id));
  return own.find((l) => (l.windowMins ?? 0) >= 10_080) ?? own[own.length - 1];
}

/** How a window is named inside a sentence: "the weekly limit", "the 5-hour limit". */
export function windowPhrase(l: RateLimit | undefined): string {
  if (!l) return 'the limits';
  if ((l.windowMins ?? 0) >= 10_080) return 'the weekly limit';
  const label = l.label.replace(/\s*·.*$/, '');
  return `the ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/** What came back, in one line, when it was not a reset. */
const OUTCOME: Record<Exclude<ResetOutcome, 'reset'>, string> = {
  nothingToReset: 'Nothing to reset right now',
  noCredit: 'No resets left',
  alreadyRedeemed: 'That reset was already used',
};

/** The account's resets while the agent reports some; undefined otherwise. */
export function useResets(provider: ProviderId, accountId = DEFAULT_ACCOUNT) {
  const report = useLimitsReport(provider, accountId);
  return report?.resets?.available ? report.resets : undefined;
}

/** One reset attempt's key: kept while the same confirmation retries, new for the next one. */
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * The reset an account was granted, under the window it applies to: how many there are and a
 * Reset button. A click asks first, naming the account, the window and what it spends; only the
 * confirmation calls the agent. Rendered only where the agent reports resets.
 */
export function LimitReset({ provider, accountId = DEFAULT_ACCOUNT, limit, compact, className }: { provider: ProviderId; accountId?: string; limit: RateLimit; compact?: boolean; className?: string }) {
  const resets = useResets(provider, accountId);
  const account = useStore((s) => s.providers[provider]?.accounts?.find((a) => a.id === accountId));
  const [step, setStep] = useState<'idle' | 'ask' | 'busy'>('idle');
  const [note, setNote] = useState<string>();
  const key = useRef<string>('');
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (step === 'ask') confirmRef.current?.focus();
  }, [step]);

  if (!resets && step === 'idle' && !note) return null;
  const n = resets?.available ?? 0;
  const name = account?.label || (account ? accountName(account) : 'Main');
  const question = `Use 1 of ${n} ${n === 1 ? 'reset' : 'resets'} on ${windowPhrase(limit)} of ${name}?`;

  const run = async () => {
    setStep('busy');
    try {
      const { outcome } = await spendLimitReset(provider, accountId === DEFAULT_ACCOUNT ? undefined : accountId, key.current);
      setNote(outcome === 'reset' ? undefined : OUTCOME[outcome]);
      void readLimitsNow(provider, accountId === DEFAULT_ACCOUNT ? undefined : accountId);
      key.current = '';
      setStep('idle');
    } catch (err) {
      // The same key on a retry never spends a second reset.
      setNote(err instanceof Error && err.message ? err.message : 'The reset did not go through');
      setStep('ask');
    }
  };

  return (
    <div className={cx('ul-resets', className)} data-compact={compact || undefined} data-step={step} role="group" aria-label="Resets">
      {step === 'idle' ? (
        <>
          <span className="ul-resets-count num">{note ?? resetsText(n)}</span>
          {n > 0 && (
            <button
              type="button"
              className="btn btn-sm ul-resets-btn"
              onClick={() => {
                key.current ||= newKey();
                setNote(undefined);
                setStep('ask');
              }}
            >
              Reset
            </button>
          )}
        </>
      ) : (
        <>
          <span className="ul-resets-ask">{note && step === 'ask' ? note : question}</span>
          <span className="ul-resets-actions">
            <button type="button" className="btn btn-sm" disabled={step === 'busy'} onClick={() => (setStep('idle'), setNote(undefined))}>
              Cancel
            </button>
            <button ref={confirmRef} type="button" className="btn btn-sm btn-primary" disabled={step === 'busy'} aria-label={question} onClick={() => void run()}>
              {step === 'busy' ? 'Resetting' : 'Use reset'}
            </button>
          </span>
        </>
      )}
    </div>
  );
}
