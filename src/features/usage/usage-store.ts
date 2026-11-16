import { create } from 'zustand';
import type { UsageReport } from '@shared/protocol';
import { bridge } from '@/lib/bridge';
import { fetchUsage } from '@/state/actions';

/**
 * Local usage for the Usage view. It is large and only this view reads it, so it lives here and
 * not in the app store. The bridge answers at once with what it knows and pushes a fresh report
 * when a scan finishes.
 */
interface UsageState {
  report: UsageReport | null;
  loading: boolean;
  /** The bridge could not answer (an older bridge without usage, or an error). */
  failed: boolean;
}

export const useUsageStore = create<UsageState>(() => ({ report: null, loading: false, failed: false }));

// Development: headless checks can look at (and stand in) the report.
if (import.meta.env.DEV) Object.assign(window, { sableUsage: useUsageStore });

let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  bridge.on((e) => {
    if (e.type === 'usage.updated') useUsageStore.setState({ report: e.report, failed: false });
  });
}

/** Asks for the report; `refresh` scans for changes first (the result arrives as an event). */
export function loadUsage(refresh = false) {
  listen();
  useUsageStore.setState({ loading: true });
  return fetchUsage(refresh)
    .then((report) =>
      useUsageStore.setState((s) => ({
        // An event may have brought a newer one already.
        report: s.report && (s.report.scannedAt ?? 0) > (report.scannedAt ?? 0) ? s.report : report,
        loading: false,
        failed: false,
      })),
    )
    .catch(() => useUsageStore.setState({ loading: false, failed: true }));
}
