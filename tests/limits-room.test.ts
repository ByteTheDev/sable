import { describe, expect, it } from 'vitest';
import type { RateLimit } from '@shared/protocol';
import { overview, roomCount, roomRow, sortRows, tightest, type RoomInput } from '@/features/usage/room';

const NOW = 1_000_000_000_000;
const H = 3_600_000;
const win = (id: string, percent: number, inHours?: number, windowMins = 300): RateLimit => ({ id, label: id, percent, resetsAt: inHours === undefined ? undefined : NOW + inHours * H, windowMins }) as RateLimit;
const acc = (name: string, limits: RateLimit[] | undefined, extra: Partial<RoomInput> = {}): RoomInput => ({ key: name, name, provider: 'claude', usable: true, limits, ...extra });

describe('room left', () => {
  it('takes the tightest window, and ignores one whose reset has passed', () => {
    expect(tightest([win('a', 20, 2), win('b', 70, 90)], NOW)?.id).toBe('b');
    expect(tightest([win('a', 95, -1), win('b', 30, 90)], NOW)?.id).toBe('b');
    expect(roomRow(acc('x', [win('a', 95, -1), win('b', 30, 90)]), NOW)).toMatchObject({ room: 70, state: 'room' });
  });

  it('names the states: room, near, cap, unknown, off', () => {
    expect(roomRow(acc('a', [win('w', 79, 1)]), NOW).state).toBe('room');
    expect(roomRow(acc('a', [win('w', 80, 1)]), NOW).state).toBe('near');
    expect(roomRow(acc('a', [win('w', 100, 1)]), NOW)).toMatchObject({ state: 'cap', room: 0 });
    expect(roomRow(acc('a', []), NOW).state).toBe('unknown');
    expect(roomRow(acc('a', [win('w', 10, 1)], { usable: false }), NOW).state).toBe('off');
  });

  it('orders by room left, unknown last, names breaking ties in natural order', () => {
    const rows = [acc('Team 10', [win('w', 40, 1)]), acc('Team 2', [win('w', 40, 1)]), acc('none', undefined), acc('wide', [win('w', 5, 3)])].map((a) => roomRow(a, NOW));
    expect(sortRows(rows, 'room').map((r) => r.input.name)).toEqual(['wide', 'Team 2', 'Team 10', 'none']);
  });

  it('orders by reset, soonest first, windows without a reset last', () => {
    const rows = [acc('late', [win('w', 10, 9)]), acc('soon', [win('w', 90, 1)]), acc('never', [win('w', 10)])].map((a) => roomRow(a, NOW));
    expect(sortRows(rows, 'reset').map((r) => r.input.name)).toEqual(['soon', 'late', 'never']);
  });

  it('orders by agent in the given order, then by name', () => {
    const rows = [acc('b', [], { provider: 'codex' }), acc('z', [], { provider: 'claude' }), acc('a', [], { provider: 'claude' })].map((a) => roomRow(a, NOW));
    expect(sortRows(rows, 'agent', ['claude', 'codex']).map((r) => r.input.name)).toEqual(['a', 'z', 'b']);
  });

  it('separates the accounts at or near a cap and points at the one with the most room', () => {
    const v = overview([acc('capped', [win('w', 100, 2)]), acc('near', [win('w', 85, 1)]), acc('best', [win('w', 3, 4)]), acc('ok', [win('w', 50, 4)]), acc('out', undefined, { usable: false })], NOW, 'reset');
    expect(v.open.map((r) => r.input.name)).toEqual(['best', 'ok']);
    expect(v.tight.map((r) => r.input.name)).toEqual(['near', 'capped']);
    expect(v.off.map((r) => r.input.name)).toEqual(['out']);
    // The best account is by room, whatever order is shown.
    expect(v.best).toBe('best');
  });

  it('points at nothing when there is one account, or none with figures', () => {
    expect(overview([acc('only', [win('w', 3, 4)])], NOW, 'room').best).toBeUndefined();
    expect(overview([acc('a', undefined), acc('b', [win('w', 90, 1)])], NOW, 'room').best).toBeUndefined();
  });

  it('counts the accounts with room among those signed in', () => {
    expect(roomCount([acc('a', [win('w', 10, 1)]), acc('b', [win('w', 100, 1)]), acc('c', undefined), acc('d', undefined, { usable: false })], NOW)).toEqual({ free: 2, of: 3 });
  });
});
