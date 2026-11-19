import { PHONE_PATH, type BridgeEvent, type PhoneFrame, type PhoneMethods, type RpcMethods, type RpcResponse } from '@shared/protocol';

/** Everything the phone may ask: the allowlisted bridge methods and the phone endpoint's own. */
type Methods = RpcMethods & PhoneMethods;
import { loadPairing, savePairing } from './native';
import { mergeHosts, sameHosts } from './hosts';

/** What the phone keeps after pairing: where the desktop is and the token it gave this phone. */
export interface Pairing {
  hosts: string[];
  port: number;
  token: string;
  deviceId: string;
  desktop: string;
  /** The address that answered last (tried first next time). */
  lastHost?: string;
}

/** A pairing link: `sable://pair?h=<ips>&p=<port>&k=<key>&n=<desktop>`. */
export interface PairOffer {
  hosts: string[];
  port: number;
  key: string;
  name?: string;
}

export type ConnState = 'unpaired' | 'connecting' | 'open' | 'offline' | 'denied';

export function parsePairLink(text: string): PairOffer | null {
  const t = text.trim();
  const m = /sable:\/\/pair\?([^\s]+)/i.exec(t);
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const hosts = (q.get('h') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => /^[\w.:-]+$/.test(h));
  const port = Number(q.get('p'));
  const key = q.get('k') ?? '';
  if (!hosts.length || !Number.isInteger(port) || port <= 0 || port > 65535 || key.length < 16) return null;
  return { hosts, port, key, name: q.get('n') ?? undefined };
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number };

const url = (host: string, port: number) => `ws://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}${PHONE_PATH}`;

/**
 * Opens a socket to the first of `hosts` that answers (the last good one first, the others a
 * moment later), and resolves with it once it is open. Rejects when none answers.
 */
function race(hosts: string[], port: number, first?: string, timeoutMs = 6000): Promise<{ ws: WebSocket; host: string }> {
  const order = first && hosts.includes(first) ? [first, ...hosts.filter((h) => h !== first)] : hosts;
  return new Promise((resolve, reject) => {
    const sockets: WebSocket[] = [];
    let done = false;
    let failed = 0;
    const timers: number[] = [];
    const finish = () => {
      done = true;
      timers.forEach(clearTimeout);
    };
    const overall = window.setTimeout(() => {
      if (done) return;
      finish();
      sockets.forEach((s) => s.close());
      reject(new Error('The desktop did not answer'));
    }, timeoutMs);
    timers.push(overall);
    order.forEach((host, i) => {
      timers.push(
        window.setTimeout(() => {
          if (done) return;
          let ws: WebSocket;
          try {
            ws = new WebSocket(url(host, port));
          } catch {
            if (++failed === order.length) {
              finish();
              reject(new Error('The desktop did not answer'));
            }
            return;
          }
          sockets.push(ws);
          ws.onopen = () => {
            if (done) return ws.close();
            finish();
            sockets.forEach((s) => s !== ws && s.close());
            resolve({ ws, host });
          };
          ws.onerror = () => {
            if (done) return;
            if (++failed === order.length) {
              finish();
              reject(new Error('The desktop did not answer'));
            }
          };
        }, i === 0 ? 0 : 450 + i * 150),
      );
    });
  });
}

/** The phone's connection to its desktop: pairing, the token hello, RPC and events, reconnecting on its own. */
class Conn {
  state: ConnState = 'unpaired';
  pairing: Pairing | null = null;
  error?: string;
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(e: BridgeEvent) => void>();
  private stateListeners = new Set<() => void>();
  private openListeners = new Set<() => void>();
  private retry = 0;
  private retryTimer?: number;
  private connecting = false;

  async init() {
    // A network that comes back (Wi-Fi again after mobile data) reconnects at once.
    window.addEventListener('online', () => this.wake());
    this.pairing = await loadPairing();
    if (this.pairing) void this.connect();
    else this.setState('unpaired');
  }

  private setState(s: ConnState, error?: string) {
    this.state = s;
    this.error = error;
    for (const l of this.stateListeners) l();
  }

  onState(l: () => void) {
    this.stateListeners.add(l);
    return () => void this.stateListeners.delete(l);
  }

  /** Called each time the connection (re)opens: reload what is shown. */
  onOpen(l: () => void) {
    this.openListeners.add(l);
    return () => void this.openListeners.delete(l);
  }

  on(l: (e: BridgeEvent) => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  /**
   * Reconnects now (the app came back to the front, the network changed). A socket that still
   * looks open after the phone slept is checked with a small call and replaced when it is dead.
   */
  wake() {
    if (!this.pairing || this.state === 'denied') return;
    if (this.state === 'open') {
      const ws = this.ws;
      void this.call('usage.limits', {}, 4000).catch(() => {
        if (this.ws === ws) ws?.close();
      });
      return;
    }
    clearTimeout(this.retryTimer);
    this.retry = 0;
    void this.connect();
  }

  async connect() {
    const p = this.pairing;
    if (!p || this.connecting) return;
    this.connecting = true;
    clearTimeout(this.retryTimer);
    if (this.state !== 'open') this.setState('connecting');
    try {
      const { ws, host } = await race(p.hosts, p.port, p.lastHost);
      await new Promise<void>((resolve, reject) => {
        ws.onmessage = (ev) => {
          let f: PhoneFrame;
          try {
            f = JSON.parse(ev.data as string);
          } catch {
            return;
          }
          if ('welcome' in f) {
            // The desktop's addresses now join the saved ones (Tailscale installed after pairing: reachable there next time).
            const hosts = mergeHosts(p.hosts, f.welcome.hosts, host);
            if (p.lastHost !== host || p.desktop !== f.welcome.desktop || !sameHosts(hosts, p.hosts)) {
              p.lastHost = host;
              p.desktop = f.welcome.desktop;
              p.hosts = hosts;
              void savePairing(p);
            }
            this.adopt(ws);
            resolve();
          } else if ('denied' in f) {
            reject(Object.assign(new Error(f.denied), { denied: true }));
          }
        };
        ws.onclose = (ev) =>
          reject(ev.code === 4001 ? Object.assign(new Error('This phone was removed on the desktop'), { denied: true }) : new Error('The desktop closed the connection'));
        ws.send(JSON.stringify({ hello: { token: p.token } }));
      });
    } catch (err) {
      const e = err as Error & { denied?: boolean };
      if (e.denied) {
        this.setState('denied', e.message);
      } else {
        this.setState('offline', e.message);
        this.scheduleRetry();
      }
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Backoff with a little jitter: 0.6, 1.2, 2.4, 4.8 s, then every 8 s while the app is in front
   * (30 s in the background, where Android throttles timers anyway). Coming back to the front, a
   * network change or a tap on "Try again" reconnects at once (`wake`).
   */
  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    const cap = document.hidden ? 30_000 : 8000;
    const delay = Math.min(cap, 600 * 2 ** this.retry++) * (0.85 + Math.random() * 0.3);
    this.retryTimer = window.setTimeout(() => void this.connect(), delay);
  }

  /** An authenticated socket becomes the connection. */
  private adopt(ws: WebSocket) {
    // One socket feeds the store, never two: a second one would apply every streamed piece twice.
    const old = this.ws;
    if (old && old !== ws) {
      old.onmessage = null;
      old.onclose = null;
      old.close();
    }
    this.ws = ws;
    this.retry = 0;
    ws.onmessage = (ev) => {
      let f: RpcResponse | { event: BridgeEvent } | PhoneFrame;
      try {
        f = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if ('event' in f) {
        for (const l of this.listeners) l(f.event);
        return;
      }
      if ('denied' in f) {
        this.setState('denied', f.denied);
        return;
      }
      if (!('id' in f)) return;
      const pending = this.pending.get(f.id);
      if (!pending) return;
      this.pending.delete(f.id);
      clearTimeout(pending.timer);
      if (f.ok) pending.resolve(f.result);
      else pending.reject(new Error(f.error));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('The connection to the desktop was lost'));
        this.pending.delete(id);
      }
      if (ev.code === 4001) {
        this.setState('denied', 'This phone was removed on the desktop');
        return;
      }
      if (this.state !== 'denied') {
        this.setState('offline', 'Reconnecting');
        this.scheduleRetry();
      }
    };
    this.setState('open');
    for (const l of this.openListeners) l();
  }

  call<M extends keyof Methods>(method: M, params: Methods[M]['params'], timeoutMs = 30_000): Promise<Methods[M]['result']> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected to the desktop'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The desktop did not answer in time'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Pairs with a desktop: presents the one-time key, waits while the desktop asks "Allow?", keeps
   * the token it gives. `onWaiting` runs once the desktop has the request.
   */
  async pair(offer: PairOffer, name: string, onWaiting: () => void): Promise<void> {
    this.forgetSocket();
    const { ws, host } = await race(offer.hosts, offer.port);
    this.pairSocket = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        ws.close();
        reject(new Error('Nobody answered on the desktop'));
      }, 150_000);
      ws.onmessage = (ev) => {
        let f: PhoneFrame;
        try {
          f = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if ('waiting' in f) onWaiting();
        else if ('paired' in f) {
          this.pairing = { hosts: offer.hosts, port: offer.port, token: f.paired.token, deviceId: f.paired.deviceId, desktop: f.paired.desktop, lastHost: host };
          void savePairing(this.pairing);
        } else if ('welcome' in f) {
          clearTimeout(timer);
          if (this.pairing) {
            this.pairing.hosts = mergeHosts(this.pairing.hosts, f.welcome.hosts, host);
            void savePairing(this.pairing);
          }
          this.adopt(ws);
          resolve();
        } else if ('denied' in f) {
          clearTimeout(timer);
          reject(new Error(f.denied));
        }
      };
      ws.onclose = () => {
        clearTimeout(timer);
        reject(new Error('The desktop closed the connection'));
      };
      ws.send(JSON.stringify({ pair: { key: offer.key, name } }));
    });
  }

  private pairSocket?: WebSocket;

  /** Gives up a pairing in progress (the desktop's question goes away with the socket). */
  cancelPair() {
    this.pairSocket?.close();
    this.pairSocket = undefined;
  }

  private forgetSocket() {
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }

  /** Forgets the desktop on this phone (the desktop keeps the entry until removed there). */
  async forget() {
    this.forgetSocket();
    this.pairing = null;
    await savePairing(null);
    this.setState('unpaired');
  }
}

export const conn = new Conn();

// Development: a module swapped in place closes its old socket (two live sockets would double every event).
import.meta.hot?.dispose(() => conn.cancelPair());
import.meta.hot?.dispose(() => (conn as unknown as { forgetSocket: () => void }).forgetSocket());
