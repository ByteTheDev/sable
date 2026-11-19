import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  PHONE_METHODS,
  PHONE_PATH,
  PHONE_PORT,
  type BridgeEvent,
  type PhoneDevice,
  type PhoneFrame,
  type PhoneHello,
  type PhoneStatus,
  type RpcName,
  type RpcRequest,
  type ServerFrame,
} from '../../shared/protocol';
import type { App } from '../app';
import { VERSION } from '../version';
import { qrSvgPath } from './qr';

/**
 * The phone endpoint: Sable's phone app (`mobile/`) on the home network.
 *
 * - Its own HTTP server on all interfaces at `PHONE_PORT`, started only while Settings › Phone is
 *   on. The localhost bridge is untouched: nothing here is reachable through it, and the phone
 *   never reaches the localhost bridge.
 * - Pairing: a one-time key (QR code / link, valid 10 minutes, used up by the first phone that
 *   presents it), then "Allow <phone>?" on the desktop. An allowed phone gets a 256-bit token,
 *   stored here only as a SHA-256 hash; Settings › Phone revokes it.
 * - Every socket authenticates first (`hello` with the token) within a few seconds; wrong keys and
 *   tokens are counted per address and block it for a while; there is a cap on sockets.
 * - Authenticated sockets may call only `PHONE_METHODS`, with their parameters narrowed; they get
 *   the conversation events, never terminal output, browser requests, sign-in links or this
 *   service's own state (which holds the pairing key).
 */

interface StoredPhone {
  id: string;
  name: string;
  /** SHA-256 of the token, hex. */
  tokenHash: string;
  pairedAt: number;
  lastSeen?: number;
}

interface PhoneFile {
  enabled: boolean;
  devices: StoredPhone[];
}

export interface PhoneOptions {
  /** Port to listen on (tests use 0). */
  port?: number;
  /** Interface to listen on (tests use 127.0.0.1). */
  host?: string;
  /** Where the paired phones are kept (defaults to `<SABLE_HOME>/phone.json`). */
  file?: string;
}

const PAIR_TTL_MS = 10 * 60_000;
const REQUEST_TTL_MS = 2 * 60_000;
const HELLO_TIMEOUT_MS = 8_000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
const BLOCK_MS = 15 * 60_000;
const GLOBAL_FAILS_PER_MIN = 30;
const MAX_SOCKETS = 12;
const MAX_HELLO_BYTES = 4096;
/** A phone that falls this far behind (bytes queued) is dropped; it reconnects and reloads. */
const MAX_BUFFERED = 24 * 1024 * 1024;

/** Events a phone needs to show conversations, limits and folders. */
const PHONE_EVENTS = new Set<BridgeEvent['type']>([
  'provider.updated',
  'projects.updated',
  'settings.updated',
  'session.added',
  'session.updated',
  'session.removed',
  'session.caps',
  'item.added',
  'item.delta',
  'item.patch',
  'item.removed',
  'timeline.reset',
  'permission.added',
  'permission.removed',
  'question.added',
  'question.removed',
  'todos.updated',
  'suggestion',
  'queue.updated',
  'limits.updated',
  'limits.report',
  'limit.reset',
  'caps.updated',
  'toast',
]);

const ALLOWED = new Set<string>(PHONE_METHODS);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a), 'hex');
  const y = Buffer.from(sha256(b), 'hex');
  return timingSafeEqual(x, y);
}

/** A phone's name as shown on the desktop: printable, short. */
function cleanName(name: unknown): string {
  const s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 40);
  return s || 'Phone';
}

/** Only pages of the phone app itself (or non-browser clients) may open a socket here. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.hostname === 'localhost' && ['http:', 'https:', 'capacitor:'].includes(o.protocol);
  } catch {
    return false;
  }
}

/** This computer's IPv4 addresses on private networks, the likely home network first. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== 'IPv4') continue;
      if (/^169\.254\./.test(a.address)) continue;
      out.push(a.address);
    }
  }
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ? 3 : 4);
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b)).slice(0, 4);
}

/** Narrows what a phone may pass to a method beyond the allowlist itself. */
function narrow(method: string, params: Record<string, unknown>): Record<string, unknown> {
  const p = { ...params };
  if (method === 'session.setOptions') {
    const o = (p.options ?? {}) as Record<string, unknown>;
    p.options = 'remoteControl' in o ? { remoteControl: !!o.remoteControl } : {};
  }
  if (method === 'session.create') {
    const o = p.options as Record<string, unknown> | undefined;
    if (o && typeof o === 'object') p.options = 'remoteControl' in o ? { remoteControl: !!o.remoteControl } : undefined;
    delete p.handoverFrom;
  }
  if (method === 'session.update') {
    const patch = (p.patch ?? {}) as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const k of ['pinned', 'archived', 'unread'] as const) if (typeof patch[k] === 'boolean') out[k] = patch[k] as boolean;
    p.patch = out;
  }
  if (method === 'provider.limits') delete p.force;
  return p;
}

export class PhoneService {
  private server?: Server;
  private wss?: WebSocketServer;
  private file: string;
  private data: PhoneFile;
  private listening = false;
  private error?: string;
  private port: number;
  private host: string;
  private pairing?: { key: string; expiresAt: number; link: string; qr: string; size: number };
  private request?: { id: string; name: string; address: string; at: number; ws: WebSocket; timer: NodeJS.Timeout };
  private fails = new Map<string, { count: number; first: number; blockedUntil?: number }>();
  private globalFails: number[] = [];
  /** Authenticated sockets per device id. */
  private live = new Map<string, Set<WebSocket>>();
  private saveTimer?: NodeJS.Timeout;
  private starting?: Promise<void>;

  constructor(
    private app: App,
    opts: PhoneOptions = {},
  ) {
    this.file = opts.file ?? path.join(app.store.dir, 'phone.json');
    this.port = opts.port ?? PHONE_PORT;
    this.host = opts.host ?? process.env.SABLE_PHONE_HOST ?? '0.0.0.0';
    this.data = this.read();
  }

  get enabled() {
    return this.data.enabled;
  }

  private read(): PhoneFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PhoneFile>;
      const devices = Array.isArray(raw.devices) ? raw.devices.filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(d.tokenHash)) : [];
      return { enabled: !!raw.enabled, devices };
    } catch {
      return { enabled: false, devices: [] };
    }
  }

  private save(now = false) {
    clearTimeout(this.saveTimer);
    const write = () => {
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        renameSync(tmp, this.file);
      } catch (err) {
        this.app.log('phone: could not save', (err as Error).message);
      }
    };
    if (now) write();
    else this.saveTimer = setTimeout(write, 2000);
  }

  status(): PhoneStatus {
    if (this.pairing && this.pairing.expiresAt < Date.now()) this.pairing = undefined;
    const devices: PhoneDevice[] = this.data.devices
      .map((d) => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen, ...(this.live.get(d.id)?.size ? { online: true } : {}) }))
      .sort((a, b) => (b.lastSeen ?? b.pairedAt) - (a.lastSeen ?? a.pairedAt));
    return {
      enabled: this.data.enabled,
      listening: this.listening,
      port: this.port,
      hosts: lanAddresses(),
      name: os.hostname(),
      devices,
      ...(this.pairing ? { pairing: { link: this.pairing.link, expiresAt: this.pairing.expiresAt, qr: this.pairing.qr, size: this.pairing.size } } : {}),
      ...(this.request ? { request: { id: this.request.id, name: this.request.name, address: this.request.address, at: this.request.at } } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private changed() {
    this.app.emit({ type: 'phone.updated', status: this.status() });
  }

  async setEnabled(on: boolean) {
    this.data.enabled = on;
    this.save(true);
    if (on) await this.start();
    else await this.stop();
    this.changed();
    return this.status();
  }

  start(): Promise<void> {
    if (this.server) return this.starting ?? Promise.resolve();
    this.error = undefined;
    const server = createServer((req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end();
      void req;
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 10_000;
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => this.onUpgrade(wss, req, socket, head));
    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => this.onSocket(ws, req));
    this.server = server;
    this.wss = wss;
    this.starting = new Promise<void>((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.listening = false;
        this.error = err.code === 'EADDRINUSE' ? `Port ${this.port} is in use by another program` : err.message;
        this.server = undefined;
        this.wss = undefined;
        this.changed();
        resolve();
      });
      server.listen(this.port, this.host, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
        this.listening = true;
        this.app.log(`phone endpoint on ${this.host}:${this.port}`);
        this.changed();
        resolve();
      });
    });
    return this.starting;
  }

  async stop() {
    this.listening = false;
    this.pairing = undefined;
    this.endRequest('Phone access was turned off');
    const server = this.server;
    const wss = this.wss;
    this.server = undefined;
    this.wss = undefined;
    this.starting = undefined;
    if (wss) {
      for (const c of wss.clients) c.terminate();
      wss.close();
    }
    this.live.clear();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  pair(cancel?: boolean) {
    if (cancel) this.pairing = undefined;
    else {
      const key = randomBytes(16).toString('base64url');
      const hosts = lanAddresses();
      const link = `sable://pair?h=${hosts.join(',')}&p=${this.port}&k=${key}&n=${encodeURIComponent(os.hostname().slice(0, 30))}`;
      const { path: qr, size } = qrSvgPath(link);
      this.pairing = { key, expiresAt: Date.now() + PAIR_TTL_MS, link, qr, size };
    }
    this.changed();
    return this.status();
  }

  approve(requestId: string, allow: boolean) {
    const r = this.request;
    if (!r || r.id !== requestId) return this.status();
    clearTimeout(r.timer);
    this.request = undefined;
    if (!allow) {
      this.sendFrame(r.ws, { denied: 'The desktop did not allow this phone' });
      r.ws.close(4003, 'denied');
    } else if (r.ws.readyState === r.ws.OPEN) {
      const token = randomBytes(32).toString('base64url');
      const device: StoredPhone = { id: randomUUID(), name: r.name, tokenHash: sha256(token), pairedAt: Date.now(), lastSeen: Date.now() };
      this.data.devices.push(device);
      this.save(true);
      this.sendFrame(r.ws, { paired: { token, deviceId: device.id, desktop: os.hostname() } });
      this.authenticated(r.ws, device);
    }
    this.changed();
    return this.status();
  }

  revoke(deviceId: string) {
    this.data.devices = this.data.devices.filter((d) => d.id !== deviceId);
    this.save(true);
    for (const ws of this.live.get(deviceId) ?? []) {
      this.sendFrame(ws, { denied: 'This phone was removed on the desktop' });
      ws.close(4001, 'revoked');
    }
    this.live.delete(deviceId);
    this.changed();
    return this.status();
  }

  private endRequest(reason: string) {
    const r = this.request;
    if (!r) return;
    clearTimeout(r.timer);
    this.request = undefined;
    this.sendFrame(r.ws, { denied: reason });
    r.ws.close(4003, 'denied');
  }

  // ── rate limits ──

  private blocked(ip: string): boolean {
    const now = Date.now();
    this.globalFails = this.globalFails.filter((t) => now - t < 60_000);
    if (this.globalFails.length >= GLOBAL_FAILS_PER_MIN) return true;
    const f = this.fails.get(ip);
    return !!f?.blockedUntil && f.blockedUntil > now;
  }

  private failed(ip: string) {
    const now = Date.now();
    this.globalFails.push(now);
    let f = this.fails.get(ip);
    if (!f || now - f.first > FAIL_WINDOW_MS) f = { count: 0, first: now };
    f.count++;
    if (f.count >= MAX_FAILS) f.blockedUntil = now + BLOCK_MS;
    this.fails.set(ip, f);
    if (this.fails.size > 1000) for (const [k, v] of this.fails) if (now - v.first > FAIL_WINDOW_MS) this.fails.delete(k);
  }

  // ── sockets ──

  private onUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer) {
    const ip = req.socket.remoteAddress ?? '?';
    const url = new URL(req.url ?? '/', 'http://phone');
    const refuse = (code: number, text: string) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nconnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== PHONE_PATH) return refuse(404, 'Not Found');
    if (!originAllowed(req)) return refuse(403, 'Forbidden');
    if (this.blocked(ip)) return refuse(429, 'Too Many Requests');
    if (wss.clients.size >= MAX_SOCKETS) return refuse(503, 'Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  private sendFrame(ws: WebSocket, frame: PhoneFrame | ServerFrame) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(frame));
  }

  private onSocket(ws: WebSocket, req: IncomingMessage) {
    const ip = req.socket.remoteAddress ?? '?';
    let state: 'hello' | 'waiting' | 'open' = 'hello';
    const helloTimer = setTimeout(() => {
      if (state === 'hello') ws.close(4000, 'timeout');
    }, HELLO_TIMEOUT_MS);

    const onHello = (raw: RawData) => {
      if (state !== 'hello') return;
      const text = raw.toString();
      if (text.length > MAX_HELLO_BYTES) return ws.close(1009, 'too big');
      let msg: PhoneHello;
      try {
        msg = JSON.parse(text);
      } catch {
        return ws.close(4000, 'bad hello');
      }
      if ('hello' in msg && msg.hello && typeof msg.hello.token === 'string') {
        const hash = sha256(msg.hello.token);
        const device = this.data.devices.find((d) => timingSafeEqual(Buffer.from(d.tokenHash, 'hex'), Buffer.from(hash, 'hex')));
        if (!device) {
          this.failed(ip);
          this.sendFrame(ws, { denied: 'This phone is not paired with this computer' });
          return ws.close(4001, 'unknown token');
        }
        this.fails.delete(ip);
        clearTimeout(helloTimer);
        ws.off('message', onHello);
        state = 'open';
        this.authenticated(ws, device);
        return;
      }
      if ('pair' in msg && msg.pair && typeof msg.pair.key === 'string') {
        const p = this.pairing;
        if (!p || p.expiresAt < Date.now() || !sameSecret(msg.pair.key, p.key)) {
          this.failed(ip);
          this.sendFrame(ws, { denied: p ? 'This pairing code is not valid. Show a new one on the desktop.' : 'Pairing is not open. Show the code in Settings › Phone.' });
          return ws.close(4002, 'bad key');
        }
        // One phone per key; a second request replaces nothing while one waits.
        if (this.request) {
          this.sendFrame(ws, { denied: 'Another phone is pairing. Try again in a moment.' });
          return ws.close(4003, 'busy');
        }
        this.pairing = undefined;
        clearTimeout(helloTimer);
        state = 'waiting';
        const id = randomUUID();
        this.request = {
          id,
          name: cleanName(msg.pair.name),
          address: ip.replace(/^::ffff:/, ''),
          at: Date.now(),
          ws,
          timer: setTimeout(() => {
            if (this.request?.id === id) {
              this.endRequest('Nobody answered on the desktop');
              this.changed();
            }
          }, REQUEST_TTL_MS),
        };
        this.sendFrame(ws, { waiting: true });
        ws.off('message', onHello);
        this.changed();
        return;
      }
      ws.close(4000, 'bad hello');
    };
    ws.on('message', onHello);
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (this.request?.ws === ws) {
        clearTimeout(this.request.timer);
        this.request = undefined;
        this.changed();
      }
    });
    ws.on('error', () => ws.terminate());
  }

  /** From here on the socket is a narrowed bridge connection for `device`. */
  private authenticated(ws: WebSocket, device: StoredPhone) {
    device.lastSeen = Date.now();
    this.save();
    let set = this.live.get(device.id);
    if (!set) this.live.set(device.id, (set = new Set()));
    set.add(ws);
    this.sendFrame(ws, { welcome: { deviceId: device.id, desktop: os.hostname(), version: VERSION } });
    this.changed();

    const unsubscribe = this.app.subscribe((event) => {
      if (PHONE_EVENTS.has(event.type)) this.sendFrame(ws, { event });
    });
    let alive = true;
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 25_000);

    ws.on('message', async (raw) => {
      let req: RpcRequest;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof req?.id !== 'number' || typeof req.method !== 'string') return;
      if (!ALLOWED.has(req.method)) {
        this.sendFrame(ws, { id: req.id, ok: false, error: `Not available from the phone: ${req.method}` });
        return;
      }
      try {
        const params = narrow(req.method, req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {});
        let result: unknown = await this.app.call(req.method as RpcName, params as never);
        // Folder browsing for a new chat: folders only, never file names.
        if (req.method === 'fs.list' && result && typeof result === 'object') {
          const r = result as { entries?: { dir: boolean }[] };
          result = { ...r, entries: (r.entries ?? []).filter((e) => e.dir) };
        }
        this.sendFrame(ws, { id: req.id, ok: true, result });
      } catch (err) {
        this.sendFrame(ws, { id: req.id, ok: false, error: (err as Error).message ?? String(err) });
      }
    });
    const done = () => {
      clearInterval(ping);
      unsubscribe();
      const s = this.live.get(device.id);
      s?.delete(ws);
      if (s && !s.size) this.live.delete(device.id);
      const d = this.data.devices.find((x) => x.id === device.id);
      if (d) {
        d.lastSeen = Date.now();
        this.save();
      }
      this.changed();
    };
    ws.once('close', done);
  }

  async dispose() {
    clearTimeout(this.saveTimer);
    this.save(true);
    await this.stop();
  }
}

export function registerPhone(app: App, opts: PhoneOptions = {}) {
  const phone = new PhoneService(app, opts);
  app.register('phone.status', () => phone.status());
  app.register('phone.setEnabled', ({ on }) => phone.setEnabled(!!on));
  app.register('phone.pair', ({ cancel } = {}) => phone.pair(!!cancel));
  app.register('phone.approve', ({ requestId, allow }) => phone.approve(String(requestId), !!allow));
  app.register('phone.revoke', ({ deviceId }) => phone.revoke(String(deviceId)));
  app.onDispose(() => phone.dispose());
  if (phone.enabled) void phone.start();
  return phone;
}
