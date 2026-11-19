import { memo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { DEFAULT_ACCOUNT, type SpareWait } from '@shared/protocol';
import { clock } from '@/features/usage/format';
import { useNow } from '@/lib/useNow';
import { cancelSpare, startSpareNow } from '@/state/actions';
import { accountName } from '@/state/hooks';
import { useStore } from '@/state/store';
import './until.css';
import './spare.css';

const rise = {
  initial: { opacity: 0, y: 10, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 4, transition: { duration: 0.14, ease: [0.5, 0, 0.9, 0.4] as const } },
  transition: { type: 'spring' as const, stiffness: 460, damping: 36 },
};

/** A small clock: a ring with two hands. The minute hand sweeps up once when it appears. */
export function SpareClock({ size = 16 }: { size?: number }) {
  return (
    <svg className="sp-clock" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.25" />
      <path className="sp-hour" d="M8 8l2.4 1.4" />
      <path className="sp-minute" d="M8 8V4.1" />
    </svg>
  );
}

/** "Continues at 14:00 on Ultra2", "Starts after 15:20 on Max3", "Starts when there is spare". */
export function spareLine(wait: SpareWait, now: number, account: string | undefined): { lead: string; at?: string; on?: string } {
  const at = wait.at && wait.at > now ? clock(wait.at, now) : undefined;
  if (wait.reason === 'reset') return at ? { lead: 'Continues at', at, on: account } : { lead: 'Continues now', on: account };
  if (at) return { lead: 'Starts after', at, on: account };
  return { lead: 'Starts when there is spare' };
}

/** The account a wait names, by its name, when its agent has more than one. */
function useWaitAccount(sessionId: string, wait: SpareWait | null): string | undefined {
  return useStore((s) => {
    const provider = s.sessions[sessionId]?.provider;
    const accounts = provider ? s.providers[provider]?.accounts : undefined;
    if (!wait?.accountId || !accounts || accounts.length < 2) return undefined;
    return accountName(accounts.find((a) => a.id === (wait.accountId ?? DEFAULT_ACCOUNT)));
  });
}

/**
 * Spare, above the composer: the chat waits to start by itself. One quiet line with when and on
 * which account, Start now (a held message) and Cancel. Gone while the chat works.
 */
export const SpareStrip = memo(function SpareStrip({ sessionId }: { sessionId: string }) {
  const wait = useStore((s) => s.sessions[sessionId]?.spare ?? null);
  const working = useStore((s) => {
    const st = s.sessions[sessionId]?.status;
    return st === 'running' || st === 'starting' || st === 'awaiting';
  });
  const account = useWaitAccount(sessionId, wait);
  const now = useNow();
  const shown = wait && !working ? wait : null;
  const line = shown ? spareLine(shown, now, account) : null;

  return (
    <AnimatePresence initial={false}>
      {shown && line && (
        <motion.div key="spare" className="us-slot" {...rise}>
          <section className="us sp" data-spot aria-live="polite">
            <span className="us-mark">
              <SpareClock />
            </span>
            <span className="us-label truncate">
              {line.lead}
              {line.at && (
                <>
                  {' '}
                  <span className="us-cmd num">{line.at}</span>
                </>
              )}
              {line.on && (
                <>
                  {' on '}
                  <span className="us-cmd">{line.on}</span>
                </>
              )}
            </span>
            <span className="us-actions">
              {shown.reason === 'spare' && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void startSpareNow(sessionId)}>
                  Start now
                </button>
              )}
              <button type="button" className="btn btn-ghost btn-sm" aria-label="Cancel waiting" onClick={() => void cancelSpare(sessionId)}>
                Cancel
              </button>
            </span>
          </section>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
