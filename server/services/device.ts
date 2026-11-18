import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflate } from 'node:zlib';
import type { DeviceFrame, DeviceInfo, DeviceKey, DeviceStatus } from '../../shared/protocol';
import type { App } from '../app';

/**
 * Android devices and the emulator, through adb: list them, start and stop an emulator without a
 * window, look at the screen, tap, swipe, type, press keys, install and launch apps, read an app's
 * log, open a link. The side panel's Device tab and the agents' device_* tools (providers/device-tool.ts)
 * both come here.
 *
 * Every adb call is a child process with a timeout, so nothing here can hold the bridge; nothing
 * runs until something asks (finding adb and the AVDs only looks at files). An emulator Sable
 * starts keeps running across a reload of the bridge in development and is stopped when the
 * process exits.
 */

export class DeviceError extends Error {}

export interface AdbResult {
  stdout: Buffer;
  stderr: string;
  /** 0 on success; -1 when adb could not run or timed out (see `error`). */
  code: number;
  error?: string;
}

/** Runs adb with these arguments. Tests pass a fake. */
export type AdbRun = (args: string[], opts: { timeout: number; maxBuffer?: number }) => Promise<AdbResult>;

/** The emulator process, as far as this service needs it. */
export interface EmulatorChild {
  pid?: number;
  exitCode: number | null;
  kill(): boolean;
  once(event: 'exit', cb: (code: number | null) => void): unknown;
  stderr?: NodeJS.ReadableStream | null;
}

export interface DeviceServiceOptions {
  /** The SDK folder (defaults to ANDROID_HOME, ANDROID_SDK_ROOT, then the usual place). */
  sdk?: string | null;
  /** adb's path, or null when there is none (defaults to the SDK's platform-tools, then the PATH). */
  adb?: string | null;
  /** The emulator's path, or null (defaults to the SDK's emulator folder). */
  emulator?: string | null;
  /** Where the AVDs live (defaults to ANDROID_AVD_HOME, then ~/.android/avd). */
  avdHome?: string;
  run?: AdbRun;
  spawnEmulator?: (bin: string, args: string[]) => EmulatorChild;
  /** How long to wait between boot checks (tests make it short). */
  bootPollMs?: number;
}

// ── finding the tools ──

const EXE = process.platform === 'win32' ? '.exe' : '';

/** The SDK folder, if one exists. */
export function findSdk(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = os.homedir();
  const candidates = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    process.platform === 'win32' && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
    process.platform === 'darwin' ? path.join(home, 'Library', 'Android', 'sdk') : path.join(home, 'Android', 'Sdk'),
  ];
  for (const c of candidates) if (c && isDir(c)) return c;
  return undefined;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** A program on the PATH, found by looking at files only. */
function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name + EXE);
    if (isFile(p)) return p;
  }
  return undefined;
}

function avdHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
  return path.join(env.ANDROID_USER_HOME || path.join(os.homedir(), '.android'), 'avd');
}

// ── what adb says ──

const STATES = new Set(['device', 'offline', 'unauthorized']);

/** `adb devices -l`, read. */
export function parseDevices(out: string): { serial: string; state: DeviceInfo['state']; model?: string }[] {
  const list: { serial: string; state: DeviceInfo['state']; model?: string }[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue;
    const m = /^(\S+)\s+(\S+)(.*)$/.exec(line);
    if (!m) continue;
    const model = /\bmodel:(\S+)/.exec(m[3])?.[1];
    list.push({ serial: m[1], state: STATES.has(m[2]) ? (m[2] as DeviceInfo['state']) : 'other', ...(model ? { model } : {}) });
  }
  return list;
}

export const deviceKind = (serial: string): DeviceInfo['kind'] => (serial.startsWith('emulator-') ? 'emulator' : serial.includes(':') || serial.includes('._adb-tls') ? 'wifi' : 'usb');

const KEYCODES: Record<DeviceKey, string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recent: 'KEYCODE_APP_SWITCH',
  enter: 'KEYCODE_ENTER',
  delete: 'KEYCODE_DEL',
  tab: 'KEYCODE_TAB',
  escape: 'KEYCODE_ESCAPE',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  menu: 'KEYCODE_MENU',
  power: 'KEYCODE_POWER',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
};
export const DEVICE_KEYS = Object.keys(KEYCODES) as DeviceKey[];

/** Quoted for the device's shell (adb joins its arguments into one command line there). */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** One line of text as `input text` takes it: spaces as %s, quoted for the shell. */
export function inputTextArg(line: string): string {
  return shQuote(line.replace(/ /g, '%s'));
}

export const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const ACTIVITY_RE = /^[A-Za-z0-9_.$]+$/;

export const TEXT_MAX = 2_000;
export const LOG_LINES_DEFAULT = 200;
export const LOG_LINES_MAX = 1_000;
export const LOG_LINE_MAX = 400;

/** Flags for an emulator nobody sees: no window, no sound, no boot animation, software GPU. */
export const EMULATOR_FLAGS = ['-no-window', '-no-audio', '-no-boot-anim', '-gpu', 'swiftshader_indirect'];

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height of a PNG, from its header. */
export function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ── pictures for the agent ──

/** A raw `screencap` (no -p): a 12 or 16 byte header, then the pixels. */
export function parseRawScreencap(buf: Buffer): { width: number; height: number; format: number; bpp: number; offset: number } | undefined {
  if (buf.length < 16) return undefined;
  const width = buf.readUInt32LE(0);
  const height = buf.readUInt32LE(4);
  const format = buf.readUInt32LE(8);
  if (!width || !height || width > 16_384 || height > 16_384) return undefined;
  const px = width * height;
  for (const offset of [16, 12]) {
    const rest = buf.length - offset;
    if (rest === px * 4 && (format === 1 || format === 2 || format === 5)) return { width, height, format, bpp: 4, offset };
    if (rest === px * 2 && format === 4) return { width, height, format, bpp: 2, offset };
  }
  return undefined;
}

/** How much smaller the agent's picture is than the screen: a whole factor, so the long edge is at most 1280. */
export const pictureScale = (width: number, height: number) => Math.max(1, Math.ceil(Math.max(width, height) / 1280));

let CRC: Uint32Array | undefined;
function crc32(buf: Buffer): number {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * A raw screen scaled down by a whole factor (each picture pixel the mean of k x k screen pixels)
 * and written as an RGB PNG; the compression runs off the main thread.
 */
export async function rawToPng(buf: Buffer, k: number): Promise<{ png: Buffer; width: number; height: number } | undefined> {
  const raw = parseRawScreencap(buf);
  if (!raw) return undefined;
  const { width, height, format, bpp, offset } = raw;
  const w = Math.floor(width / k);
  const h = Math.floor(height / k);
  const stride = w * 3 + 1;
  const out = Buffer.alloc(stride * h);
  const bgr = format === 5;
  const n = k * k;
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    // Filter "Up" on every row but the first: screens are mostly flat, so this packs well.
    out[row] = y === 0 ? 0 : 2;
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < k; dy++) {
        let i = offset + ((y * k + dy) * width + x * k) * bpp;
        for (let dx = 0; dx < k; dx++, i += bpp) {
          if (bpp === 4) {
            r += buf[bgr ? i + 2 : i];
            g += buf[i + 1];
            b += buf[bgr ? i : i + 2];
          } else {
            const v = buf[i] | (buf[i + 1] << 8);
            r += ((v >> 11) & 31) * 255 / 31;
            g += ((v >> 5) & 63) * 255 / 63;
            b += (v & 31) * 255 / 31;
          }
        }
      }
      const o = row + 1 + x * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  // Apply the Up filter from the bottom so each row still reads its unfiltered neighbour.
  for (let y = h - 1; y > 0; y--) {
    const row = y * stride + 1;
    const above = row - stride;
    for (let i = 0; i < w * 3; i++) out[row + i] = (out[row + i] - out[above + i]) & 0xff;
  }
  const idat = await new Promise<Buffer>((resolve, reject) => deflate(out, { level: 6 }, (err, z) => (err ? reject(err) : resolve(z))));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const png = Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  return { png, width: w, height: h };
}

// ── the screen's elements (uiautomator) ──

export interface ScreenElement {
  text: string;
  desc: string;
  id: string;
  cls: string;
  clickable: boolean;
  /** Device pixels: left, top, right, bottom. */
  bounds: [number, number, number, number];
}

const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, ' ').replace(/&amp;/g, '&');

/** The nodes of a uiautomator dump that show something or can be pressed. */
export function parseUiDump(xml: string): ScreenElement[] {
  const out: ScreenElement[] = [];
  for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const a = m[1];
    const attr = (k: string) => unxml(new RegExp(`\\b${k}="([^"]*)"`).exec(a)?.[1] ?? '');
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attr('bounds'));
    if (!b) continue;
    const bounds = [+b[1], +b[2], +b[3], +b[4]] as [number, number, number, number];
    if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) continue;
    const el: ScreenElement = { text: attr('text').trim(), desc: attr('content-desc').trim(), id: attr('resource-id'), cls: attr('class').replace(/^android\.widget\./, ''), clickable: attr('clickable') === 'true', bounds };
    if (el.text || el.desc || el.clickable) out.push(el);
  }
  return out;
}

/** The element whose words match best: exact text or description first, then one that starts with it, then one that contains it. */
export function findElement(list: ScreenElement[], query: string): ScreenElement | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const words = (e: ScreenElement) => [e.text, e.desc].map((s) => s.toLowerCase()).filter(Boolean);
  return list.find((e) => words(e).some((w) => w === q)) ?? list.find((e) => words(e).some((w) => w.startsWith(q))) ?? list.find((e) => words(e).some((w) => w.includes(q))) ?? list.find((e) => e.id.toLowerCase().endsWith(`/${q}`));
}

// ── the service ──

interface Started {
  avd: string;
  child: EmulatorChild;
  booted: boolean;
  stopping: boolean;
  startedAt: number;
}

/** Emulators this process started: kept on the global object, so a reloaded bridge still knows them. */
const REGISTRY_KEY = Symbol.for('sable.device.started');
function registry(): Map<string, Started> {
  const g = globalThis as unknown as Record<symbol, Map<string, Started> | undefined>;
  let m = g[REGISTRY_KEY];
  if (!m) {
    m = new Map();
    g[REGISTRY_KEY] = m;
    const reg = m;
    // The process is going away: ask each emulator to shut down (it saves its quick-boot state on its own).
    process.once('exit', () => {
      for (const [serial, s] of reg) {
        if (s.child.exitCode !== null) continue;
        try {
          const adb = defaultAdb();
          if (adb) execFileSync(adb, ['-s', serial, 'emu', 'kill'], { timeout: 4_000, windowsHide: true, stdio: 'ignore' });
        } catch {
          s.child.kill();
        }
      }
    });
  }
  return m;
}

function defaultAdb(): string | null {
  const sdk = findSdk();
  const own = sdk ? path.join(sdk, 'platform-tools', `adb${EXE}`) : undefined;
  return own && isFile(own) ? own : onPath('adb') ?? null;
}

function execRun(bin: string): AdbRun {
  return (args, { timeout, maxBuffer = 8 << 20 }) =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout, maxBuffer, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        const code = !e ? 0 : typeof e.code === 'number' ? e.code : -1;
        const error = !e ? undefined : e.killed ? `adb did not answer within ${Math.round(timeout / 1000)} s` : typeof e.code === 'number' ? undefined : e.message;
        resolve({ stdout: stdout ?? Buffer.alloc(0), stderr: stderr ? stderr.toString('utf8') : '', code, ...(error ? { error } : {}) });
      });
    });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

const clampInt = (v: unknown, lo: number, hi: number, name: string) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new DeviceError(`${name} must be a number.`);
  return Math.max(lo, Math.min(hi, Math.round(v)));
};

/** Device commands whose failures come back on a zero exit. */
const SNIFF = new Set(['input', 'am', 'wm', 'monkey', 'cmd']);

/** What adb or the device said went wrong, in one line. */
function failure(r: AdbResult, sniff = false): string | undefined {
  if (r.error) return r.error;
  const err = r.stderr.trim();
  const out = r.stdout.toString('utf8').trim();
  if (r.code !== 0) return (err || out || `adb exited with code ${r.code}`).split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
  // `input`, `am` and `wm` report many failures on a zero exit; a log or a screen dump may name exceptions as content.
  if (!sniff) return undefined;
  const bad = /(^|\n)\s*(Error[:\s].*|.*Exception.*|Failure \[.*\]|java\.lang\.\S+.*)/.exec(`${err}\n${out}`);
  return bad ? bad[2].trim().slice(0, 300) : undefined;
}

export class DeviceService {
  readonly sdk?: string;
  readonly adbPath: string | null;
  readonly emulatorPath: string | null;
  private readonly avdHome: string;
  private readonly runAdb: AdbRun;
  private readonly spawnEmu: (bin: string, args: string[]) => EmulatorChild;
  private readonly bootPollMs: number;
  private readonly started: Map<string, Started>;
  private names = new Map<string, string>();
  private sizes = new Map<string, { width: number; height: number }>();
  private shots = new Map<string, Promise<DeviceFrame>>();
  private active = 0;
  private waiting: (() => void)[] = [];
  preferred?: string;
  lastError?: string;
  onChange?: (status: DeviceStatus) => void;

  constructor(opts: DeviceServiceOptions = {}) {
    this.sdk = opts.sdk === null ? undefined : opts.sdk ?? findSdk();
    const sdkAdb = this.sdk ? path.join(this.sdk, 'platform-tools', `adb${EXE}`) : undefined;
    this.adbPath = opts.adb !== undefined ? opts.adb : sdkAdb && isFile(sdkAdb) ? sdkAdb : onPath('adb') ?? null;
    const sdkEmu = this.sdk ? path.join(this.sdk, 'emulator', `emulator${EXE}`) : undefined;
    this.emulatorPath = opts.emulator !== undefined ? opts.emulator : sdkEmu && isFile(sdkEmu) ? sdkEmu : null;
    this.avdHome = opts.avdHome ?? avdHomeDir();
    this.runAdb = opts.run ?? (this.adbPath ? execRun(this.adbPath) : async () => ({ stdout: Buffer.alloc(0), stderr: '', code: -1, error: 'adb was not found' }));
    this.spawnEmu =
      opts.spawnEmulator ??
      ((bin, args) => spawn(bin, args, { windowsHide: true, detached: false, stdio: ['ignore', 'ignore', 'pipe'], cwd: path.dirname(bin) }));
    this.bootPollMs = opts.bootPollMs ?? 2_000;
    // Tests get their own; the real service shares the process-wide registry.
    this.started = opts.run ? new Map() : registry();
  }

  /** adb, at most four at a time (the live screen, the agent and the tab's log share them). */
  async adb(args: string[], timeout = 15_000, maxBuffer?: number): Promise<AdbResult> {
    const r = await this.adbOnce(args, timeout, maxBuffer);
    // adb loses an emulator for a moment under load ("device offline"): a device call gets one more try after a breath.
    if (r.code !== 0 && args[0] === '-s' && /device offline|device '.*' not found/i.test(r.stderr)) {
      await sleep(this.bootPollMs < 100 ? 1 : 1_000);
      return this.adbOnce(args, timeout, maxBuffer);
    }
    return r;
  }

  private async adbOnce(args: string[], timeout: number, maxBuffer?: number): Promise<AdbResult> {
    while (this.active >= 4) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await this.runAdb(args, { timeout, maxBuffer });
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private needAdb() {
    if (!this.adbPath) throw new DeviceError('adb was not found. Install the Android SDK platform-tools and set ANDROID_HOME.');
  }

  /** A command on one device; throws with what went wrong. */
  private async on(serial: string, args: string[], timeout = 15_000, maxBuffer?: number): Promise<string> {
    this.needAdb();
    checkSerial(serial);
    const r = await this.adb(['-s', serial, ...args], timeout, maxBuffer);
    const bad = failure(r, args[0] === 'shell' && SNIFF.has(args[1]));
    if (bad) throw new DeviceError(bad);
    return r.stdout.toString('utf8');
  }

  private shell(serial: string, cmd: string[], timeout = 15_000): Promise<string> {
    return this.on(serial, ['shell', ...cmd], timeout);
  }

  /** The AVDs, from their .ini files (no process). */
  avds(): string[] {
    try {
      return readdirSync(this.avdHome)
        .filter((f) => f.endsWith('.ini') && isDir(path.join(this.avdHome, f.replace(/\.ini$/, '.avd'))))
        .map((f) => f.replace(/\.ini$/, ''))
        .sort();
    } catch {
      return [];
    }
  }

  async status(): Promise<DeviceStatus> {
    const base = { adb: !!this.adbPath, emulator: !!this.emulatorPath, avds: this.emulatorPath ? this.avds() : [], ...(this.preferred ? { preferred: this.preferred } : {}), ...(this.lastError ? { error: this.lastError } : {}) };
    if (!this.adbPath) return { ...base, devices: [] };
    const r = await this.adb(['devices', '-l'], 10_000);
    const listed = r.code === 0 ? parseDevices(r.stdout.toString('utf8')) : [];
    // An emulator's own name is its AVD's: asked once per serial.
    await Promise.all(
      listed
        .filter((d) => d.state === 'device' && deviceKind(d.serial) === 'emulator' && !this.names.has(d.serial))
        .map(async (d) => {
          const out = await this.adb(['-s', d.serial, 'emu', 'avd', 'name'], 4_000).catch(() => undefined);
          const name = out?.code === 0 ? out.stdout.toString('utf8').split(/\r?\n/)[0].trim() : '';
          if (name && name !== 'OK') this.names.set(d.serial, name);
        }),
    );
    const devices: DeviceInfo[] = listed.map((d) => ({
      serial: d.serial,
      state: d.state,
      kind: deviceKind(d.serial),
      name: this.started.get(d.serial)?.avd ?? this.names.get(d.serial) ?? (d.model ? d.model.replace(/_/g, ' ') : d.serial),
    }));
    for (const [serial, s] of this.started) {
      const d = devices.find((x) => x.serial === serial);
      if (!d) devices.push({ serial, state: 'booting', kind: 'emulator', name: s.avd, sable: true });
      else {
        d.sable = true;
        if (!s.booted) d.state = 'booting';
      }
    }
    // Forget names of serials that left (a new emulator may take the same port).
    for (const serial of this.names.keys()) if (!devices.some((d) => d.serial === serial)) this.names.delete(serial);
    return { ...base, devices };
  }

  private changed() {
    const cb = this.onChange;
    if (cb) void this.status().then(cb, () => {});
  }

  use(serial: string | null) {
    this.preferred = serial ?? undefined;
  }

  /** The device a call without a serial means: the one picked in the Device tab, else the only one that is ready. */
  async pick(serial?: string): Promise<DeviceInfo> {
    let st = await this.status();
    // A device that is offline for a moment (adb under load) gets one second to come back.
    if (st.devices.some((d) => d.state === 'offline') && !st.devices.some((d) => d.state === 'device' && (!serial || d.serial === serial))) {
      await sleep(this.bootPollMs < 100 ? 1 : 1_000);
      st = await this.status();
    }
    if (!st.adb) throw new DeviceError('adb was not found. Install the Android SDK platform-tools and set ANDROID_HOME.');
    if (serial) {
      const d = st.devices.find((x) => x.serial === serial);
      if (!d) throw new DeviceError(`No device ${serial}. Devices: ${st.devices.map((x) => x.serial).join(', ') || 'none'}.`);
      return ready(d);
    }
    const online = st.devices.filter((d) => d.state === 'device');
    const pref = st.preferred ? online.find((d) => d.serial === st.preferred) : undefined;
    if (pref) return pref;
    if (online.length === 1) return online[0];
    if (online.length > 1) throw new DeviceError(`Several devices are connected (${online.map((d) => `${d.serial}, ${d.name}`).join('; ')}). Pass \`serial\`.`);
    const booting = st.devices.find((d) => d.state === 'booting');
    if (booting) throw new DeviceError(`The emulator ${booting.name} is still starting. Try again in a few seconds.`);
    const waiting = st.devices.find((d) => d.state === 'unauthorized');
    if (waiting) throw new DeviceError(`${waiting.serial} has not allowed USB debugging yet: accept the prompt on the phone.`);
    throw new DeviceError(st.avds.length ? `No device is running. Start the emulator (${st.avds.join(', ')}) first.` : 'No device is connected, and no emulator is set up.');
  }

  // ── the emulator ──

  async start(avd?: string): Promise<{ serial: string }> {
    this.needAdb();
    if (!this.emulatorPath) throw new DeviceError('The Android emulator is not installed.');
    const avds = this.avds();
    const name = avd ?? avds[0];
    if (!name) throw new DeviceError('No virtual device is set up. Create one with avdmanager.');
    if (!avds.includes(name)) throw new DeviceError(`No virtual device named ${name}. There are: ${avds.join(', ') || 'none'}.`);
    const st = await this.status();
    const running = st.devices.find((d) => d.kind === 'emulator' && d.name === name);
    if (running) return { serial: running.serial };
    const used = new Set(st.devices.filter((d) => d.kind === 'emulator').map((d) => Number(d.serial.slice('emulator-'.length))));
    let port = 5554;
    while (used.has(port) && port < 5680) port += 2;
    const serial = `emulator-${port}`;
    const child = this.spawnEmu(this.emulatorPath, ['-avd', name, '-port', String(port), ...EMULATOR_FLAGS]);
    let tail = '';
    child.stderr?.on('data', (d: Buffer) => {
      tail = (tail + d.toString('utf8')).slice(-600);
    });
    const s: Started = { avd: name, child, booted: false, stopping: false, startedAt: Date.now() };
    this.lastError = undefined;
    this.started.set(serial, s);
    child.once('exit', (code) => {
      if (this.started.get(serial) !== s) return;
      this.started.delete(serial);
      if (!s.stopping && !s.booted) this.lastError = `The emulator stopped while starting${code ? ` (exit code ${code})` : ''}.${tail.trim() ? ` ${tail.trim().split(/\r?\n/).pop()}` : ''}`.slice(0, 300);
      this.changed();
    });
    this.changed();
    void this.watchBoot(serial, s);
    return { serial };
  }

  /** Checks every couple of seconds until the system says it finished booting (at most 5 minutes). */
  private async watchBoot(serial: string, s: Started) {
    const until = Date.now() + 300_000;
    while (this.started.get(serial) === s && Date.now() < until) {
      await sleep(this.bootPollMs);
      if (this.started.get(serial) !== s) return;
      const r = await this.adb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], 5_000).catch(() => undefined);
      if (r?.code === 0 && r.stdout.toString('utf8').trim() === '1') {
        s.booted = true;
        this.changed();
        return;
      }
    }
    if (this.started.get(serial) === s && !s.booted) {
      this.lastError = 'The emulator did not finish starting within 5 minutes.';
      this.changed();
    }
  }

  async stop(serial: string): Promise<{ ok: boolean }> {
    this.needAdb();
    checkSerial(serial);
    if (deviceKind(serial) !== 'emulator') throw new DeviceError('Only an emulator can be stopped from Sable.');
    const s = this.started.get(serial);
    if (s) s.stopping = true;
    await this.adb(['-s', serial, 'emu', 'kill'], 10_000).catch(() => undefined);
    if (s) {
      const gone = await new Promise<boolean>((resolve) => {
        if (s.child.exitCode !== null) return resolve(true);
        const t = setTimeout(() => resolve(false), 30_000);
        t.unref?.();
        s.child.once('exit', () => {
          clearTimeout(t);
          resolve(true);
        });
      });
      if (!gone) killTree(s.child);
      if (this.started.get(serial) === s) this.started.delete(serial);
    }
    this.sizes.delete(serial);
    this.changed();
    return { ok: true };
  }

  // ── looking ──

  /** The screen as a PNG in device pixels (the Device tab). One at a time per device: a second asker shares the first's. */
  screenshot(serial: string): Promise<DeviceFrame> {
    const going = this.shots.get(serial);
    if (going) return going;
    const p = (async () => {
      this.needAdb();
      checkSerial(serial);
      const r = await this.adb(['-s', serial, 'exec-out', 'screencap', '-p'], 15_000, 64 << 20);
      const size = pngSize(r.stdout);
      if (!size) throw new DeviceError(failure(r) ?? 'The device sent no picture.');
      this.sizes.set(serial, size);
      return { serial, data: `data:image/png;base64,${r.stdout.toString('base64')}`, ...size, at: Date.now() };
    })().finally(() => this.shots.delete(serial));
    this.shots.set(serial, p);
    return p;
  }

  /** The screen for the agent: scaled down by a whole factor, with the screen's own size. */
  async picture(serial: string): Promise<{ png: Buffer; width: number; height: number; screen: { width: number; height: number }; scale: number }> {
    this.needAdb();
    checkSerial(serial);
    const r = await this.adb(['-s', serial, 'exec-out', 'screencap'], 20_000, 128 << 20);
    const raw = parseRawScreencap(r.stdout);
    if (raw) {
      const scale = pictureScale(raw.width, raw.height);
      const pic = await rawToPng(r.stdout, scale);
      if (pic) {
        this.sizes.set(serial, { width: raw.width, height: raw.height });
        return { ...pic, screen: { width: raw.width, height: raw.height }, scale };
      }
    }
    // A format this does not read: the device's own PNG at full size.
    const frame = await this.screenshot(serial);
    return { png: Buffer.from(frame.data.slice(frame.data.indexOf(',') + 1), 'base64'), width: frame.width, height: frame.height, screen: { width: frame.width, height: frame.height }, scale: 1 };
  }

  /** The screen's size in device pixels (from the last picture, else from the window manager). */
  async screenSize(serial: string): Promise<{ width: number; height: number }> {
    const known = this.sizes.get(serial);
    if (known) return known;
    const out = await this.shell(serial, ['wm', 'size'], 8_000);
    const m = /Override size:\s*(\d+)x(\d+)/.exec(out) ?? /Physical size:\s*(\d+)x(\d+)/.exec(out);
    if (!m) throw new DeviceError('The device did not say its screen size.');
    const size = { width: +m[1], height: +m[2] };
    this.sizes.set(serial, size);
    return size;
  }

  /** What is on the screen and where (uiautomator). Fails while the screen animates. */
  async elements(serial: string): Promise<ScreenElement[]> {
    const out = await this.on(serial, ['exec-out', 'uiautomator', 'dump', '/dev/tty'], 20_000, 16 << 20);
    const xml = out.slice(out.indexOf('<?xml') >= 0 ? out.indexOf('<?xml') : 0);
    if (!xml.includes('<hierarchy')) throw new DeviceError(out.trim().split(/\r?\n/).pop()?.slice(0, 200) || 'The screen could not be read.');
    return parseUiDump(xml);
  }

  // ── acting ──

  async tap(serial: string, x: number, y: number, hold?: number): Promise<{ ok: boolean }> {
    const px = clampInt(x, 0, 16_384, 'x');
    const py = clampInt(y, 0, 16_384, 'y');
    if (hold && hold > 0) {
      const ms = clampInt(hold, 50, 5_000, 'hold');
      await this.shell(serial, ['input', 'swipe', String(px), String(py), String(px), String(py), String(ms)], 10_000 + ms);
    } else await this.shell(serial, ['input', 'tap', String(px), String(py)], 10_000);
    return { ok: true };
  }

  async swipe(serial: string, x1: number, y1: number, x2: number, y2: number, ms = 300): Promise<{ ok: boolean }> {
    const p = [clampInt(x1, 0, 16_384, 'x1'), clampInt(y1, 0, 16_384, 'y1'), clampInt(x2, 0, 16_384, 'x2'), clampInt(y2, 0, 16_384, 'y2')];
    const d = clampInt(ms, 30, 5_000, 'ms');
    await this.shell(serial, ['input', 'swipe', ...p.map(String), String(d)], 10_000 + d);
    return { ok: true };
  }

  /** Types into the focused field. Lines are joined with Enter. `input text` takes printable ASCII only. */
  async type(serial: string, text: string): Promise<{ ok: boolean }> {
    if (typeof text !== 'string' || !text) throw new DeviceError('Nothing to type.');
    if (text.length > TEXT_MAX) throw new DeviceError(`The text is longer than ${TEXT_MAX} characters.`);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const bad = lines.join('').replace(/[\x20-\x7e]/g, '');
    if (bad) throw new DeviceError(`The device types plain ASCII only; leave out ${JSON.stringify([...new Set(bad)].slice(0, 5).join(''))}.`);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await this.shell(serial, ['input', 'keyevent', KEYCODES.enter], 10_000);
      if (lines[i]) await this.shell(serial, ['input', 'text', inputTextArg(lines[i])], 15_000);
    }
    return { ok: true };
  }

  async key(serial: string, key: DeviceKey): Promise<{ ok: boolean }> {
    const code = KEYCODES[key];
    if (!code) throw new DeviceError(`Unknown key ${String(key)}. Keys: ${DEVICE_KEYS.join(', ')}.`);
    await this.shell(serial, ['input', 'keyevent', code], 10_000);
    return { ok: true };
  }

  async install(serial: string, apk: string): Promise<{ ok: boolean; text: string }> {
    if (!apk || !/\.apk$/i.test(apk)) throw new DeviceError('Give the path of an .apk file.');
    const file = path.resolve(apk);
    if (!isFile(file)) throw new DeviceError(`No file at ${file}.`);
    this.needAdb();
    checkSerial(serial);
    // -r keeps the app's data, -t allows test builds.
    const r = await this.adb(['-s', serial, 'install', '-r', '-t', file], 240_000, 4 << 20);
    const out = `${r.stdout.toString('utf8')}\n${r.stderr}`.trim();
    const ok = r.code === 0 && /\bSuccess\b/.test(out);
    const reason = /Failure \[([^\]]+)\]/.exec(out)?.[1] ?? r.error ?? out.split(/\r?\n/).pop() ?? '';
    return { ok, text: ok ? `Installed ${path.basename(file)}.` : `The install failed: ${reason.slice(0, 300)}` };
  }

  async launch(serial: string, pkg: string, activity?: string, restart?: boolean): Promise<{ ok: boolean; text: string }> {
    if (!PACKAGE_RE.test(pkg ?? '')) throw new DeviceError(`"${String(pkg).slice(0, 80)}" is not a package name (like com.example.app).`);
    if (activity && !ACTIVITY_RE.test(activity)) throw new DeviceError('The activity is a class name like .MainActivity.');
    if (restart) await this.shell(serial, ['am', 'force-stop', pkg], 10_000);
    let component = activity ? `${pkg}/${activity}` : undefined;
    if (!component) {
      const out = await this.shell(serial, ['cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', pkg], 10_000).catch(() => '');
      component = out.split(/\r?\n/).map((l) => l.trim()).reverse().find((l) => l.startsWith(`${pkg}/`));
    }
    if (component) {
      await this.shell(serial, ['am', 'start', '-n', component], 15_000);
      return { ok: true, text: `Started ${component}.` };
    }
    // No launcher activity found that way: let monkey find one.
    const out = await this.shell(serial, ['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], 15_000);
    if (/No activities found|monkey aborted/i.test(out)) return { ok: false, text: `${pkg} has no activity to launch. Is it installed?` };
    return { ok: true, text: `Started ${pkg}.` };
  }

  async packages(serial: string): Promise<{ packages: string[] }> {
    const out = await this.shell(serial, ['pm', 'list', 'packages', '-3'], 15_000);
    const packages = out
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter((p) => PACKAGE_RE.test(p))
      .sort();
    return { packages };
  }

  /** The newest log lines, of one app when `pkg` is given (by its process, else by its user id). */
  async logs(serial: string, pkg?: string, lines = LOG_LINES_DEFAULT, level: 'all' | 'warn' | 'error' = 'all'): Promise<{ lines: string[]; note?: string }> {
    const n = clampInt(lines, 1, LOG_LINES_MAX, 'lines');
    const filter = level === 'error' ? ['*:E'] : level === 'warn' ? ['*:W'] : [];
    const read = async (by: string[]) => {
      const out = await this.on(serial, ['logcat', '-d', '-v', 'time', '-t', String(n), ...by, ...filter], 20_000, 16 << 20);
      return out
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith('--------- beginning of'))
        .slice(-n)
        .map((l) => (l.length > LOG_LINE_MAX ? l.slice(0, LOG_LINE_MAX - 1) + '…' : l));
    };
    if (!pkg) return { lines: await read([]) };
    if (!PACKAGE_RE.test(pkg)) throw new DeviceError(`"${pkg.slice(0, 80)}" is not a package name.`);
    const pid = (await this.shell(serial, ['pidof', pkg], 8_000).catch(() => '')).trim().split(/\s+/)[0];
    if (/^\d+$/.test(pid)) return { lines: await read([`--pid=${pid}`]) };
    const uid = /uid:(\d+)/.exec(await this.shell(serial, ['pm', 'list', 'packages', '-U', pkg], 8_000).catch(() => ''))?.[1];
    if (!uid) return { lines: [], note: `${pkg} is not installed.` };
    try {
      return { lines: await read([`--uid=${uid}`]), note: `${pkg} is not running; these are its lines from before.` };
    } catch {
      return { lines: [], note: `${pkg} is not running. Launch it to see its log.` };
    }
  }

  async open(serial: string, url: string): Promise<{ ok: boolean }> {
    const u = (url ?? '').trim();
    if (!/^[a-z][a-z0-9+.-]*:\S+$/i.test(u) || u.length > 2_000) throw new DeviceError('Give a whole address, like https://example.com or myapp://screen.');
    await this.shell(serial, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', shQuote(u)], 15_000);
    return { ok: true };
  }
}

function ready(d: DeviceInfo): DeviceInfo {
  if (d.state === 'device') return d;
  if (d.state === 'booting') throw new DeviceError(`${d.name} is still starting. Try again in a few seconds.`);
  if (d.state === 'unauthorized') throw new DeviceError(`${d.serial} has not allowed USB debugging yet: accept the prompt on the phone.`);
  throw new DeviceError(`${d.serial} is ${d.state}.`);
}

/** A serial goes to adb as one argument; it must not look like an option. */
function checkSerial(serial: string) {
  if (typeof serial !== 'string' || !/^[A-Za-z0-9._:\-]{1,120}$/.test(serial) || serial.startsWith('-')) throw new DeviceError('That is not a device serial.');
}

function killTree(child: EmulatorChild) {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else child.kill();
}

// ── the bridge ──

let shared: DeviceService | undefined;
let registered = false;

/** The service the bridge and the agent tools share. */
export function devices(): DeviceService {
  if (!shared) shared = new DeviceService();
  return shared;
}

/** For tests: use this service instead. */
export function setDevices(s: DeviceService | undefined, available?: boolean) {
  shared = s;
  registered = available ?? !!s;
}

/**
 * Whether the device tools are on for a session that did not choose: when adb was found by a
 * running bridge (a test that builds a provider without one gets none).
 */
export function deviceDefault(): boolean {
  return registered && !!shared?.adbPath;
}

/** Absent means on when adb is there. */
export const deviceEnabled = (meta: { options?: { device?: boolean } } | undefined) => meta?.options?.device ?? deviceDefault();

export function registerDevice(app: App) {
  const svc = devices();
  registered = true;
  svc.onChange = (status) => app.emit({ type: 'device.updated', status });
  const wrap = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  };
  app.register('device.list', () => wrap(() => svc.status()));
  app.register('device.use', ({ serial }) =>
    wrap(async () => {
      svc.use(serial);
      return svc.status();
    }),
  );
  app.register('device.start', ({ avd }) => wrap(() => svc.start(avd)));
  app.register('device.stop', ({ serial }) => wrap(() => svc.stop(serial)));
  app.register('device.screenshot', ({ serial }) => wrap(() => svc.screenshot(serial)));
  app.register('device.tap', ({ serial, x, y, hold }) => wrap(() => svc.tap(serial, x, y, hold)));
  app.register('device.swipe', ({ serial, x1, y1, x2, y2, ms }) => wrap(() => svc.swipe(serial, x1, y1, x2, y2, ms)));
  app.register('device.type', ({ serial, text }) => wrap(() => svc.type(serial, text)));
  app.register('device.key', ({ serial, key }) => wrap(() => svc.key(serial, key)));
  app.register('device.install', ({ serial, apk }) => wrap(() => svc.install(serial, apk)));
  app.register('device.launch', ({ serial, package: pkg, activity, restart }) => wrap(() => svc.launch(serial, pkg, activity, restart)));
  app.register('device.packages', ({ serial }) => wrap(() => svc.packages(serial)));
  app.register('device.logs', ({ serial, package: pkg, lines, level }) => wrap(() => svc.logs(serial, pkg, lines, level)));
  app.register('device.open', ({ serial, url }) => wrap(() => svc.open(serial, url)));
  app.onDispose(() => {
    // Emulators keep running across a reload of the bridge (the registry is process-wide); the process's exit stops them.
    if (svc.onChange) svc.onChange = undefined;
  });
}
