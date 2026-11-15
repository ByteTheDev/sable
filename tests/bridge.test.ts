/** The bridge over a real socket: RPC frames, pushed events, origin checks and disposal. */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BRIDGE_PATH, type BridgeEvent, type RpcResponse, type ServerFrame, type SessionSnapshot } from '@shared/protocol';
import { attachBridge } from '../server/bridge';
import { DemoProvider } from '../server/providers/demo';

let server: Server;
let bridge: ReturnType<typeof attachBridge>;
let home: string;
let port: number;

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'sable-bridge-'));
  server = createServer((_req, res) => res.writeHead(404).end());
  bridge = attachBridge(server, { home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
  // The bridge leaves other upgrade paths alone (Vite's HMR socket); whoever hosts it must
  // close them, as server/standalone.ts does, or the half-open sockets keep the server alive.
  server.on('upgrade', (req, socket) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== BRIDGE_PATH) socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await bridge?.dispose();
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  rmSync(home, { recursive: true, force: true });
});

/** A small RPC client over `ws` that records every pushed event. */
async function connect(headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_PATH}`, { headers });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const events: BridgeEvent[] = [];
  const pending = new Map<number, (f: RpcResponse) => void>();
  const waiters: (() => void)[] = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as ServerFrame;
    if ('event' in frame) {
      events.push(frame.event);
      for (const w of waiters.splice(0)) w();
    } else pending.get(frame.id)?.(frame);
  });
  let next = 1;
  const call = (method: string, params: unknown = {}) =>
    new Promise<RpcResponse>((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const until = async (pred: () => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('Timed out waiting for bridge events');
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return { ws, events, call, until };
}

/** The status code of a handshake that the server refuses (or 101 when it accepts). */
function handshake(origin: string, host = `127.0.0.1:${port}`): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_PATH}`, { headers: { origin, host } });
    ws.once('open', () => {
      ws.close();
      resolve(101);
    });
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('error', () => resolve(-1));
  });
}

describe('bridge over a WebSocket', () => {
  it('answers app.hello, runs a demo turn and pushes its events', async () => {
    const c = await connect();
    const hello = await c.call('app.hello');
    expect(hello).toMatchObject({ ok: true });
    const app = (hello as { result: { version: string; providers: { id: string }[]; sessions: unknown[] } }).result;
    expect(app.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(app.providers.map((p) => p.id)).toEqual(['demo']);
    expect(app.sessions).toEqual([]);

    const created = await c.call('session.create', { provider: 'demo', cwd: path.join(home, 'relay-api'), mode: 'bypassPermissions' });
    expect(created.ok).toBe(true);
    const snap = (created as { result: SessionSnapshot }).result;
    const id = snap.session.id;
    expect(snap.session).toMatchObject({ provider: 'demo', status: 'idle', mode: 'bypassPermissions' });
    expect(c.events.find((e) => e.type === 'session.added')).toMatchObject({ session: { id } });

    const before = c.events.length;
    expect(await c.call('session.send', { sessionId: id, text: 'hi' })).toMatchObject({ ok: true });
    const statusOf = (e: BridgeEvent) => (e.type === 'session.updated' && e.id === id ? e.patch.status : undefined);
    await c.until(() => {
      const st = c.events.slice(before).map(statusOf).filter(Boolean);
      return st.includes('running') && st.at(-1) === 'idle';
    });

    const turn = c.events.slice(before);
    const added = turn.flatMap((e) => (e.type === 'item.added' && e.sessionId === id ? [e.item] : []));
    expect(added[0]).toMatchObject({ type: 'user', text: 'hi' });
    expect(added.some((i) => i.type === 'text')).toBe(true);
    expect(added.at(-1)?.type).toBe('turn');
    // The auto title comes from the first message.
    expect(turn.some((e) => e.type === 'session.updated' && e.patch.title === 'hi')).toBe(true);
    // Running comes before idle.
    const statuses = turn.map(statusOf).filter(Boolean);
    expect(statuses.indexOf('running')).toBeLessThan(statuses.lastIndexOf('idle'));

    // The streamed text and the snapshot agree.
    const after = (await c.call('session.snapshot', { sessionId: id })) as { ok: true; result: SessionSnapshot };
    const textItem = after.result.items.find((i) => i.type === 'text')!;
    const streamed = turn
      .filter((e) => e.type === 'item.delta' && e.id === textItem.id && e.field === 'text')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    const addedText = (added.find((i) => i.id === textItem.id) as { text: string }).text;
    expect(addedText + streamed).toBe((textItem as { text: string }).text);
    c.ws.close();
  });

  it('returns an error frame for an unknown method and for bad params', async () => {
    const c = await connect();
    const unknown = await c.call('nope.method');
    expect(unknown).toMatchObject({ ok: false });
    expect((unknown as { error: string }).error).toMatch(/nope\.method|unknown/i);
    const bad = await c.call('session.snapshot', { sessionId: 'does-not-exist' });
    expect(bad.ok).toBe(false);
    // The connection survives errors.
    expect((await c.call('app.hello')).ok).toBe(true);
    c.ws.close();
  });

  it('rejects handshakes from other origins and accepts the matching localhost origin', async () => {
    expect(await handshake('https://evil.example')).toBe(403);
    expect(await handshake(`http://localhost:${port + 1}`)).toBe(403);
    expect(await handshake('not a url')).toBe(403);
    expect(await handshake(`http://127.0.0.1:${port}`)).toBe(101);
    expect(await handshake(`http://localhost:${port}`, `localhost:${port}`)).toBe(101);
  });

  it('ignores upgrades on other paths (left for Vite HMR)', async () => {
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
      ws.once('open', () => (ws.close(), resolve(101)));
      ws.once('error', () => resolve(-1));
    });
    expect(status).not.toBe(101);
  });
});
