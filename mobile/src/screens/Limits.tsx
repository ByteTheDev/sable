import type { CSSProperties } from 'react';
import type { AccountInfo, ProviderId, RateLimit } from '@shared/protocol';
import { resetIn } from '@desk/lib/format';
import { useStore } from '@m/lib/store';
import { useNow } from '@m/lib/useNow';
import { ProviderMark } from '@m/ui/marks';
import { Sheet } from '@m/ui/Sheet';

/** Each account's plan windows, as last read on the desktop: how full, and when they reset. */
export function LimitsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const providers = useStore((s) => s.providers);
  const limits = useStore((s) => s.limits);
  const now = useNow();

  const rows: { provider: ProviderId; account: AccountInfo; windows: RateLimit[]; several: boolean }[] = [];
  for (const id of ['claude', 'codex', 'demo'] as ProviderId[]) {
    const accounts = (providers[id]?.accounts ?? []).filter((a) => a.auth.loggedIn);
    for (const a of accounts) {
      const windows = (limits[`${id}:${a.id}`]?.limits ?? a.limits ?? []).filter((w) => w.percent >= 0);
      rows.push({ provider: id, account: a, windows, several: accounts.length > 1 });
    }
  }

  let n = 0;
  return (
    <Sheet open={open} onClose={onClose} title="Limits">
      {rows.length === 0 ? (
        <p className="empty">No limits known yet.</p>
      ) : (
        <div className="limits">
          {rows.map(({ provider, account, windows, several }) => (
            <section key={`${provider}:${account.id}`} className="limit-acct">
              <header className="limit-head">
                <ProviderMark provider={provider} size={17} />
                <span className="limit-name">{account.label}</span>
                {account.auth.plan && <span className="limit-plan">{account.auth.plan}</span>}
                {/* Which account new chats use: only worth saying when there is a choice. */}
                {several && account.isDefault && <span className="limit-def">Default</span>}
              </header>
              {windows.length === 0 ? (
                <p className="limit-none">Not read yet</p>
              ) : (
                windows.map((w) => {
                  const p = Math.min(1, Math.max(0, w.percent / 100));
                  return (
                    <div key={w.id} className="limit-row" data-level={w.percent >= 90 ? 'high' : w.percent >= 70 ? 'mid' : undefined}>
                      <div className="limit-line">
                        <span className="limit-label">{w.label}</span>
                        <span className="limit-val num">
                          {Math.round(w.percent)}
                          <small>%</small>
                        </span>
                      </div>
                      <div className="meter" style={{ '--p': p, '--d': `${n++ * 45}ms` } as CSSProperties}>
                        <span className="meter-fill" />
                      </div>
                      {w.resetsAt ? <span className="limit-reset num">{resetIn(w.resetsAt, now) === 'now' ? 'Resets now' : `Resets in ${resetIn(w.resetsAt, now)}`}</span> : null}
                    </div>
                  );
                })
              )}
            </section>
          ))}
        </div>
      )}
    </Sheet>
  );
}
