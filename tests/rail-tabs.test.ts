import { describe, expect, it } from 'vitest';
import { RAIL_TABS, railTabAt, railTabKeys } from '@/features/rail/tabs';

describe('side panel tabs', () => {
  it('lists every tab once, Device included', () => {
    const ids = RAIL_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['changes', 'files', 'browser', 'terminal', 'tasks', 'context', 'agents', 'device']);
  });

  it('keeps the old shortcuts and gives Device Alt+8', () => {
    expect(railTabAt(1)).toBe('changes');
    expect(railTabAt(4)).toBe('terminal');
    expect(railTabAt(7)).toBe('agents');
    expect(railTabAt(8)).toBe('device');
    expect(railTabAt(9)).toBeUndefined();
    expect(railTabKeys('device')).toBe('alt+8');
    expect(railTabKeys('browser')).toBe('alt+3');
  });

  it('shows the four most used in the header and the rest under More', () => {
    expect(RAIL_TABS.filter((t) => !t.more).map((t) => t.id)).toEqual(['changes', 'files', 'browser', 'terminal']);
  });
});
