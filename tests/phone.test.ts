/** The phone endpoint (server/services/phone.ts): pairing with approval, token hello, the allowlist, rate limits, revocation; the QR encoder; Claude's Remote Control default. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PHONE_PATH, type PhoneFrame, type PhoneStatus, type PhoneTail, type TextItem, type TimelineItem, type ToolItem, type UserItem } from '@shared/protocol';
import { App, withDefaultOptions } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerFs } from '../server/services/fs';
import { LIMITS, phoneDetail, phoneEvent, phonePage, registerPhone, type PhoneService } from '../server/services/phone';
import { qrMatrix } from '../server/services/qr';
import { mergeHosts } from '../mobile/src/lib/hosts';

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

describe('conversations in pages', () => {
  const big = 'x'.repeat(2_000_000);
  /** A long conversation: `turns` turns, each a message, `steps` tool calls with big output, an answer and its end. */
  function long(turns: number, steps: number): TimelineItem[] {
    const out: TimelineItem[] = [];
    let n = 0;
    for (let t = 0; t < turns; t++) {
      out.push({ id: `u${t}`, ts: n++, type: 'user', text: `message ${t}`, attachments: [{ id: 'a', kind: 'image', name: 'shot.png', dataUrl: `data:image/png;base64,${'A'.repeat(300_000)}` }] });
      for (let s = 0; s < steps; s++) {
        out.push({
          id: `t${t}-${s}`,
          ts: n++,
          type: 'tool',
          name: 'Bash',
          kind: 'bash',
          title: 'Run tests',
          status: 'done',
          detail: { command: 'pnpm test', newText: big },
          input: { command: 'pnpm test', blob: big },
          output: big,
          result: { text: big, images: ['data:image/png;base64,AAAA'], diff: [{ path: 'a.ts', status: 'modified', additions: 3, deletions: 1, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 3, lines: ['-a', '+b', '+c', '+d'] }] }] },
        });
        out.push({ id: `k${t}-${s}`, ts: n++, type: 'text', text: big, streaming: false, parentId: `t${t}-${s}` });
      }
      out.push({ id: `a${t}`, ts: n++, type: 'text', text: `answer ${t} ${'y'.repeat(20_000)}`, streaming: false });
      out.push({ id: `e${t}`, ts: n++, type: 'turn', durationMs: 1000 });
    }
    return out;
  }

  it('sends the newest page, trimmed, with a cursor to the one before', () => {
    const items = long(60, 5);
    const page = phonePage(items);
    expect(page.total).toBe(60 * 8);
    const bytes = JSON.stringify(page).length;
    expect(bytes).toBeLessThan(100_000);
    // Newest last, starting at a message (a turn is not split).
    expect(page.items[page.items.length - 1].id).toBe('e59');
    expect(page.items[0].type).toBe('user');
    expect(page.cursor).toBe(page.items[0].id);
    const tool = page.items.find((i) => i.type === 'tool') as ToolItem & { more?: boolean };
    expect(tool.output).toBeUndefined();
    expect(tool.input).toBeUndefined();
    expect(tool.detail.newText).toBeUndefined();
    expect(tool.detail.command).toBe('pnpm test');
    expect(tool.result?.text).toBeUndefined();
    expect(tool.result?.images).toBeUndefined();
    expect(tool.result?.diff?.[0]).toMatchObject({ additions: 3, deletions: 1, hunks: [] });
    expect(tool.more).toBe(true);
    expect((tool as { kids?: number }).kids).toBe(1);
    // No sub-agent steps in a page; no picture data.
    expect(page.items.some((i) => i.parentId)).toBe(false);
    const user = page.items.find((i) => i.type === 'user') as UserItem;
    expect(user.attachments?.[0]).toEqual({ id: 'a', kind: 'image', name: 'shot.png' });
    // An answer keeps a generous length and says it was cut.
    const answer = page.items.find((i) => i.type === 'text') as TextItem & { cut?: boolean };
    expect(answer.text.length).toBe(LIMITS.answer);
    expect(answer.cut).toBe(true);
  });

  it('pages back to the start without gaps or repeats', () => {
    const items = long(25, 4);
    const roots = items.filter((i) => !i.parentId).map((i) => i.id);
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 100; i++) {
      const page = phonePage(items, { before });
      seen.unshift(...page.items.map((x) => x.id));
      before = page.cursor;
      if (!before) break;
    }
    expect(seen).toEqual(roots);
    // A cursor that is gone gives an empty page.
    expect(phonePage(items, { before: 'nope' }).items).toEqual([]);
  });

  it('cuts text between steps to a line, and returns one item in full on request', () => {
    const items: TimelineItem[] = [
      { id: 'u', ts: 0, type: 'user', text: 'go' },
      { id: 'x', ts: 1, type: 'text', text: 'z'.repeat(5000), streaming: false },
      { id: 't', ts: 2, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: { command: 'ls' }, output: 'line\n'.repeat(1000) },
      { id: 'c', ts: 3, type: 'thinking', text: 'w'.repeat(5000), streaming: false, parentId: 't' },
    ];
    const page = phonePage(items);
    expect((page.items[1] as TextItem).text.length).toBe(LIMITS.step);
    const d = phoneDetail(items, 't');
    expect((d.item as ToolItem).output?.split('\n').length).toBeLessThanOrEqual(202);
    expect(d.children.map((c) => c.id)).toEqual(['c']);
    expect(() => phoneDetail(items, 'gone')).toThrow();
  });

  it('trims live events: no tool output, no big results, text deltas pass', () => {
    expect(phoneEvent({ type: 'item.delta', sessionId: 's', id: 't', field: 'output', delta: big })).toBeNull();
    expect(phoneEvent({ type: 'item.delta', sessionId: 's', id: 't', field: 'text', delta: 'hi' })).toMatchObject({ delta: 'hi' });
    const patch = phoneEvent({ type: 'item.patch', sessionId: 's', id: 't', patch: { status: 'done', output: big, result: { text: big, exitCode: 0 } } as Partial<TimelineItem> });
    expect(JSON.stringify(patch).length).toBeLessThan(400);
    const reset = phoneEvent({ type: 'timeline.reset', sessionId: 's', items: long(30, 3) }) as { items: unknown[]; cursor?: string };
    expect(JSON.stringify(reset).length).toBeLessThan(100_000);
    expect(reset.cursor).toBeTruthy();
  });

  it('over the socket: a page, its compressed size, and events only for open conversations', async () => {
    const { app, port } = await setup();
    const { c } = await pairPhone(app, port);
    const created = (await c.call('session.create', { provider: 'demo', cwd: path.resolve('.') })) as { result: PhoneTail };
    const id = created.result.session.id;
    const other = await app.call('session.create', { provider: 'demo', cwd: path.resolve('.') });
    // A huge timeline loaded into the session.
    const rt = app.sessions.get(id)!;
    rt.load(long(40, 6), [], []);
    const before = (c.ws as unknown as { _socket: { bytesRead: number } })._socket.bytesRead;
    const tail = (await c.call('phone.tail', { sessionId: id })) as { ok: boolean; result: PhoneTail };
    const wire = (c.ws as unknown as { _socket: { bytesRead: number } })._socket.bytesRead - before;
    expect(tail.ok).toBe(true);
    expect(tail.result.items.length).toBeGreaterThan(5);
    expect(wire).toBeLessThan(40_000);
    // session.snapshot from a phone is cut to its page too.
    const snap = (await c.call('session.snapshot', { sessionId: id })) as { result: PhoneTail };
    expect(snap.result.cursor).toBeTruthy();
    expect(JSON.stringify(snap.result).length).toBeLessThan(100_000);
    const more = (await c.call('phone.tail', { sessionId: id, before: tail.result.cursor })) as { result: PhoneTail };
    expect(more.result.items[more.result.items.length - 1].id).not.toBe(tail.result.items[0].id);
    const one = (await c.call('phone.item', { sessionId: id, itemId: 't39-0' })) as { result: { item: ToolItem; children: unknown[] } };
    expect(one.result.item.result?.text?.length).toBeGreaterThan(1000);
    expect(one.result.children).toHaveLength(1);
    // Item events: the open conversation's, not another's.
    const n = c.frames.length;
    app.emit({ type: 'item.delta', sessionId: other.session.id, id: 'x', field: 'text', delta: 'elsewhere' });
    app.emit({ type: 'item.delta', sessionId: id, id: 'a39', field: 'text', delta: 'here' });
    app.emit({ type: 'item.delta', sessionId: id, id: 't39-0', field: 'output', delta: big });
    await c.next((f) => 'event' in f && (f.event as { delta?: string }).delta === 'here');
    await new Promise((r) => setTimeout(r, 50));
    const got = c.frames.slice(n).filter((f) => 'event' in f).map((f) => (f as { event: { delta?: string } }).event.delta);
    expect(got).toEqual(['here']);
    // Still only for phones: the localhost bridge has no such methods.
    await expect(app.call('phone.tail' as never, { sessionId: id } as never)).rejects.toThrow();
    c.ws.close();
  });
});

describe('desktop addresses', () => {
  it('the welcome lists them; a phone adds new ones to its pairing, the last good one first', async () => {
    const { app, port } = await setup();
    const { c } = await pairPhone(app, port);
    const w = c.frames.find((f) => 'welcome' in f) as { welcome: { hosts?: string[] } };
    expect(Array.isArray(w.welcome.hosts)).toBe(true);
    c.ws.close();
    // Paired at home, Tailscale installed later: its 100.x address joins, nothing repeats.
    expect(mergeHosts(['192.168.1.20', '10.0.0.5'], ['192.168.1.20', '100.101.7.9'], '192.168.1.20')).toEqual(['192.168.1.20', '100.101.7.9', '10.0.0.5']);
    expect(mergeHosts(['a1', 'a2', 'a3', 'a4'], ['b1', 'b2', 'b3', 'b4'], 'a2')).toHaveLength(6);
    expect(mergeHosts(['a1'], ['bad host!', 42, 'b1'], undefined)).toEqual(['b1', 'a1']);
    expect(mergeHosts(['a1'], undefined, 'a1')).toEqual(['a1']);
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
