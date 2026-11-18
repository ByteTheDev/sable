/** What each window line of the limits says, wherever it is shown (Usage page, switcher, side panel). */
import { describe, expect, it } from 'vitest';
import type { LimitPace, RateLimit } from '@shared/protocol';
import { duration, orderWindows, windowLevel, windowNote } from '../src/features/usage/format';

const NOW = new Date(2026, 10, 18, 12, 0).getTime();
const H = 3_600_000;
const win = (id: string, percent: number, resetsIn?: number, windowMins = 300, label = id): RateLimit => ({ id, label, percent, resetsAt: resetsIn === undefined ? undefined : NOW + resetsIn * H, windowMins });
const pace = (p: Partial<LimitPace>): LimitPace => ({ perHour: 2, ...p }) as LimitPace;

describe('window lines', () => {
  it('order the 5-hour window first, then the whole week, then each model week', () => {
    const rows = [win('model_Fable', 96, 80, 10_080), win('seven_day', 56, 80, 10_080), win('five_hour', 10, 2)];
    expect(orderWindows(rows).map((l) => l.id)).toEqual(['five_hour', 'seven_day', 'model_Fable']);
  });

  it('say where the pace leads, with a mark only when it runs out first', () => {
    expect(windowNote(win('w', 40, 3), pace({ fullAt: NOW + 2 * H }), NOW)).toMatchObject({ warn: true });
    expect(windowNote(win('w', 40, 3), pace({ fullAt: NOW + 2 * H }), NOW)?.text).toMatch(/^On pace to run out at /);
    expect(windowNote(win('w', 40, 3), pace({ atReset: 66 }), NOW)).toEqual({ text: 'On pace for 66% at the reset', warn: false });
    expect(windowNote(win('w', 40, 3), pace({ perHour: 0 }), NOW)).toEqual({ text: 'Steady until the reset', warn: false });
  });

  it('say nothing of the pace at a cap, and name a reset that has passed', () => {
    expect(windowNote(win('w', 100, 1), pace({ fullAt: NOW }), NOW)).toBeUndefined();
    expect(windowNote(win('w', 70, -1), pace({ atReset: 90 }), NOW)?.text).toMatch(/^Reset at /);
    expect(windowLevel(win('w', 100, -1), NOW)).toBeUndefined();
  });

  it('say a window without a reset and nothing used starts with the next message', () => {
    expect(windowNote(win('w', 0), undefined, NOW)?.text).toBe('Starts with your next message');
    expect(windowNote(win('w', 12), undefined, NOW)).toBeUndefined();
  });

  it('use the tokens levels: amber from 80%, red at the cap', () => {
    expect(windowLevel(win('w', 79, 1), NOW)).toBeUndefined();
    expect(windowLevel(win('w', 80, 1), NOW)).toBe('amber');
    expect(windowLevel(win('w', 100, 1), NOW)).toBe('red');
  });

  it('fit the reset column', () => {
    expect(duration(20_000)).toBe('<1m');
    expect(duration(38 * 60_000)).toBe('38m');
    expect(duration(82 * 60_000)).toBe('1h 22m');
    expect(duration((4 * 24 + 16) * H)).toBe('4d 16h');
  });
});
