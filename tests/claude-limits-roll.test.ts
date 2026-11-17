import { describe, expect, it } from 'vitest';
import { rolledOver } from '../server/providers/claude';

describe('Claude limit windows', () => {
  it('keeps a window whose reset passed, empty and waiting for the next message', () => {
    const l = { id: 'five_hour', label: '5-hour limit', percent: 64, resetsAt: 1_000, windowMins: 300 };
    expect(rolledOver(l, 2_000)).toEqual({ ...l, percent: 0, resetsAt: undefined });
  });

  it('leaves a live window as it is', () => {
    const l = { id: 'seven_day', label: 'Weekly · all models', percent: 12, resetsAt: 5_000, windowMins: 10_080 };
    expect(rolledOver(l, 2_000)).toBe(l);
  });
});
