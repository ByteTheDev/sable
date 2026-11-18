import { useEffect, useState } from 'react';
import { bridge } from '@/lib/bridge';

/**
 * Whether adb was found on this machine (the "Device" capability is on by default then). Asked of
 * the bridge once per window, the first time something wants to know; null until it answered.
 */
let known: boolean | null = null;
let asking: Promise<boolean> | null = null;

export function androidAvailable(): Promise<boolean> {
  if (known !== null) return Promise.resolve(known);
  asking ??= bridge.call('device.list', {}, 20_000).then(
    (s) => (known = s.adb),
    () => {
      asking = null;
      return false;
    },
  );
  return asking;
}

export function useAndroidAvailable(): boolean | null {
  const [v, setV] = useState(known);
  useEffect(() => {
    if (known !== null) return;
    let live = true;
    void androidAvailable().then((a) => live && setV(a));
    return () => {
      live = false;
    };
  }, []);
  return v;
}
