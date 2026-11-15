import { useEffect, useRef } from 'react';
import { setSettings } from '@/state/actions';
import { useStore } from '@/state/store';

/**
 * Whether the first-run welcome should show. Decided when the first `app.hello` arrives:
 * an install from before the welcome existed (it already has sessions or projects) counts as
 * onboarded and is marked so quietly. After that, `settings.onboarded` alone decides, so
 * "Show the welcome again" in Settings brings it back.
 */
export function useOnboarding(enabled: boolean): boolean {
  const ready = useStore((s) => s.ready);
  const onboarded = useStore((s) => s.settings.onboarded);
  const legacy = useRef<boolean | null>(null);

  if (ready && legacy.current === null) {
    const s = useStore.getState();
    legacy.current = !onboarded && (Object.keys(s.sessions).length > 0 || s.projects.length > 0);
  }
  if (onboarded && legacy.current) legacy.current = false;

  useEffect(() => {
    if (ready && legacy.current) void setSettings({ onboarded: true });
  }, [ready]);

  return enabled && ready && !onboarded && !legacy.current;
}
