/** The phone endpoint (server/services/phone.ts): pairing with approval, token hello, the allowlist, rate limits, revocation; the QR encoder; Claude's Remote Control default. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PHONE_PATH, type PhoneFrame, type PhoneStatus } from '@shared/protocol';
import { App, withDefaultOptions } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerFs } from '../server/services/fs';
import { registerPhone, type PhoneService } from '../server/services/phone';
import { qrMatrix } from '../server/services/qr';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

async function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-'));
  homes.push(home);
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  registerFs(app);
  const phone = registerPhone(app, { port: 0, host: '127.0.0.1' });
  const status = await app.call('phone.setEnabled', { on: true });
  expect(status.listening).toBe(true);
  return { app, phone, home, port: status.port };
}

type Frame = PhoneFrame | { id: number; ok: boolean; result?: unknown; error?: string } | { event: unknown };

function client(port: number, origin?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${PHONE_PATH}`, origin ? { headers: { origin } } : undefined);
  const frames: Frame[] = [];
  const waiters: ((f: Frame) => void)[] = [];
  ws.on('message', (m) => {
    const f = JSON.parse(String(m)) as Frame;
    frames.push(f);
    for (const w of waiters.splice(0)) w(f);
  });
  const next = (pred: (f: Frame) => boolean) =>
    new Promise<Frame>((resolve, reject) => {
      const hit = frames.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error('no such frame')), 3000);
      const check = (f: Frame) => {
        if (pred(f)) {
          clearTimeout(t);
          resolve(f);
        } else waiters.push(check);
      };
      waiters.push(check);
    });
  const open = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
    ws.on('error', reject);
  });
  let id = 0;
  const call = async (method: string, params: unknown = {}) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    return (await next((f) => 'id' in f && f.id === i)) as { ok: boolean; result?: unknown; error?: string };
  };
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  return { ws, open, next, call, closed, frames };
}

const keyOf = (s: PhoneStatus) => /k=([^&]+)/.exec(s.pairing!.link)![1];

async function pairPhone(app: App, port: number) {
  const offer = await app.call('phone.pair', {});
  const c = client(port, 'http://localhost');
  await c.open;
  c.ws.send(JSON.stringify({ pair: { key: keyOf(offer), name: 'Test phone' } }));
  await c.next((f) => 'waiting' in f);
  const asking = await app.call('phone.status', {});
  expect(asking.request?.name).toBe('Test phone');
  await app.call('phone.approve', { requestId: asking.request!.id, allow: true });
  const paired = (await c.next((f) => 'paired' in f)) as { paired: { token: string; deviceId: string } };
  await c.next((f) => 'welcome' in f);
  return { c, token: paired.paired.token, deviceId: paired.paired.deviceId };
}

describe('phone endpoint', () => {
  it('pairs only after "Allow", keeps the token hashed, and the key works once', async () => {
    const { app, port, home } = await setup();
    const offer = await app.call('phone.pair', {});
    expect(offer.pairing?.link).toMatch(/^sable:\/\/pair\?h=.*&p=\d+&k=[\w-]{20,}/);
    const { c, token } = await pairPhone(app, port);
    expect(token.length).toBeGreaterThanOrEqual(40);
    const saved = readFileSync(path.join(home, 'phone.json'), 'utf8');
    expect(saved).not.toContain(token);
    expect((await app.call('phone.status', {})).devices).toHaveLength(1);
    // The same key again: refused.
    const again = client(port);
    await again.open;
    again.ws.send(JSON.stringify({ pair: { key: keyOf(offer), name: 'Other' } }));
    expect(await again.next((f) => 'denied' in f)).toBeTruthy();
    c.ws.close();
  });

  it('denied pairing gives no token', async () => {
    const { app, port } = await setup();
    const offer = await app.call('phone.pair', {});
    const c = client(port);
    await c.open;
    c.ws.send(JSON.stringify({ pair: { key: keyOf(offer), name: 'Stranger' } }));
    await c.next((f) => 'waiting' in f);
    const st = await app.call('phone.status', {});
    await app.call('phone.approve', { requestId: st.request!.id, allow: false });
    await c.next((f) => 'denied' in f);
    expect(c.frames.some((f) => 'paired' in f)).toBe(false);
    expect((await app.call('phone.status', {})).devices).toHaveLength(0);
  });

  it('a paired phone calls only the allowlist, with narrowed parameters', async () => {
    const { app, port } = await setup();
    const { c } = await pairPhone(app, port);
    const hello = await c.call('app.hello');
    expect(hello.ok).toBe(true);
    for (const m of ['term.run', 'fs.read', 'memory.write', 'app.setSettings', 'phone.status', 'phone.pair', 'git.commit', 'auth.login', 'device.tap']) {
      const r = await c.call(m, {});
      expect(r.ok, m).toBe(false);
      expect(r.error).toMatch(/Not available from the phone/);
    }
    // Folder listing never returns files.
    const list = (await c.call('fs.list', { path: path.resolve('.') })) as { ok: boolean; result: { entries: { dir: boolean }[] } };
    expect(list.ok).toBe(true);
    expect(list.result.entries.every((e) => e.dir)).toBe(true);
    // session.update takes only pinned / archived / unread.
    const snap = (await c.call('session.create', { provider: 'demo', cwd: path.resolve('.') })) as { result: { session: { id: string } } };
    const id = snap.result.session.id;
    await c.call('session.update', { sessionId: id, patch: { pinned: true, cwd: 'C:/elsewhere', provider: 'claude' } });
    const meta = app.sessions.get(id)!.meta;
    expect(meta.pinned).toBe(true);
    expect(meta.cwd).not.toBe('C:/elsewhere');
    expect(meta.provider).toBe('demo');
    // session.setOptions passes only Remote Control.
    await c.call('session.setOptions', { sessionId: id, options: { computerUse: true, browser: true, remoteControl: true } });
    expect(app.sessions.get(id)!.meta.options?.computerUse).toBeUndefined();
    expect(app.sessions.get(id)!.meta.options?.remoteControl).toBe(true);
  });

  it('streams conversation events but never the phone service state', async () => {
    const { app, port } = await setup();
    const { c } = await pairPhone(app, port);
    app.emit({ type: 'toast', level: 'info', text: 'hello phone' });
    app.emit({ type: 'term.data', termId: 't', data: 'secret', stream: 'out' });
    await app.call('phone.pair', {});
    await c.next((f) => 'event' in f && (f.event as { type: string }).type === 'toast');
    await new Promise((r) => setTimeout(r, 100));
    const types = c.frames.filter((f) => 'event' in f).map((f) => (f as { event: { type: string } }).event.type);
    expect(types).not.toContain('term.data');
    expect(types).not.toContain('phone.updated');
  });

  it('refuses wrong tokens, blocks an address after repeated failures, and refuses web pages', async () => {
    const { port } = await setup();
    for (let i = 0; i < 5; i++) {
      const c = client(port);
      await c.open;
      c.ws.send(JSON.stringify({ hello: { token: `wrong-${i}` } }));
      expect(await c.closed).toBe(4001);
    }
    const blocked = client(port);
    await expect(blocked.open).rejects.toMatchObject({ status: 429 });
    const page = client(port, 'http://evil.example');
    await expect(page.open).rejects.toMatchObject({ status: 403 });
  });

  it('revoking a phone ends its connection and its token', async () => {
    const { app, port } = await setup();
    const { c, token, deviceId } = await pairPhone(app, port);
    await app.call('phone.revoke', { deviceId });
    expect(await c.closed).toBe(4001);
    const again = client(port);
    await again.open;
    again.ws.send(JSON.stringify({ hello: { token } }));
    expect(await again.closed).toBe(4001);
  });

  it('a paired phone reconnects with its token after a restart of the endpoint', async () => {
    const { app, port, phone } = await setup();
    const { c, token } = await pairPhone(app, port);
    c.ws.close();
    await (phone as PhoneService).stop();
    await app.call('phone.setEnabled', { on: true });
    const port2 = (await app.call('phone.status', {})).port;
    const again = client(port2);
    await again.open;
    again.ws.send(JSON.stringify({ hello: { token } }));
    expect(await again.next((f) => 'welcome' in f)).toBeTruthy();
    again.ws.close();
  });
});

describe('qr encoder', () => {
  it('draws finder patterns and grows with the text', () => {
    const small = qrMatrix('sable://pair?h=1.2.3.4&p=47820&k=abcdefghijklmnopqrstuv');
    expect(small.length).toBeGreaterThanOrEqual(25);
    // Top-left finder: a dark 7x7 ring with a dark 3x3 centre.
    expect(small[0].slice(0, 7).every(Boolean)).toBe(true);
    expect(small[1][1]).toBe(false);
    expect(small[3][3]).toBe(true);
    const big = qrMatrix('x'.repeat(180));
    expect(big.length).toBeGreaterThan(small.length);
    expect(() => qrMatrix('x'.repeat(400))).toThrow();
  });
});

describe('remote control default', () => {
  it('is on for new Claude sessions unless chosen, and only for Claude', () => {
    expect(withDefaultOptions('claude', undefined)).toEqual({ remoteControl: true });
    expect(withDefaultOptions('claude', { browser: true })).toEqual({ browser: true, remoteControl: true });
    expect(withDefaultOptions('claude', { remoteControl: false })).toEqual({ remoteControl: false });
    expect(withDefaultOptions('codex', undefined)).toBeUndefined();
    expect(withDefaultOptions('demo', { browserTab: false })).toEqual({ browserTab: false });
  });
});
