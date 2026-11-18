import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings, type BridgeEvent, type DeviceStatus, type SessionMeta } from '@shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { ClaudeProvider } from '../server/providers/claude';
import { describeTool } from '../server/providers/claude-tools';
import { CodexProvider } from '../server/providers/codex';
import { DEVICE_HINT, DEVICE_NAMESPACE, DEVICE_TOOL_IDS, deviceOp, deviceTitle, runDeviceTool } from '../server/providers/device-tool';
import {
  DeviceService,
  deviceDefault,
  deviceEnabled,
  findElement,
  inputTextArg,
  parseDevices,
  parseRawScreencap,
  parseUiDump,
  pictureScale,
  rawToPng,
  setDevices,
  type AdbResult,
  type EmulatorChild,
} from '../server/services/device';

const ok = (out: string | Buffer = ''): AdbResult => ({ stdout: Buffer.isBuffer(out) ? out : Buffer.from(out), stderr: '', code: 0 });

/** A 1x1 PNG with a real header (the size is read from it). */
function pngOf(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** A raw screencap: 16 byte header, RGBA pixels from `px(x, y)`. */
function rawOf(width: number, height: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const b = Buffer.alloc(16 + width * height * 4);
  b.writeUInt32LE(width, 0);
  b.writeUInt32LE(height, 4);
  b.writeUInt32LE(1, 8);
  b.writeUInt32LE(1, 12);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, bl] = px(x, y);
      const i = 16 + (y * width + x) * 4;
      b[i] = r;
      b[i + 1] = g;
      b[i + 2] = bl;
      b[i + 3] = 255;
    }
  return b;
}

/** Reads back an RGB PNG written by rawToPng (Up filter on all rows but the first). */
function decodeRgb(png: Buffer): { width: number; height: number; px: (x: number, y: number) => number[] } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  let off = 8;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3 + 1;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const f = raw[y * stride];
    const row = Buffer.from(raw.subarray(y * stride + 1, (y + 1) * stride));
    if (f === 2) for (let i = 0; i < row.length; i++) row[i] = (row[i] + rows[y - 1][i]) & 0xff;
    rows.push(row);
  }
  return { width, height, px: (x, y) => [...rows[y].subarray(x * 3, x * 3 + 3)] };
}

interface Fake {
  svc: DeviceService;
  calls: string[][];
}

/** A device service over a scripted adb: `answer` sees each call's arguments. */
function fake(answer: (args: string[]) => AdbResult | undefined, opts: { avdHome?: string; spawn?: (bin: string, args: string[]) => EmulatorChild } = {}): Fake {
  const calls: string[][] = [];
  const svc = new DeviceService({
    sdk: null,
    adb: 'adb',
    emulator: opts.spawn ? 'emulator' : null,
    avdHome: opts.avdHome ?? path.join(tmpdir(), 'sable-no-avds'),
    bootPollMs: 5,
    run: async (args) => {
      calls.push(args);
      return answer(args) ?? ok();
    },
    spawnEmulator: opts.spawn,
  });
  return { svc, calls };
}

const ONE = 'List of devices attached\nemulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1\n\n';

/** One emulator, 1080 x 2400, named sable-pixel. */
const emulator = (more?: (args: string[]) => AdbResult | undefined) =>
  fake((a) => {
    const r = more?.(a);
    if (r) return r;
    if (a[0] === 'devices') return ok(ONE);
    if (a.includes('emu') && a.includes('avd')) return ok('sable-pixel\r\nOK\r\n');
    if (a.includes('wm')) return ok('Physical size: 1080x2400\n');
    return undefined;
  });

afterEach(() => setDevices(undefined, false));

describe('reading adb', () => {
  it('lists devices with their states and models', () => {
    const list = parseDevices('List of devices attached\nemulator-5554\tdevice product:x model:sdk_gphone64 device:emu\nR58M123 unauthorized usb:1-1 transport_id:2\n192.168.1.20:5555 offline\n');
    expect(list).toEqual([
      { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64' },
      { serial: 'R58M123', state: 'unauthorized' },
      { serial: '192.168.1.20:5555', state: 'offline' },
    ]);
  });

  it('names an emulator by its AVD and a phone by its model', async () => {
    const { svc } = fake((a) => {
      if (a[0] === 'devices') return ok(`${ONE.trim()}\nR58M123 device usb:1-1 model:Pixel_8 transport_id:2\n`);
      if (a.includes('emu')) return ok('sable-pixel\r\nOK');
      return undefined;
    });
    const st = await svc.status();
    expect(st.devices.map((d) => [d.serial, d.kind, d.name, d.state])).toEqual([
      ['emulator-5554', 'emulator', 'sable-pixel', 'device'],
      ['R58M123', 'usb', 'Pixel 8', 'device'],
    ]);
  });

  it('picks the only ready device, the preferred one, or asks for a serial', async () => {
    const { svc } = fake((a) => (a[0] === 'devices' ? ok(`${ONE.trim()}\nR58M123 device model:Pixel_8\n`) : undefined));
    await expect(svc.pick()).rejects.toThrow(/Several devices/);
    svc.use('R58M123');
    expect((await svc.pick()).serial).toBe('R58M123');
    expect((await svc.pick('emulator-5554')).serial).toBe('emulator-5554');
    await expect(svc.pick('nope')).rejects.toThrow(/No device nope/);
    const none = fake((a) => (a[0] === 'devices' ? ok('List of devices attached\n\n') : undefined)).svc;
    await expect(none.pick()).rejects.toThrow(/No device is connected/);
  });

  it('refuses serials that would read as options', async () => {
    const { svc } = emulator();
    await expect(svc.tap('-d', 1, 1)).rejects.toThrow(/serial/);
    await expect(svc.tap('emu 5554', 1, 1)).rejects.toThrow(/serial/);
  });
});

describe('acting', () => {
  it('taps, long-presses, swipes and presses keys with adb input', async () => {
    const { svc, calls } = emulator();
    await svc.tap('emulator-5554', 10.4, 20.6);
    await svc.tap('emulator-5554', 5, 5, 800);
    await svc.swipe('emulator-5554', 500, 1800, 500, 600, 250);
    await svc.key('emulator-5554', 'back');
    await svc.key('emulator-5554', 'recent');
    expect(calls).toEqual([
      ['-s', 'emulator-5554', 'shell', 'input', 'tap', '10', '21'],
      ['-s', 'emulator-5554', 'shell', 'input', 'swipe', '5', '5', '5', '5', '800'],
      ['-s', 'emulator-5554', 'shell', 'input', 'swipe', '500', '1800', '500', '600', '250'],
      ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', 'KEYCODE_BACK'],
      ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', 'KEYCODE_APP_SWITCH'],
    ]);
  });

  it('types text quoted for the device shell, lines joined with Enter, ASCII only', async () => {
    expect(inputTextArg("it's a test")).toBe(`'it'\\''s%sa%stest'`);
    const { svc, calls } = emulator();
    await svc.type('emulator-5554', 'hello world\nsecond');
    expect(calls).toEqual([
      ['-s', 'emulator-5554', 'shell', 'input', 'text', "'hello%sworld'"],
      ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', 'KEYCODE_ENTER'],
      ['-s', 'emulator-5554', 'shell', 'input', 'text', "'second'"],
    ]);
    await expect(svc.type('emulator-5554', 'grüße')).rejects.toThrow(/ASCII/);
  });

  it('reports what the device said went wrong, even on a zero exit', async () => {
    const { svc } = emulator((a) => (a.includes('tap') ? { stdout: Buffer.from(''), stderr: 'Error: Unknown command: tapp', code: 0 } : undefined));
    await expect(svc.tap('emulator-5554', 1, 1)).rejects.toThrow('Error: Unknown command: tapp');
  });

  it('launches through the launcher activity, restarts when asked', async () => {
    const { svc, calls } = emulator((a) => (a.includes('resolve-activity') ? ok('priority=0 preferredOrder=0\ncom.example.app/.MainActivity\n') : undefined));
    const r = await svc.launch('emulator-5554', 'com.example.app', undefined, true);
    expect(r).toEqual({ ok: true, text: 'Started com.example.app/.MainActivity.' });
    expect(calls.map((c) => c.slice(3).join(' '))).toEqual(['am force-stop com.example.app', 'cmd package resolve-activity --brief -c android.intent.category.LAUNCHER com.example.app', 'am start -n com.example.app/.MainActivity']);
    await expect(svc.launch('emulator-5554', 'not a package')).rejects.toThrow(/package name/);
  });

  it('installs an APK and says why one failed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sable-apk-'));
    try {
      const apk = path.join(dir, 'app-debug.apk');
      writeFileSync(apk, 'x');
      const good = emulator((a) => (a.includes('install') ? ok('Performing Streamed Install\nSuccess\n') : undefined));
      expect(await good.svc.install('emulator-5554', apk)).toEqual({ ok: true, text: 'Installed app-debug.apk.' });
      expect(good.calls[0]).toEqual(['-s', 'emulator-5554', 'install', '-r', '-t', apk]);
      const bad = emulator((a) => (a.includes('install') ? { stdout: Buffer.from('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]'), stderr: '', code: 1 } : undefined));
      expect((await bad.svc.install('emulator-5554', apk)).text).toBe('The install failed: INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match');
      await expect(good.svc.install('emulator-5554', path.join(dir, 'missing.apk'))).rejects.toThrow(/No file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads one app's log by its process, by its user id when it is not running, bounded", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `11-19 00:00:0${i}.000 E/App( 42): line ${i} ${'x'.repeat(i === 4 ? 600 : 0)}`).join('\n');
    const running = emulator((a) => (a.includes('pidof') ? ok('4242\n') : a.includes('logcat') ? ok(`--------- beginning of main\n${lines}\n`) : undefined));
    const r = await running.svc.logs('emulator-5554', 'com.example.app', 3);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[2].length).toBe(400);
    expect(running.calls.find((c) => c.includes('logcat'))).toEqual(['-s', 'emulator-5554', 'logcat', '-d', '-v', 'time', '-t', '3', '--pid=4242']);
    const stopped = emulator((a) => (a.includes('pidof') ? { stdout: Buffer.from(''), stderr: '', code: 1 } : a.includes('-U') ? ok('package:com.example.app uid:10150\n') : a.includes('logcat') ? ok('a\nb\n') : undefined));
    const s = await stopped.svc.logs('emulator-5554', 'com.example.app', 50, 'error');
    expect(s.note).toMatch(/not running/);
    expect(stopped.calls.find((c) => c.includes('logcat'))).toEqual(['-s', 'emulator-5554', 'logcat', '-d', '-v', 'time', '-t', '50', '--uid=10150', '*:E']);
  });

  it('reads log lines that name exceptions as content, not as a failure', async () => {
    const { svc } = emulator((a) => (a.includes('logcat') ? ok('11-19 00:00:01.000 E/App( 42): java.lang.IllegalStateException: boom\n') : undefined));
    expect((await svc.logs('emulator-5554')).lines).toEqual(['11-19 00:00:01.000 E/App( 42): java.lang.IllegalStateException: boom']);
  });

  it('opens a link with a VIEW intent and lists the apps the user installed', async () => {
    const { svc, calls } = emulator((a) => (a.includes('pm') ? ok('package:com.b.app\npackage:com.a.app\n') : undefined));
    await svc.open('emulator-5554', "https://example.com/?q=a'b");
    expect(calls[0]).toEqual(['-s', 'emulator-5554', 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'https://example.com/?q=a'\\''b'`]);
    expect((await svc.packages('emulator-5554')).packages).toEqual(['com.a.app', 'com.b.app']);
    await expect(svc.open('emulator-5554', 'not a url')).rejects.toThrow(/whole address/);
  });
});

describe('pictures', () => {
  it('passes the device PNG on with its size, one capture at a time', async () => {
    const png = pngOf(1080, 2400);
    const { svc, calls } = emulator((a) => (a.includes('screencap') ? ok(png) : undefined));
    const [a, b] = await Promise.all([svc.screenshot('emulator-5554'), svc.screenshot('emulator-5554')]);
    expect(a).toBe(b);
    expect(calls.filter((c) => c.includes('screencap'))).toHaveLength(1);
    expect(a.width).toBe(1080);
    expect(a.height).toBe(2400);
    expect(a.data.startsWith('data:image/png;base64,iVBORw0KGgo')).toBe(true);
  });

  it('scales a raw screen down by a whole factor into an RGB PNG', async () => {
    expect(pictureScale(1080, 2400)).toBe(2);
    expect(pictureScale(1440, 3120)).toBe(3);
    expect(pictureScale(720, 1280)).toBe(1);
    // 4 x 2: left half red and black columns (mean 127/128), right half white.
    const raw = rawOf(4, 2, (x) => (x < 2 ? (x === 0 ? [255, 0, 0] : [0, 0, 0]) : [255, 255, 255]));
    expect(parseRawScreencap(raw)).toMatchObject({ width: 4, height: 2, bpp: 4, offset: 16 });
    const out = (await rawToPng(raw, 2))!;
    const img = decodeRgb(out.png);
    expect([img.width, img.height]).toEqual([2, 1]);
    expect(img.px(0, 0)).toEqual([128, 0, 0]);
    expect(img.px(1, 0)).toEqual([255, 255, 255]);
    // Rows below the first use the Up filter and still read back exactly.
    const tall = decodeRgb((await rawToPng(rawOf(2, 6, (x, y) => [y * 40, x * 100, 7]), 1))!.png);
    expect(tall.px(1, 5)).toEqual([200, 100, 7]);
  });
});

describe('the screen as elements', () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" clickable="false" bounds="[0,0][1080,2400]"><node text="Network &amp; internet" resource-id="android:id/title" class="android.widget.TextView" content-desc="" clickable="false" bounds="[189,600][700,660]" /><node text="" resource-id="com.x:id/search" class="android.widget.ImageButton" content-desc="Search settings" clickable="true" bounds="[900,150][1040,290]" /></node></hierarchy>`;
  it('keeps what shows words or can be pressed, and finds by words', () => {
    const els = parseUiDump(xml);
    expect(els.map((e) => e.text || e.desc)).toEqual(['Network & internet', 'Search settings']);
    expect(findElement(els, 'network')?.bounds).toEqual([189, 600, 700, 660]);
    expect(findElement(els, 'Search settings')?.clickable).toBe(true);
    expect(findElement(els, 'search')?.desc).toBe('Search settings');
    expect(findElement(els, 'bluetooth')).toBeUndefined();
  });
});

describe('the emulator', () => {
  it('starts headless on a free port, reports the boot, and stops with emu kill', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-avd-'));
    try {
      mkdirSync(path.join(home, 'sable-pixel.avd'));
      writeFileSync(path.join(home, 'sable-pixel.ini'), 'path=x');
      class Child extends EventEmitter implements EmulatorChild {
        pid = 1;
        exitCode: number | null = null;
        stderr = null;
        kill() {
          this.exitCode = 0;
          this.emit('exit', 0);
          return true;
        }
      }
      const child = new Child();
      let spawned: string[] = [];
      let booted = false;
      const { svc, calls } = fake(
        (a) => {
          if (a[0] === 'devices') return ok(spawned.length ? 'List of devices attached\nemulator-5556\tdevice\n' : 'List of devices attached\nemulator-5554\tdevice\n');
          if (a.includes('getprop')) return ok(booted ? '1\n' : '\n');
          if (a.includes('emu') && a.includes('kill')) {
            queueMicrotask(() => child.kill());
            return ok('OK');
          }
          if (a.includes('emu')) return ok('other-avd\nOK');
          return undefined;
        },
        {
          avdHome: home,
          spawn: (_bin, args) => {
            spawned = args;
            return child;
          },
        },
      );
      const updates: DeviceStatus[] = [];
      svc.onChange = (s) => updates.push(s);
      expect(svc.avds()).toEqual(['sable-pixel']);
      const { serial } = await svc.start();
      // 5554 is taken by another emulator: the next even port.
      expect(serial).toBe('emulator-5556');
      expect(spawned).toEqual(['-avd', 'sable-pixel', '-port', '5556', '-no-window', '-no-audio', '-no-boot-anim', '-gpu', 'swiftshader_indirect']);
      expect((await svc.status()).devices.find((d) => d.serial === serial)).toMatchObject({ state: 'booting', sable: true, name: 'sable-pixel' });
      booted = true;
      await new Promise((r) => setTimeout(r, 60));
      expect((await svc.status()).devices.find((d) => d.serial === serial)?.state).toBe('device');
      expect(updates.at(-1)?.devices.find((d) => d.serial === serial)?.state).toBe('device');
      await svc.stop(serial);
      expect(calls.some((c) => c.join(' ') === `-s ${serial} emu kill`)).toBe(true);
      await expect(svc.stop('R58M123')).rejects.toThrow(/Only an emulator/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── the agent tools ──

const ctx = (settings: Partial<AppSettings> = {}) => ({ emit: () => {}, log: () => {}, settings: () => ({ ...DEFAULT_SETTINGS, ...settings }) });

function makeRt(mode = 'default', options: SessionMeta['options'] = { device: true }) {
  const events: BridgeEvent[] = [];
  const m: SessionMeta = { id: 's1', provider: 'demo', cwd: tmpdir(), title: 't', titleSource: 'auto', model: '', mode, status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, options };
  const rt = new SessionRuntime(m, (e) => events.push(e), () => {});
  return { rt, events };
}

describe('the device tools', () => {
  it('are on by default only where a running bridge found adb', () => {
    expect(deviceDefault()).toBe(false);
    expect(deviceEnabled({ options: {} })).toBe(false);
    expect(deviceEnabled({ options: { device: true } })).toBe(true);
    setDevices(new DeviceService({ sdk: null, adb: 'adb', emulator: null, run: async () => ok() }), true);
    expect(deviceEnabled({ options: {} })).toBe(true);
    expect(deviceEnabled({ options: { device: false } })).toBe(false);
  });

  it('are offered to both agents while the capability is on, the working ones deferred', () => {
    const meta = { cwd: process.cwd(), model: '', mode: 'default' };
    const on = new ClaudeProvider(ctx({ generativeUi: false })).agentOptions({ ...meta, options: { browserTab: false, device: true } }, {});
    expect(on.allowedTools).toEqual(DEVICE_TOOL_IDS);
    expect((on.systemPrompt as { append?: string }).append).toContain(DEVICE_HINT);
    const off = new ClaudeProvider(ctx({ generativeUi: false })).agentOptions({ ...meta, options: { browserTab: false } }, {});
    expect(off.allowedTools ?? []).not.toContain(DEVICE_TOOL_IDS[0]);
    const codex = new CodexProvider(ctx({ generativeUi: false })).dynamicTools({ options: { browserTab: false, device: true } })!;
    expect(codex.filter((t) => t.type === 'function').map((t) => t.name)).toEqual(['device_list', 'device_screenshot']);
    const ns = codex.find((t) => t.type === 'namespace');
    expect(ns?.name).toBe(DEVICE_NAMESPACE);
    expect(ns && 'tools' in ns ? ns.tools.map((f) => f.name) : []).toContain('device_tap');
    expect(deviceOp('mcp__sable__device_tap')).toBe('tap');
    expect(deviceOp('sable_device.device_swipe')).toBe('swipe');
    expect(deviceOp('device_tapper')).toBeUndefined();
  });

  it('show as one line in the timeline', () => {
    expect(describeTool('mcp__sable__device_tap', { text: 'Sign in' })).toMatchObject({ kind: 'device', title: 'Tap Sign in' });
    expect(deviceTitle('swipe', { x1: 270, y1: 1000, x2: 270, y2: 300 })).toBe('Swipe up');
    expect(deviceTitle('install', { apk: 'app\\build\\outputs\\apk\\debug\\app-debug.apk' })).toBe('Install app-debug.apk');
    expect(deviceTitle('key', { key: 'back' })).toBe('Press Back');
  });

  it('take a picture at a whole fraction of the screen and tap in its pixels', async () => {
    const raw = rawOf(1080, 2400, () => [20, 20, 20]);
    const { svc, calls } = emulator((a) => (a.includes('screencap') ? ok(raw) : undefined));
    const { rt } = makeRt();
    const shot = await runDeviceTool(rt, 'screenshot', {}, undefined, svc);
    expect(shot.ok).toBe(true);
    expect(shot.text).toMatch(/540 x 1200 picture pixels, the 1080 x 2400 screen at 1\/2/);
    expect(decodeRgb(Buffer.from(shot.image!.data, 'base64')).width).toBe(540);
    const tap = await runDeviceTool(rt, 'tap', { x: 100, y: 300 }, undefined, svc);
    expect(tap.ok).toBe(true);
    expect(calls.at(-1)).toEqual(['-s', 'emulator-5554', 'shell', 'input', 'tap', '201', '601']);
    const off = await runDeviceTool(rt, 'tap', { x: 600, y: 10 }, undefined, svc);
    expect(off).toMatchObject({ ok: false, text: '600, 10 is off the screen: the picture is 540 x 1200.' });
    await runDeviceTool(rt, 'swipe', { x1: 270, y1: 1000, x2: 270, y2: 200, ms: 200 }, undefined, svc);
    expect(calls.at(-1)).toEqual(['-s', 'emulator-5554', 'shell', 'input', 'swipe', '541', '2001', '541', '401', '200']);
  });

  it('tap an element by its words', async () => {
    const dump = `UI hierchary dumped to: /dev/tty<?xml version='1.0' ?><hierarchy><node text="Network &amp; internet" class="android.widget.TextView" content-desc="" clickable="false" bounds="[189,600][701,660]" /></hierarchy>`;
    const { svc, calls } = emulator((a) => (a.includes('uiautomator') ? ok(dump) : undefined));
    const { rt } = makeRt();
    const r = await runDeviceTool(rt, 'tap', { text: 'network' }, undefined, svc);
    expect(r.text).toBe('Tapped "Network & internet" at 223, 315 (picture pixels). Take a screenshot to see the result.');
    expect(calls.at(-1)).toEqual(['-s', 'emulator-5554', 'shell', 'input', 'tap', '445', '630']);
  });

  it('ask before working a real phone, never for an emulator, and not at all when turned off', async () => {
    const phone = fake((a) => (a[0] === 'devices' ? ok('List of devices attached\nR58M123\tdevice model:Pixel_8\n') : a.includes('wm') ? ok('Physical size: 1080x2400') : undefined));
    const { rt, events } = makeRt();
    const pending = runDeviceTool(rt, 'key', { key: 'home' }, undefined, phone.svc);
    await new Promise((r) => setTimeout(r, 20));
    const ask = events.find((e) => e.type === 'permission.added');
    expect(ask && ask.type === 'permission.added' ? ask.request.title : '').toBe('Press Home on Pixel 8');
    rt.answerPermission(ask && ask.type === 'permission.added' ? ask.request.id : '', { optionId: 'deny' });
    expect(await pending).toEqual({ ok: false, text: 'The user declined actions on Pixel 8.' });
    expect(phone.calls.some((c) => c.includes('keyevent'))).toBe(false);

    const em = emulator();
    const e2 = makeRt();
    expect((await runDeviceTool(e2.rt, 'key', { key: 'home' }, undefined, em.svc)).ok).toBe(true);
    expect(e2.events.some((e) => e.type === 'permission.added')).toBe(false);

    const offRt = makeRt('default', { device: false }).rt;
    expect(await runDeviceTool(offRt, 'list', {}, undefined, em.svc)).toEqual({ ok: false, text: 'The device tools are turned off for this session.' });
  });

  it('list says which device the tools use and what can be started', async () => {
    const { svc } = emulator();
    const r = await runDeviceTool(makeRt().rt, 'list', {}, undefined, svc);
    expect(r.text).toContain('- emulator-5554: sable-pixel, emulator, ready (the tools use this one)');
    expect(r.text).toContain('The emulator is not installed.');
  });
});
