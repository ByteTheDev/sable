import { Icon } from '@/icons';
import { useCopy } from '@/lib/view-hooks';
import { LazyTip } from './LazyTip';

/** A quiet icon button that copies text and confirms with a check. */
export function CopyButton({ text, label = 'Copy', size = 14, className, tipSide = 'top' }: { text: string | (() => string); label?: string; size?: number; className?: string; tipSide?: 'top' | 'bottom' | 'left' | 'right' }) {
  const [copied, copy] = useCopy();
  return (
    <LazyTip label={copied ? 'Copied' : label} side={tipSide}>
      <button
        type="button"
        className={`icon-btn copy-btn ${className ?? ''}`}
        aria-label={label}
        data-copied={copied || undefined}
        onClick={(e) => {
          e.stopPropagation();
          copy(typeof text === 'function' ? text() : text);
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={size} />
      </button>
    </LazyTip>
  );
}
