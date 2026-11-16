import { describe, expect, it } from 'vitest';
import { LAUNCH, LAUNCH_FORMED, LAUNCH_MARK_CELLS, LaunchPiece, launchGeometry } from '../src/art/launch-light';

const INK = 0xff080707;
const IVORY = 0xffeef1f2;
const DIM = 0xff5a5b5b;

function piece() {
  const g = launchGeometry(1280, 800, 6);
  const p = new LaunchPiece({ ink: INK, ivory: IVORY, dim: DIM });
  p.resize(g);
  const px = new Uint32Array(g.cols * g.rows);
  const count = (v: number) => px.reduce((n, c) => n + (c === v ? 1 : 0), 0);
  /** The colour at a cell of the mark, given in mark cells (0..31). */
  const at = (mx: number, my: number) => px[(g.my + my) * g.cols + g.mx + mx];
  return { g, p, px, count, at };
}

describe('the launch piece', () => {
  it('sits on whole cells, the mark a little above the middle', () => {
    const g = launchGeometry(1280, 800, 6);
    expect(g.cols).toBe(214);
    expect(g.rows).toBe(134);
    expect(g.mx + LAUNCH_MARK_CELLS / 2).toBe(107);
    expect(g.my + LAUNCH_MARK_CELLS / 2).toBeLessThan(g.rows / 2);
  });

  it('begins as ink with one cell lit', () => {
    const { p, px, count } = piece();
    p.draw(0, px);
    expect(count(IVORY)).toBe(1);
    expect(count(INK)).toBe(px.length - 1);
    expect(count(0)).toBe(0);
  });

  it('leaves the mark standing whole, its corner dissolved, and never opens before the release', () => {
    const { p, px, count, at } = piece();
    for (let t = 0; t <= LAUNCH_FORMED + 3000; t += 50) {
      p.draw(t, px);
      expect(count(0)).toBe(0);
    }
    expect(p.whole).toBe(true);
    // Solid places, the two dropped cells, and the corner that holds on.
    expect(at(4, 4)).toBe(IVORY);
    expect(at(12, 28)).toBe(IVORY);
    expect(at(28, 28)).toBe(IVORY);
    expect(at(28, 20)).not.toBe(IVORY);
    expect(at(20, 28)).not.toBe(IVORY);
    // Every cell of a solid place is lit, not a scatter.
    let solid = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (at(x, y) === IVORY) solid++;
    expect(solid).toBe(64);
  });

  it('opens the whole window after the release and is then done', () => {
    const { p, px, count } = piece();
    p.draw(LAUNCH_FORMED, px);
    p.release(LAUNCH_FORMED + 20);
    // The light gathers first: nothing opens during the inhale.
    p.draw(LAUNCH_FORMED + 20 + LAUNCH.inhale - 10, px);
    expect(count(0)).toBe(0);
    let last = 0;
    for (let t = LAUNCH.inhale; t < LAUNCH.inhale + LAUNCH.burst; t += 40) {
      p.draw(LAUNCH_FORMED + 20 + t, px);
      const open = count(0);
      expect(open).toBeGreaterThanOrEqual(last);
      last = open;
    }
    expect(p.done).toBe(false);
    p.draw(LAUNCH_FORMED + 20 + LAUNCH.inhale + LAUNCH.burst, px);
    expect(p.done).toBe(true);
    expect(count(0)).toBe(px.length);
  });

  it('yields at any moment: everything opens within the finish time', () => {
    const { p, px, count } = piece();
    p.draw(300, px);
    p.finish(300);
    p.draw(300 + LAUNCH.finish / 2, px);
    expect(count(0)).toBeGreaterThan(px.length * 0.3);
    expect(p.done).toBe(false);
    p.draw(300 + LAUNCH.finish, px);
    expect(p.done).toBe(true);
    expect(count(0)).toBe(px.length);
  });
});
