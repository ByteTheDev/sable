import { BRIDGE_PATH, type BridgeEvent, type RpcMethods, type RpcName, type ServerFrame } from '@shared/protocol';

export type ConnStatus = 'connecting' | 'open' | 'closed';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number };

/** WebSocket RPC client for the Sable bridge. Reconnects on its own. */
class Bridge {
  status: ConnStatus = 'connecting';
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private outbox: string[] = [];
  private listeners = new Set<(e: BridgeEvent) => void>();
  private statusListeners = new Set<(s: ConnStatus) => void>();
  private retry = 0;
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    this.open();
  }

  private open() {
    this.setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${BRIDGE_PATH}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('open');
      for (const frame of this.outbox.splice(0)) ws.send(frame);
    };
    ws.onmessage = (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if ('event' in frame) {
        for (const l of this.listeners) l(frame.event);
        return;
      }
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.result);
      else p.reject(new Error(frame.error));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.setStatus('closed');
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Connection to the bridge was lost'));
        this.pending.delete(id);
      }
      const delay = Math.min(4000, 300 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private setStatus(s: ConnStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  call<M extends RpcName>(method: M, params: RpcMethods[M]['params'], timeoutMs = 60_000): Promise<RpcMethods[M]['result']> {
    const id = this.nextId++;
    const frame = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
      else this.outbox.push(frame);
    });
  }

  on(listener: (e: BridgeEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onStatus(listener: (s: ConnStatus) => void) {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }
}

export const bridge = new Bridge();
