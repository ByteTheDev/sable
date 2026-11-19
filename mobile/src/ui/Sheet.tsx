import { AnimatePresence, motion, useDragControls } from 'motion/react';
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { pushBack } from '@m/lib/back';

export const SPRING = { type: 'spring', stiffness: 460, damping: 40, mass: 0.9 } as const;

/**
 * A bottom sheet: frosted ink with grain over a dimmed screen, rising on a spring. Drag the grip
 * (or the header) down, tap outside or press back to close. `dismissable={false}` keeps it until
 * an answer (permission prompts close only by answering, or by "Later").
 */
export function Sheet({
  open,
  onClose,
  children,
  title,
  label,
  dismissable = true,
  tall,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: ReactNode;
  label?: string;
  dismissable?: boolean;
  tall?: boolean;
}) {
  const drag = useDragControls();
  useEffect(() => (open ? pushBack(() => (onClose(), true)) : undefined), [open, onClose]);
  // A sheet that rises takes the screen: the keyboard of the field under it goes down.
  useEffect(() => {
    if (open && document.activeElement instanceof HTMLElement && document.activeElement.closest('.sheet') === null) document.activeElement.blur();
  }, [open]);
  // On the body, above every screen and its header (a screen's own layers would trap it under them).
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="sheet-layer" role="presentation">
          <motion.div
            className="sheet-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={dismissable ? onClose : undefined}
          />
          <motion.div
            className="sheet glass"
            data-tall={tall || undefined}
            role="dialog"
            aria-modal="true"
            aria-label={label ?? (typeof title === 'string' ? title : undefined)}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%', transition: { type: 'spring', stiffness: 520, damping: 46 } }}
            transition={SPRING}
            drag={dismissable ? 'y' : false}
            dragListener={false}
            dragControls={drag}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.04, bottom: 0.9 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 110 || info.velocity.y > 600) onClose();
            }}
          >
            <div className="sheet-grip" onPointerDown={(e) => dismissable && drag.start(e)}>
              <span />
            </div>
            {title && (
              <div className="sheet-head" onPointerDown={(e) => dismissable && drag.start(e)}>
                <h2 className="sheet-title">{title}</h2>
              </div>
            )}
            <div className="sheet-body">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** One choice in a sheet's list: a 48 px row with a check on the current one. */
export function Choice({
  selected,
  onPick,
  children,
  icon,
  aside,
  mark,
}: {
  selected?: boolean;
  onPick: () => void;
  children: ReactNode;
  icon?: ReactNode;
  aside?: ReactNode;
  /** Answers to a question: a round mark (one answer) or a square one (several), filled when picked. */
  mark?: 'radio' | 'check';
}) {
  if (mark)
    return (
      <button type="button" className="choice choice-mark" data-selected={selected || undefined} onClick={onPick} role={mark === 'radio' ? 'radio' : 'checkbox'} aria-checked={!!selected}>
        <span className="pick" data-kind={mark} aria-hidden>
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="choice-label">{children}</span>
      </button>
    );
  return (
    <button type="button" className="choice" data-selected={selected || undefined} onClick={onPick} aria-pressed={selected}>
      {icon && <span className="choice-icon">{icon}</span>}
      <span className="choice-label">{children}</span>
      {aside && <span className="choice-aside">{aside}</span>}
      <span className="choice-check" aria-hidden>
        {selected && (
          <svg viewBox="0 0 16 16" width="16" height="16">
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
    </button>
  );
}
