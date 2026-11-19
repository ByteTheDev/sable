/**
 * Pictures of local pages, taken by the installed Edge or Chrome running headless. Talks the
 * DevTools protocol over the browser's pipe (fd 3 and 4), so nothing is downloaded or bundled
 * and no port is opened. One browser at most, started on the first capture and closed after a
 * minute without one; captures run one at a time, each with a time limit.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { Thumb } from './capture-diff';

export interface ViewSpec {
  kind: 'desktop' | 'phone';
  width: number;
  height: number;
  /** Device pixels per CSS pixel. */
  scale: number;
  mobile: boolean;
}

export const DESKTOP: ViewSpec = { kind: 'desktop', width: 1440, height: 900, scale: 1, mobile: false };
export const PHONE: ViewSpec = { kind: 'phone', width: 390, height: 844, scale: 2, mobile: true };

/** CSS pixels per thumbnail cell. */
export const CELL = 4;

export interface Picture {
  view: ViewSpec;
  jpeg: Buffer;
  /** For the diff: one cell per `CELL` CSS pixels. */
  thumb: Thumb;
  /** When the picture was taken. */
  at: number;
}

export interface ShootResult {
  pictures: Picture[];
  /** The page declares a responsive viewport (width=device-width). */
  responsive: boolean;
}

export interface Capturer {
  /** The page at the desktop size, and at a phone size when `phone` is true (or 'auto' and the page is responsive). */
  shoot(url: string, opts?: { phone?: boolean | 'auto' }): Promise<ShootResult>;
  dispose(): Promise<void>;
}

/** The installed browser to drive, or undefined (then captures are off). */
export function findBrowser(): string | undefined {
  const own = process.env.SABLE_CAPTURE_BROWSER;
  if (own && existsSync(own)) return own;
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          path.join(local, 'Google/Chrome/Application/chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((p) => existsSync(p));
}

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string }; sessionId?: string };

/** A DevTools protocol connection over the browser's pipe: JSON messages separated by NUL. */
class Pipe {
  private next = 1;
  private calls = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private waiters = new Set<(m: Msg) => boolean>();
  private chunks: Buffer[] = [];
  closed = false;

  constructor(
    private input: Writable,
    output: Readable,
  ) {
    output.on('data', (chunk: Buffer) => this.read(chunk));
    output.on('close', () => this.close(new Error('The browser closed')));
    input.on('error', () => {});
  }

  private read(chunk: Buffer) {
    let at = chunk.indexOf(0);
    while (at >= 0) {
      this.chunks.push(chunk.subarray(0, at));
      const raw = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = [];
      chunk = chunk.subarray(at + 1);
      at = chunk.indexOf(0);
      try {
        this.dispatch(JSON.parse(raw) as Msg);
      } catch {
        /* not a message */
      }
    }
    if (chunk.length) this.chunks.push(chunk);
  }

  private dispatch(m: Msg) {
    if (m.id !== undefined) {
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      if (m.error) c.reject(new Error(m.error.message));
      else c.resolve(m.result ?? {});
      return;
    }
    for (const w of [...this.waiters]) if (w(m)) this.waiters.delete(w);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The browser closed'));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject });
      this.input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }

  /** The next event `method` (from `sessionId`), or a rejection after `ms`. */
  event(method: string, sessionId: string | undefined, ms: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(w);
        reject(new Error('The page took too long to load'));
      }, ms);
      const w = (m: Msg) => {
        if (m.method !== method || (sessionId && m.sessionId !== sessionId)) return false;
        clearTimeout(timer);
        resolve(m.params ?? {});
        return true;
      };
      this.waiters.add(w);
    });
  }

  close(err: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.calls.values()) c.reject(err);
    this.calls.clear();
    this.waiters.clear();
  }
}

/** Runs in the decode page: a JPEG (base64) drawn down to `w` x `h`, its RGB bytes as base64. */
const THUMB_SRC = `async (b64, w, h) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const px = g.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { out[j] = px[i]; out[j + 1] = px[i + 1]; out[j + 2] = px[i + 2]; }
  let s = '';
  for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
  return btoa(s);
}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(what)), ms)))]).finally(() => clearTimeout(timer));
}

export interface BrowserCapturerOptions {
  executable: string;
  /** Close the browser after this long without a capture. */
  idleMs?: number;
  /** Most time one page may take (load, settle, picture). */
  timeoutMs?: number;
  log?: (...args: unknown[]) => void;
}

export class BrowserCapturer implements Capturer {
  private proc?: ChildProcess;
  private pipe?: Pipe;
  private profile?: string;
  private lab?: string;
  private starting?: Promise<Pipe>;
  private idleTimer?: NodeJS.Timeout;
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private disposed = false;

  constructor(private opts: BrowserCapturerOptions) {}

  shoot(url: string, opts: { phone?: boolean | 'auto' } = {}): Promise<ShootResult> {
    this.pending++;
    clearTimeout(this.idleTimer);
    const run = this.chain.then(() => within(this.run(url, opts), this.opts.timeoutMs ?? 20_000, 'The page took too long to capture'));
    this.chain = run.catch(() => {});
    return run.finally(() => {
      if (--this.pending === 0 && !this.disposed) {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => void this.stop(), this.opts.idleMs ?? 60_000);
        this.idleTimer.unref?.();
      }
    });
  }

  private browser(): Promise<Pipe> {
    if (this.pipe && !this.pipe.closed) return Promise.resolve(this.pipe);
    this.starting ??= this.launch().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async launch(): Promise<Pipe> {
    this.profile = mkdtempSync(path.join(tmpdir(), 'sable-capture-'));
    const args = [
      '--headless',
      '--remote-debugging-pipe',
      `--user-data-dir=${this.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
      '--hide-scrollbars',
      '--mute-audio',
      '--force-color-profile=srgb',
      'about:blank',
    ];
    const proc = spawn(this.opts.executable, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    const pipe = new Pipe(proc.stdio[3] as Writable, proc.stdio[4] as Readable);
    this.pipe = pipe;
    proc.once('exit', () => {
      pipe.close(new Error('The browser closed'));
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.pipe = undefined;
      this.lab = undefined;
      this.cleanup();
    });
    proc.once('error', (err) => pipe.close(err));
    await within(pipe.send('Browser.getVersion'), 15_000, 'The browser did not start');
    // A blank page kept for decoding pictures into thumbnails.
    const { targetId } = await pipe.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await pipe.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    this.lab = sessionId;
    this.opts.log?.('capture browser started');
    return pipe;
  }

  private async run(url: string, opts: { phone?: boolean | 'auto' }): Promise<ShootResult> {
    const pipe = await this.browser();
    // Both sizes at once (a before races the agent's first edit); 'auto' keeps the phone only for a responsive page.
    const [desktop, phone] = await Promise.all([this.picture(pipe, url, DESKTOP), opts.phone ? this.picture(pipe, url, PHONE).catch(() => null) : null]);
    const pictures = [desktop.picture];
    if (phone && (opts.phone === true || desktop.responsive)) pictures.push(phone.picture);
    return { pictures, responsive: desktop.responsive };
  }

  private async picture(pipe: Pipe, url: string, view: ViewSpec): Promise<{ picture: Picture; responsive: boolean }> {
    const { browserContextId } = await pipe.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true });
    try {
      const { targetId } = await pipe.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId });
      const { sessionId: sid } = await pipe.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      await pipe.send('Page.enable', {}, sid);
      await pipe.send('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: view.scale, mobile: view.mobile }, sid);
      if (view.mobile) await pipe.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
      // Pages that honour it skip their entrance motion, so the picture is the settled page.
      await pipe.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sid);
      const loaded = pipe.event('Page.loadEventFired', sid, 15_000);
      const nav = await pipe.send<{ errorText?: string }>('Page.navigate', { url }, sid);
      if (nav.errorText) {
        loaded.catch(() => {});
        throw new Error(`The page did not load (${nav.errorText})`);
      }
      await loaded;
      const evaluate = (expression: string) =>
        pipe.send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid).then((r) => r.result?.value);
      await within(evaluate('document.fonts ? document.fonts.ready.then(() => true) : true'), 3000, 'fonts').catch(() => {});
      // A moment for late styles, hydration and transitions to settle.
      await sleep(450);
      const responsive = view.kind === 'desktop' ? !!(await evaluate(`!!document.querySelector('meta[name="viewport"][content*="device-width"]')`).catch(() => false)) : false;
      const shot = await pipe.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 84, captureBeyondViewport: false }, sid);
      const at = Date.now();
      const thumb = await this.thumb(pipe, shot.data, Math.ceil(view.width / CELL), Math.ceil(view.height / CELL));
      return { picture: { view, jpeg: Buffer.from(shot.data, 'base64'), thumb, at }, responsive };
    } finally {
      await pipe.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    }
  }

  private async thumb(pipe: Pipe, b64: string, w: number, h: number): Promise<Thumb> {
    const r = await pipe.send<{ result?: { value?: string }; exceptionDetails?: { text?: string } }>(
      'Runtime.evaluate',
      { expression: `(${THUMB_SRC})(${JSON.stringify(b64)}, ${w}, ${h})`, awaitPromise: true, returnByValue: true },
      this.lab,
    );
    if (typeof r.result?.value !== 'string') throw new Error('Could not read the picture');
    return { w, h, data: new Uint8Array(Buffer.from(r.result.value, 'base64')) };
  }

  private async stop() {
    const proc = this.proc;
    const pipe = this.pipe;
    if (!proc) return;
    this.proc = undefined;
    this.pipe = undefined;
    this.lab = undefined;
    await within<unknown>(pipe?.send('Browser.close') ?? Promise.resolve(), 3000, 'close').catch(() => {});
    if (proc.exitCode === null) {
      await within(new Promise((r) => proc.once('exit', r)), 3000, 'exit').catch(() => proc.kill());
    }
    this.cleanup(true);
    this.opts.log?.('capture browser closed');
  }

  /** Removes the browser's throwaway profile: at once after a clean exit, else a moment later. */
  private cleanup(now = false) {
    const dir = this.profile;
    this.profile = undefined;
    if (!dir) return;
    const remove = () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
      } catch {
        /* still held: the OS temp cleanup takes it */
      }
    };
    if (now) remove();
    else setTimeout(remove, 500).unref?.();
  }

  async dispose() {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    await this.stop();
  }
}
