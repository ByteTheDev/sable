import { cloneElement, useState, type ReactElement, type ReactNode } from 'react';
import { focusFromKeyboard, Tip } from '@/ui';

interface HoverProps {
  onPointerEnter?: (e: React.PointerEvent) => void;
  onFocus?: (e: React.FocusEvent) => void;
  autoFocus?: boolean;
}

/**
 * A tooltip that costs nothing until it is needed. A transcript holds hundreds of
 * small buttons; mounting a tooltip for each up front is most of their weight. The
 * real one is created the first time the pointer or focus reaches the control.
 */
export function LazyTip({ label, keys, side, children }: { label: ReactNode; keys?: string; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactElement<HoverProps> }) {
  const [armed, setArmed] = useState<false | 'pointer' | 'focus'>(false);
  if (!armed) {
    return cloneElement(children, {
      onPointerEnter: (e: React.PointerEvent) => {
        children.props.onPointerEnter?.(e);
        setArmed('pointer');
      },
      onFocus: (e: React.FocusEvent) => {
        children.props.onFocus?.(e);
        if (focusFromKeyboard()) setArmed('focus');
      },
    });
  }
  return (
    <Tip label={label} keys={keys} side={side}>
      {/* Wrapping remounts the control; hand focus back if that is what woke the tooltip. */}
      {armed === 'focus' ? cloneElement(children, { autoFocus: true }) : children}
    </Tip>
  );
}
