import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, SessionMeta } from '../shared/protocol';
import { watchAwake } from '../server/core/awake';

type S = { meta: SessionMeta; turnActive: boolean };

function source() {
  const sessions: S[] = [];
  const listeners = new Set<(e: BridgeEvent) => void>();
  const add = (status: SessionMeta['status'], extra: Partial<SessionMeta> = {}) => {
    const s: S = { meta: { id: String(sessions.length), status, ...extra } as SessionMeta, turnActive: false };
    sessions.push(s);
    return s;
  };
  const set = (s: S, patch: Partial<SessionMeta>) => {
    Object.assign(s.meta, patch);
    for (const l of listeners) l({ type: 'session.updated', id: s.meta.id, patch });
  };
  return {
    src: { sessions, subscribe: (l: (e: BridgeEvent) => void) => (listeners.add(l), () => void listeners.delete(l)) },
    add,
    set,
    listeners,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('keep awake', () => {
  it('blocks sleep while a turn runs and releases a minute after the last one ends', () => {
    vi.useFakeTimers();
    const { src, add, set } = source();
    const a = add('idle');
    const calls: boolean[] = [];
    const stop = watchAwake(src, (b) => calls.push(b));
    expect(calls).toEqual([]);
    set(a, { status: 'running' });
    expect(calls).toEqual([true]);
    set(a, { status: 'idle' });
    vi.advanceTimersByTime(30_000);
    // Work again within the minute: the block is kept, not taken twice.
    set(a, { status: 'running' });
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual([true]);
    set(a, { status: 'idle' });
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual([true, false]);
    stop();
    expect(calls).toEqual([true, false]);
  });

  it('counts an /until check between turns as work, and lets go of everything when stopped', () => {
    vi.useFakeTimers();
    const { src, add, set, listeners } = source();
    const a = add('idle');
    const calls: boolean[] = [];
    const stop = watchAwake(src, (b) => calls.push(b));
    set(a, { until: { phase: 'checking' } as SessionMeta['until'] });
    expect(calls).toEqual([true]);
    stop();
    expect(calls).toEqual([true, false]);
    expect(listeners.size).toBe(0);
  });
});
