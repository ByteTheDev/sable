import type { ReactElement, ReactNode } from 'react';
import { Tip } from '@/ui';

/**
 * A tooltip that costs nothing until it is needed. `Tip` itself now mounts its Radix parts only
 * when the pointer or keyboard focus first reaches the control (and never remounts the control),
 * so this is the same thing under its older name.
 */
export function LazyTip({ label, keys, side, children }: { label: ReactNode; keys?: string; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactElement }) {
  return (
    <Tip label={label} keys={keys} side={side}>
      {children}
    </Tip>
  );
}
