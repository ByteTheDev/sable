import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Preferences } from '@capacitor/preferences';
import type { Pairing } from './conn';

/** Thin wrappers over the Capacitor plugins, quiet when a plugin is missing (the web preview). */

export const isNative = Capacitor.isNativePlatform();

export async function loadPairing(): Promise<Pairing | null> {
  try {
    const { value } = await Preferences.get({ key: 'pairing' });
    if (!value) return null;
    const p = JSON.parse(value) as Pairing;
    return p && typeof p.token === 'string' && Array.isArray(p.hosts) ? p : null;
  } catch {
    return null;
  }
}

export async function savePairing(p: Pairing | null) {
  try {
    if (p) await Preferences.set({ key: 'pairing', value: JSON.stringify(p) });
    else await Preferences.remove({ key: 'pairing' });
  } catch {
    /* web preview without storage */
  }
}

export async function loadPref<T>(key: string, fallback: T): Promise<T> {
  try {
    const { value } = await Preferences.get({ key });
    return value == null ? fallback : (JSON.parse(value) as T);
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown) {
  void Preferences.set({ key, value: JSON.stringify(value) }).catch(() => {});
}

export type HapticKind = 'tap' | 'send' | 'select' | 'success' | 'warning' | 'deny';

export function haptic(kind: HapticKind) {
  if (!isNative) return;
  const run = () => {
    switch (kind) {
      case 'tap':
        return Haptics.impact({ style: ImpactStyle.Light });
      case 'send':
        return Haptics.impact({ style: ImpactStyle.Medium });
      case 'select':
        return Haptics.selectionChanged();
      case 'success':
        return Haptics.notification({ type: NotificationType.Success });
      case 'warning':
        return Haptics.notification({ type: NotificationType.Warning });
      case 'deny':
        return Haptics.notification({ type: NotificationType.Error });
    }
  };
  void run()?.catch(() => {});
}

export async function deviceName(): Promise<string> {
  try {
    const info = await Device.getInfo();
    const name = (info.name ?? '').trim();
    if (name && !/^sdk_|^generic/i.test(name)) return name;
    const model = (info.model ?? '').trim();
    if (model && !/^sdk_|gphone/i.test(model)) return `${info.manufacturer ? info.manufacturer[0].toUpperCase() + info.manufacturer.slice(1) + ' ' : ''}${model}`.trim();
    return isNative ? 'Android phone' : 'Browser';
  } catch {
    return 'Phone';
  }
}

// ── notifications: a turn ended or waits on you, while the app is in the background ──

let channelMade = false;

/** One notification per chat: its newest state replaces the last ("Waiting for you", then "Done"). */
const idFor = (sessionId: string) => {
  let h = 7;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) | 0;
  return (Math.abs(h) % 2_000_000_000) + 1;
};

export async function notificationsAllowed(): Promise<boolean> {
  if (!isNative) return false;
  try {
    return (await LocalNotifications.checkPermissions()).display === 'granted';
  } catch {
    return false;
  }
}

export async function askNotifications(): Promise<boolean> {
  if (!isNative) return false;
  try {
    const r = await LocalNotifications.requestPermissions();
    return r.display === 'granted';
  } catch {
    return false;
  }
}

export async function notify(title: string, body: string, sessionId: string) {
  if (!isNative) return;
  try {
    // Never ask from the background (the plugin would try to show a prompt): only post when allowed.
    if ((await LocalNotifications.checkPermissions()).display !== 'granted') return;
    if (!channelMade) {
      channelMade = true;
      await LocalNotifications.createChannel({ id: 'turns', name: 'Turns', description: 'A turn ended or waits for you', importance: 4, visibility: 1, vibration: true }).catch(() => {});
    }
    await LocalNotifications.schedule({
      // Shown now, not at a time: no exact alarm (asking for one would open a settings screen, impossible from the background).
      notifications: [{ id: idFor(sessionId), title, body: body.slice(0, 180), channelId: 'turns', extra: { sessionId }, smallIcon: 'ic_stat_sable', iconColor: '#f2f1ee', isExactNotification: false }],
    });
  } catch {
    /* not allowed */
  }
}

export function onNotificationTap(fn: (sessionId: string) => void) {
  if (!isNative) return () => {};
  const h = LocalNotifications.addListener('localNotificationActionPerformed', (a) => {
    const id = (a.notification.extra as { sessionId?: string } | undefined)?.sessionId;
    if (id) fn(id);
  });
  return () => void h.then((x) => x.remove());
}

// ── the connection kept in the background (android/…/KeepAliveService.java) ──

const KeepAlive = registerPlugin<{ arm(o: { text?: string }): Promise<void> }>('KeepAlive');
let armed: string | null = null;

/**
 * While a chat runs or waits, `text` names it: leaving the app then keeps the connection (Android
 * would cut it), so the phone can say when it is done or waits. Null lets it go.
 */
export function keepAlive(text: string | null) {
  if (!isNative || text === armed) return;
  armed = text;
  void KeepAlive.arm(text ? { text } : {}).catch(() => {});
}

// ── app lifecycle ──

let foreground = typeof document === 'undefined' || document.visibilityState !== 'hidden';
export const inForeground = () => foreground;

export function onAppState(fn: (active: boolean) => void) {
  const onVis = () => {
    foreground = document.visibilityState === 'visible';
    fn(foreground);
  };
  document.addEventListener('visibilitychange', onVis);
  let remove: (() => void) | undefined;
  if (isNative) {
    const h = App.addListener('appStateChange', ({ isActive }) => {
      foreground = isActive;
      fn(isActive);
    });
    remove = () => void h.then((x) => x.remove());
  }
  return () => {
    document.removeEventListener('visibilitychange', onVis);
    remove?.();
  };
}

export function onBackButton(fn: () => boolean) {
  if (!isNative) return () => {};
  const h = App.addListener('backButton', () => {
    if (!fn()) void App.minimizeApp();
  });
  return () => void h.then((x) => x.remove());
}

/** Pairing links opened from the camera or another app (`sable://pair?...`), the launch one included. */
export function onPairLink(fn: (url: string) => void) {
  if (!isNative) {
    const q = new URLSearchParams(location.search).get('pair');
    if (q) setTimeout(() => fn(q), 0);
    return () => {};
  }
  void App.getLaunchUrl().then((r) => r?.url && fn(r.url)).catch(() => {});
  const h = App.addListener('appUrlOpen', ({ url }) => fn(url));
  return () => void h.then((x) => x.remove());
}

export function openExternal(url: string) {
  window.open(url, '_blank', 'noopener');
}
