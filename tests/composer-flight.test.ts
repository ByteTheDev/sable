import { describe, expect, it } from 'vitest';
import { ACKED_MS, bubbleHold, columnEdges, firstLanding, HOLD_MS, landingCertain, RELEASE, springPath, waitStart } from '../src/features/composer/flight';
import { afterSend, holdSend, sendInAir } from '../src/features/composer/settle';

describe('send flight landing', () => {
  it('centres the reading column in a wide conversation', () => {
    // A 1490 px conversation with a 760 px column: the card's right edge is the column's, not the stage's.
    const c = columnEdges(0, 1490, 760);
    expect(c.right).toBe(1125);
    expect(c.left).toBe(365);
    expect(c.width).toBe(760);
  });

  it('keeps the minimum side padding in a narrow conversation', () => {
    const c = columnEdges(100, 600, 760);
    expect(c.left).toBe(124);
    expect(c.right).toBe(676);
    expect(c.width).toBe(552);
  });

  const col = { left: 365, right: 1125 };
  const view = { top: 0, bottom: 800 };
  const box = (left: number, top: number, width = 120, height = 22) => ({ left, top, width, height, right: left + width, bottom: top + height });

  it('flies to a row inside the column and near the view', () => {
    expect(landingCertain(box(1000, 600), col, view)).toBe(true);
    // Still rising from behind the composer while the view follows it.
    expect(landingCertain(box(1000, 1100), col, view)).toBe(true);
  });

  it('does not fly to a row outside the column', () => {
    // The stray: a landing at the stage's right edge, outside the column.
    expect(landingCertain(box(1322, 600), col, view)).toBe(false);
  });

  it('does not fly to a row far off screen or not laid out', () => {
    expect(landingCertain(box(1000, 4000), col, view)).toBe(false);
    expect(landingCertain(box(1000, -900), col, view)).toBe(false);
    expect(landingCertain(box(0, 0, 0, 0), col, view)).toBe(false);
  });
});

describe('send flight path', () => {
  const start = { t: 0, x: 0, y: 0, vx: 0, vy: 0 };

  it('lands exactly on the landing and is there within 450 ms', () => {
    // From the home field to the top of the column at 1536 x 912, and a short hop above the dock.
    for (const [gx, gy, sideways] of [[515, -307, true], [496, -514, false], [240, -96, false]] as const) {
      const path = springPath(start, gx, gy, { release: RELEASE, sideways });
      const end = path[path.length - 1];
      expect(end.x).toBe(gx);
      expect(end.y).toBe(gy);
      expect(end.vx).toBe(0);
      expect(end.vy).toBe(0);
      expect(end.t).toBeLessThanOrEqual(450);
      // Within two pixels long before it rests: the eye reads it as landed by 350 ms.
      const near = path.find((p) => Math.hypot(gx - p.x, gy - p.y) < 2);
      expect(near!.t).toBeLessThanOrEqual(350);
    }
  });

  it('settles with a small overshoot at most, and never wanders', () => {
    const gx = 515;
    const gy = -307;
    const path = springPath(start, gx, gy, { release: RELEASE, sideways: true });
    for (const p of path) {
      expect(p.x).toBeLessThanOrEqual(gx * 1.03);
      expect(p.y).toBeGreaterThanOrEqual(gy * 1.03);
      expect(p.y).toBeLessThanOrEqual(3);
    }
    // Time only moves forward, in steps the compositor can interpolate.
    for (let i = 1; i < path.length; i++) expect(path[i].t).toBeGreaterThan(path[i - 1].t);
  });

  it('gathers until the release, then leaves', () => {
    const path = springPath(start, 400, -400, { release: RELEASE });
    const before = path.filter((p) => p.t <= RELEASE);
    for (const p of before) expect(Math.abs(p.x) + Math.abs(p.y)).toBeLessThan(3);
    const soon = path.find((p) => p.t >= RELEASE + 100)!;
    expect(soon.y).toBeLessThan(-120);
  });

  it('goes on from where it is when re-aimed, at its speed', () => {
    const first = springPath(start, 300, -300, { release: RELEASE });
    const mid = first[Math.floor(first.length / 3)];
    const path = springPath(mid, 320, -280, { release: RELEASE });
    expect(path[0]).toEqual(mid);
    const end = path[path.length - 1];
    expect([end.x, end.y]).toEqual([320, -280]);
  });
});

describe('first message landing', () => {
  it('sits on the column\'s right edge under the top padding', () => {
    // The stage at 1536 x 912 with the sidebar open: the card measured there is at 1061, 109 (225 wide).
    expect(firstLanding({ left: 285, top: 53, width: 1242 }, 760, { width: 225 })).toEqual({ left: 1061, top: 109 });
  });
});

describe('a late row: the bubble holds until it is there', () => {
  const at = (o: Partial<Parameters<typeof bubbleHold>[0]>) => bubbleHold({ row: false, answer: 'pending', sinceLaunch: 0, sinceAnswer: 0, ...o });

  it('holds without its row while the bridge has not answered, long past the old 4 s fade', () => {
    expect(at({ sinceLaunch: 400 })).toBe('hold');
    expect(at({ sinceLaunch: 4000 })).toBe('hold');
    expect(at({ sinceLaunch: HOLD_MS - 1 })).toBe('hold');
  });

  it('lands as soon as its row is there, however late', () => {
    expect(at({ row: true, sinceLaunch: 9000 })).toBe('land');
    expect(at({ row: true, answer: 'taken', sinceLaunch: 14000, sinceAnswer: 2900 })).toBe('land');
  });

  it('flies back into the field when the bridge refuses the message', () => {
    expect(at({ answer: 'refused', sinceLaunch: 300 })).toBe('back');
  });

  it('keeps holding a while after the bridge took the message, then lets go', () => {
    expect(at({ answer: 'taken', sinceLaunch: 2000, sinceAnswer: ACKED_MS - 1 })).toBe('hold');
    expect(at({ answer: 'taken', sinceLaunch: 5000, sinceAnswer: ACKED_MS })).toBe('release');
  });

  it('lets go after the safety limit when no answer ever comes', () => {
    expect(at({ sinceLaunch: HOLD_MS })).toBe('release');
  });

  it('shows the waiting state only once the path has been flown, never in a normal landing', () => {
    // A ~350 ms path: waiting from about 470 ms, after a row that mounts in time has taken it.
    expect(waitStart(350)).toBe(470);
    // A short lift (no landing guessed): still not before the usual landing time.
    expect(waitStart(100)).toBeGreaterThanOrEqual(380);
  });
});

describe('chrome waits for a send to land', () => {
  it('runs at once when nothing is in the air', () => {
    let ran = 0;
    afterSend(() => ran++);
    expect(ran).toBe(1);
    expect(sendInAir()).toBe(false);
  });

  it('waits for every flight in the air, then runs once', () => {
    const bubble = holdSend();
    const ghost = holdSend();
    let ran = 0;
    afterSend(() => ran++);
    expect(sendInAir()).toBe(true);
    bubble();
    expect(ran).toBe(0);
    // Landing twice counts once.
    bubble();
    expect(ran).toBe(0);
    ghost();
    expect(ran).toBe(1);
    expect(sendInAir()).toBe(false);
  });

  it('can be cancelled while waiting', () => {
    const done = holdSend();
    let ran = 0;
    const cancel = afterSend(() => ran++);
    cancel();
    done();
    expect(ran).toBe(0);
  });
});
