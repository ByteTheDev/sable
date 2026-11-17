/** The effort track's snapping and state, and the rules for a speed billed outside the plan. */
import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@shared/protocol';
import { headerLevel, step, stopAt, type TrackState } from '../src/features/composer/effort-track';
import { defaultableSpeeds, offeredSpeeds, startSpeedFor, toggledSpeed } from '../shared/speed';

describe('effort snapping', () => {
  it('picks the column under the pointer and clamps outside the row', () => {
    // Six columns over 240px: 40px each.
    expect(stopAt(0, 0, 240, 6)).toBe(0);
    expect(stopAt(39.9, 0, 240, 6)).toBe(0);
    expect(stopAt(40, 0, 240, 6)).toBe(1);
    expect(stopAt(239, 0, 240, 6)).toBe(5);
    expect(stopAt(-50, 0, 240, 6)).toBe(0);
    expect(stopAt(900, 0, 240, 6)).toBe(5);
    expect(stopAt(150, 100, 240, 6)).toBe(1);
    expect(stopAt(10, 0, 0, 6)).toBe(0);
    expect(stopAt(10, 0, 240, 1)).toBe(0);
  });
});

describe('effort track state', () => {
  const n = 6;
  const rest: TrackState = { level: 2, hover: null, dragging: false };
  const run = (s: TrackState, events: Parameters<typeof step>[1][]) => {
    const commits: number[] = [];
    for (const e of events) {
      const out = step(s, e, n);
      s = out.state;
      if (out.commit !== undefined) commits.push(out.commit);
    }
    return { s, commits };
  };

  it('a hover previews a name and clears on leave', () => {
    const { s } = run(rest, [{ type: 'hover', at: 4 }]);
    expect(headerLevel(s)).toBe(4);
    expect(s.level).toBe(2);
    expect(headerLevel(run(s, [{ type: 'leave' }]).s)).toBe(2);
  });

  it('a press clears the preview, so the header names the level the drag stands on', () => {
    const { s } = run(rest, [{ type: 'hover', at: 1 }, { type: 'down', at: 3 }, { type: 'move', at: 5 }]);
    expect(s.dragging).toBe(true);
    expect(s.hover).toBeNull();
    expect(headerLevel(s)).toBe(5);
    expect(s.level).toBe(5);
  });

  it('a drag commits once, on release, the stop it ends on', () => {
    const { s, commits } = run(rest, [{ type: 'down', at: 1 }, { type: 'move', at: 2 }, { type: 'move', at: 4 }, { type: 'move', at: 3 }, { type: 'up' }]);
    expect(commits).toEqual([3]);
    expect(s).toEqual({ level: 3, hover: null, dragging: false });
  });

  it('a click is a press and release on one stop', () => {
    expect(run(rest, [{ type: 'down', at: 0 }, { type: 'up' }]).commits).toEqual([0]);
  });

  it('a hover never moves the level, and a stray release commits nothing', () => {
    const { s, commits } = run(rest, [{ type: 'move', at: 5 }, { type: 'up' }]);
    expect(commits).toEqual([]);
    expect(s.level).toBe(2);
  });

  it('keys step, jump and commit; out of range does nothing', () => {
    expect(run(rest, [{ type: 'key', key: 'ArrowRight' }]).commits).toEqual([3]);
    expect(run(rest, [{ type: 'key', key: 'ArrowDown' }]).commits).toEqual([1]);
    expect(run(rest, [{ type: 'key', key: 'Home' }]).commits).toEqual([0]);
    expect(run(rest, [{ type: 'key', key: 'End' }]).commits).toEqual([5]);
    expect(run(rest, [{ type: 'key', key: '5' }]).commits).toEqual([4]);
    expect(run(rest, [{ type: 'key', key: '9' }]).commits).toEqual([]);
    expect(run({ ...rest, level: 5 }, [{ type: 'key', key: 'ArrowRight' }]).commits).toEqual([]);
    expect(run(rest, [{ type: 'key', key: '3' }]).commits).toEqual([]);
    expect(step(rest, { type: 'key', key: 'Enter' }, n).done).toBe(true);
  });

  it('a key clears a hover preview', () => {
    const { s } = run(rest, [{ type: 'hover', at: 5 }, { type: 'key', key: 'ArrowLeft' }]);
    expect(headerLevel(s)).toBe(1);
  });

  it('follows the confirmed value, but never mid-drag', () => {
    expect(run(rest, [{ type: 'sync', level: 4 }]).s.level).toBe(4);
    expect(run(rest, [{ type: 'down', at: 1 }, { type: 'sync', level: 4 }]).s.level).toBe(1);
  });
});

describe('a speed billed outside the plan', () => {
  const model: ModelInfo = {
    id: 'm',
    name: 'M',
    speeds: [
      { id: 'priority', name: 'Fast' },
      { id: 'fast', name: 'Fast', note: 'Extra usage', paid: true },
    ],
  };
  const claude: ModelInfo = { id: 'opus', name: 'Opus', speeds: [{ id: 'fast', name: 'Fast', paid: true }] };

  it('is offered only with extra usage on', () => {
    expect(offeredSpeeds(model, false).map((s) => s.id)).toEqual(['priority']);
    expect(offeredSpeeds(model, undefined).map((s) => s.id)).toEqual(['priority']);
    expect(offeredSpeeds(model, true).map((s) => s.id)).toEqual(['priority', 'fast']);
  });

  it('is never a default, and a saved one starts a session at standard', () => {
    expect(defaultableSpeeds(model).map((s) => s.id)).toEqual(['priority']);
    expect(startSpeedFor(claude, 'fast')).toBe('standard');
    expect(startSpeedFor(model, 'priority')).toBe('priority');
  });

  it('/fast toggles only what is offered', () => {
    expect(toggledSpeed(claude, 'standard', offeredSpeeds(claude, false))).toBe('standard');
    expect(toggledSpeed(claude, 'standard', offeredSpeeds(claude, true))).toBe('fast');
    expect(toggledSpeed(claude, 'fast', offeredSpeeds(claude, true))).toBe('standard');
  });
});
