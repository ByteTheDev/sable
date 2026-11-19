import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, BridgeEvent, PhoneStatus, SessionMeta } from '../shared/protocol';
import { phoneWantsAwake, watchAwake, watchPhoneAwake } from '../server/core/awake';

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

describe('keep awake for the phone', () => {
  const status = (enabled: boolean, devices: number) => ({ enabled, devices: Array.from({ length: devices }, (_, i) => ({ id: String(i), name: 'p', pairedAt: 0 })) }) as unknown as PhoneStatus;

  it('wants the computer up only with the phone on, a phone paired and the setting not off', () => {
    expect(phoneWantsAwake(status(true, 1), {} as AppSettings)).toBe(true);
    expect(phoneWantsAwake(status(true, 0), {} as AppSettings)).toBe(false);
    expect(phoneWantsAwake(status(false, 1), {} as AppSettings)).toBe(false);
    expect(phoneWantsAwake(status(true, 1), { phoneAwake: false } as AppSettings)).toBe(false);
    expect(phoneWantsAwake(undefined, {} as AppSettings)).toBe(false);
  });

  it('follows the phone and the settings by their events', async () => {
    const listeners = new Set<(e: BridgeEvent) => void>();
    let settings = {} as AppSettings;
    const calls: boolean[] = [];
    const stop = watchPhoneAwake(
      { subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)), phone: async () => status(true, 1), settings: () => settings },
      (on) => calls.push(on),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([true]);
    settings = { phoneAwake: false } as AppSettings;
    for (const l of listeners) l({ type: 'settings.updated', settings });
    expect(calls).toEqual([true, false]);
    settings = {} as AppSettings;
    for (const l of listeners) l({ type: 'phone.updated', status: status(true, 0) });
    expect(calls).toEqual([true, false]);
    stop();
    expect(listeners.size).toBe(0);
  });
});
