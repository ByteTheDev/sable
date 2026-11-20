import { useSyncExternalStore } from 'react';
import { registerPlugin } from '@capacitor/core';
import { conn } from './conn';
import { isNative, openExternal } from './native';

/**
 * Files the agent handed over, downloaded inside the app (android/…/FilesPlugin.java: Android's
 * DownloadManager into Downloads/Sable). A card asks the desktop for the file's one-time link
 * (`phone.fileLink`), starts the download, shows its progress (read four times a second while it
 * runs) and offers Open when it is there. What was downloaded is remembered per file across
 * restarts (`sable.downloads`), so Open stays. In the web preview the download is acted (progress
 * over a moment, then Open opens the link) so every state can be looked at.
 */

export type DownloadState = 'idle' | 'asking' | 'pending' | 'running' | 'paused' | 'done' | 'failed';
export interface Download {
  state: DownloadState;
  /** DownloadManager's id once it started. */
  id?: string;
  bytes?: number;
  total?: number;
  error?: string;
  url?: string;
}

type Status = { state: 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'gone'; bytes?: number; total?: number; reason?: number };
const Files = registerPlugin<{
  download(o: { url: string; name: string; mime?: string; from?: string }): Promise<{ id: string }>;
  status(o: { id: string }): Promise<Status>;
  open(o: { id: string; mime?: string }): Promise<void>;
  cancel(o: { id: string }): Promise<void>;
}>('Files');

const KEY = 'sable.downloads';
const IDLE: Download = { state: 'idle' };
let all: Record<string, Download> = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Download>;
    // Kept: finished ones (Open) and ones still running in the system's hands (read again below).
    const out: Record<string, Download> = {};
    for (const [k, d] of Object.entries(raw)) if (d.id && (d.state === 'done' || d.state === 'running' || d.state === 'pending' || d.state === 'paused')) out[k] = d;
    return out;
  } catch {
    return {};
  }
})();
const subs = new Set<() => void>();

function save() {
  try {
    const keep: Record<string, Download> = {};
    // The newest 60 are enough to remember.
    for (const [k, d] of Object.entries(all).slice(-60)) if (d.id) keep[k] = { state: d.state, id: d.id, bytes: d.bytes, total: d.total };
    localStorage.setItem(KEY, JSON.stringify(keep));
  } catch {
    /* full */
  }
}

function set(key: string, d: Download) {
  all = { ...all, [key]: d };
  subs.forEach((f) => f());
  if (d.state === 'done' || d.state === 'failed' || d.state === 'idle' || d.id) save();
}

export const downloadKey = (sid: string, itemId: string, index: number) => `${sid}:${itemId}:${index}`;

export function useDownload(key: string): Download {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => all[key] ?? IDLE,
  );
}

const MIME: Record<string, string> = {
  apk: 'application/vnd.android.package-archive',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  json: 'application/json',
  md: 'text/plain',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};
export const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''];

// ── progress: read while something runs ──

let timer = 0;
function poll() {
  if (timer) return;
  timer = window.setInterval(async () => {
    const live = Object.entries(all).filter(([, d]) => d.id && (d.state === 'pending' || d.state === 'running' || d.state === 'paused'));
    if (!live.length) {
      clearInterval(timer);
      timer = 0;
      return;
    }
    for (const [k, d] of live) {
      try {
        const s = await Files.status({ id: d.id! });
        if (s.state === 'gone') set(k, { state: 'failed', error: 'The download was removed.' });
        else if (s.state === 'failed') set(k, { ...d, state: 'failed', error: reasonText(s.reason) });
        else set(k, { ...d, state: s.state, bytes: s.bytes, total: s.total && s.total > 0 ? s.total : d.total });
      } catch {
        /* asked again next time */
      }
    }
  }, 250);
}

function reasonText(r?: number) {
  // DownloadManager's ERROR_* codes that a person can do something about.
  if (r === 1006) return 'Not enough space on this phone.';
  if (r === 1004 || r === 1002 || (r !== undefined && r >= 400 && r < 600)) return 'The computer no longer has the file, or the link ran out.';
  return 'The download stopped. Try again.';
}

// Downloads still running when the app was closed: read again.
if (isNative && Object.values(all).some((d) => d.state !== 'done')) setTimeout(poll, 600);

/** Starts a download of one file of a share step. */
export async function startDownload(key: string, p: { sid: string; itemId: string; index: number; name: string; size?: number; from?: string }) {
  const cur = all[key];
  if (cur && (cur.state === 'asking' || cur.state === 'pending' || cur.state === 'running')) return;
  set(key, { state: 'asking', total: p.size });
  try {
    const r = await conn.call('phone.fileLink', { sessionId: p.sid, itemId: p.itemId, index: p.index });
    const url = conn.httpUrl(r.path);
    if (!url) throw new Error('The computer is not connected.');
    const total = r.size ?? p.size;
    if (!isNative) return void act(key, url, total);
    const { id } = await Files.download({ url, name: p.name, mime: mimeOf(p.name), from: p.from });
    set(key, { state: 'pending', id, bytes: 0, total, url });
    poll();
  } catch (err) {
    set(key, { state: 'failed', total: p.size, error: (err as Error).message });
    throw err;
  }
}

export async function cancelDownload(key: string) {
  const d = all[key];
  if (d?.id && isNative) await Files.cancel({ id: d.id }).catch(() => {});
  set(key, { state: 'idle' });
}

/** Opens a finished download with the app for its kind (an APK: the installer). */
export async function openDownload(key: string, name: string) {
  const d = all[key];
  if (!d) return;
  if (!isNative) return void (d.url && openExternal(d.url));
  try {
    await Files.open({ id: d.id!, mime: mimeOf(name) });
  } catch (err) {
    // Gone from the phone (deleted in Files): it can be downloaded again.
    if (/no longer on this phone/i.test((err as Error).message)) set(key, { state: 'idle' });
    throw err;
  }
}

/** The web preview: a download acted out over about two seconds. */
function act(key: string, url: string, total = 1_000_000) {
  const t0 = performance.now();
  const ms = Number(localStorage.getItem('sable.debug.downloadMs') ?? 2200);
  set(key, { state: 'running', bytes: 0, total, url, id: 'web' });
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    if (all[key]?.state !== 'running') return;
    if (k >= 1) return set(key, { state: 'done', bytes: total, total, url, id: 'web' });
    set(key, { state: 'running', bytes: Math.round(total * k * k * (3 - 2 * k)), total, url, id: 'web' });
    setTimeout(tick, 120);
  };
  setTimeout(tick, 200);
}
