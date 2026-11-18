import { Component, type ReactNode } from 'react';
import { play, reducedMotion, spring, uiZoom } from '@/lib/motion';

/**
 * Children that keep their place visually when their order changes: rows moving up when a
 * session becomes active, folders reordering, the gap closing after a row leaves. A class only
 * for getSnapshotBeforeUpdate: positions are read right before React moves the DOM (when layout
 * is clean, so the read is free), and only when `order` changed. Each child that moved then
 * slides from where it was drawn to where it is laid out (transform only, Web Animations).
 *
 * Children are found by `[data-flip]` (their key) directly inside the wrapper element.
 */
interface Props {
  order: string;
  className?: string;
  role?: string;
  /** Runs after the DOM took the new order, before the new places are measured (a drag drops its transforms here). */
  beforeMeasure?: () => void;
  children: ReactNode;
}

type Snap = { tops: Map<string, number>; shrunk: boolean } | null;

/** Ids in an order string (any run of spaces, colons or line breaks separates them). */
const count = (order: string) => order.split(/[\s:]+/).filter(Boolean).length;

const MOVE = spring(440, 40);

export class Flip extends Component<Props> {
  private el: HTMLDivElement | null = null;
  private ref = (el: HTMLDivElement | null) => {
    this.el = el;
  };

  private items(): HTMLElement[] {
    return this.el ? [...this.el.querySelectorAll<HTMLElement>(':scope > [data-flip]')] : [];
  }

  getSnapshotBeforeUpdate(prev: Props): Snap {
    if (prev.order === this.props.order || !this.el || reducedMotion()) return null;
    const tops = new Map<string, number>();
    for (const item of this.items()) tops.set(item.dataset.flip!, item.getBoundingClientRect().top);
    return { tops, shrunk: count(this.props.order) < count(prev.order) };
  }

  componentDidUpdate(_prev: Props, _state: unknown, snap: Snap) {
    this.props.beforeMeasure?.();
    if (!snap?.tops.size) return;
    const z = uiZoom();
    const moves: [HTMLElement, number][] = [];
    for (const item of this.items()) {
      const was = snap.tops.get(item.dataset.flip!);
      if (was === undefined) continue;
      // Measured without a move still running, so the slide starts from where it is drawn now.
      for (const a of item.getAnimations()) if ((a as Animation & { id: string }).id === 'flip') a.cancel();
      moves.push([item, was]);
    }
    // All reads, then all writes: one layout for the whole list.
    const rects = moves.map(([item]) => item.getBoundingClientRect());
    // Something left: the others wait a beat, so its dissolve is seen before the gap closes.
    const delay = snap.shrunk ? 90 : 0;
    moves.forEach(([item, was], i) => {
      const dy = (was - rects[i].top) / z;
      if (Math.abs(dy) < 0.5) return;
      // A long jump (a row to the top of its folder, a folder to the top of the list) would slide
      // its text across its neighbours': it arrives in place instead, a short drop and a fade.
      // A folder just dropped by hand always slides home from where it was let go.
      const far = !item.hasAttribute('data-dropped') && Math.abs(dy) > Math.min((rects[i].height / z) * 1.6, 60);
      const a = far
        ? play(item, [{ opacity: 0, transform: `translateY(${Math.sign(dy) * 6}px)` }, { opacity: 1, transform: 'translateY(0)' }], { duration: MOVE.duration, easing: MOVE.easing, delay: 40, fill: 'backwards' })
        : play(item, [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: MOVE.duration, easing: MOVE.easing, delay, fill: 'backwards' });
      if (a) a.id = 'flip';
    });
  }

  render() {
    return (
      <div ref={this.ref} className={this.props.className} role={this.props.role}>
        {this.props.children}
      </div>
    );
  }
}
