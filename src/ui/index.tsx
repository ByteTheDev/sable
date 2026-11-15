import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Dialog as RD, DropdownMenu as RM, Popover as RP, Slider as RSl, Switch as RS, Tooltip as RT } from 'radix-ui';
import { motion } from 'motion/react';
import { Icon, type IconName } from '@/icons';
import { shortcutKeys } from '@/lib/format';
import { useStore } from '@/state/store';
import './grow';

/** React wrappers around the primitives in styles/ui.css. Keep this file small and boring. */

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

// ── keyboard hints ──

export function Kbd({ combo, className }: { combo: string; className?: string }) {
  return (
    <span className={cx('kbds', className)}>
      {shortcutKeys(combo).map((k, i) => (
        <kbd className="kbd" key={i}>
          {k}
        </kbd>
      ))}
    </span>
  );
}

// ── tooltip ──

export function TipProvider({ children }: { children: ReactNode }) {
  return (
    <RT.Provider delayDuration={380} skipDelayDuration={250}>
      {children}
    </RT.Provider>
  );
}

/**
 * Whether the focus that is happening now came from keyboard navigation. Focus that a closing
 * menu, popover or dialog hands back to its trigger (after Escape, Enter or a click) is not:
 * a tooltip must not pop up for it. Only Tab and arrow-key moves within the last second count.
 */
let navKeyAt = 0;
const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => (navKeyAt = NAV_KEYS.has(e.key) ? performance.now() : 0), true);
  window.addEventListener('pointerdown', () => (navKeyAt = 0), true);
}
export const focusFromKeyboard = () => navKeyAt > 0 && performance.now() - navKeyAt < 1000;

/** Radix skips its own open-on-focus when the handler before it prevents default. */
const gateTipFocus = (e: { preventDefault: () => void }) => {
  if (!focusFromKeyboard()) e.preventDefault();
};

export function Tip({ label, keys, side = 'bottom', children }: { label: ReactNode; keys?: string; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactNode }) {
  return (
    <RT.Root>
      <RT.Trigger asChild onFocus={gateTipFocus}>
        {children}
      </RT.Trigger>
      <RT.Portal>
        <RT.Content className="tooltip" side={side} sideOffset={7} collisionPadding={8}>
          {label}
          {keys && <Kbd combo={keys} />}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}

// ── buttons ──

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  keys?: string;
  size?: number;
  active?: boolean;
  tipSide?: 'top' | 'bottom' | 'left' | 'right';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, keys, size = 16, active, tipSide, className, ...rest },
  ref,
) {
  return (
    <Tip label={label} keys={keys} side={tipSide}>
      <button ref={ref} type="button" aria-label={label} data-active={active || undefined} className={cx('icon-btn', className)} {...rest}>
        <Icon name={icon} size={size} />
      </button>
    </Tip>
  );
});

// ── menus ──

export const Menu = RM.Root;
export const MenuTrigger = RM.Trigger;

export function MenuContent({
  children,
  align = 'start',
  side = 'bottom',
  className,
  width,
  sideOffset = 6,
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  width?: number;
  sideOffset?: number;
}) {
  return (
    <RM.Portal>
      <RM.Content className={cx('pop', className)} data-spot="" align={align} side={side} sideOffset={sideOffset} collisionPadding={10} style={width ? { width } : undefined}>
        {children}
      </RM.Content>
    </RM.Portal>
  );
}

export function MenuItem({
  icon,
  children,
  hint,
  keys,
  tone,
  checked,
  disabled,
  onSelect,
}: {
  icon?: IconName;
  children: ReactNode;
  hint?: ReactNode;
  keys?: string;
  tone?: 'danger';
  checked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  return (
    <RM.Item className="menu-item" data-tone={tone} disabled={disabled} onSelect={onSelect}>
      {icon && <Icon name={icon} size={16} />}
      <span className="grow truncate">{children}</span>
      {hint && <span className="hint">{hint}</span>}
      {keys && <Kbd combo={keys} />}
      {checked && <Icon name="check" size={14} />}
    </RM.Item>
  );
}

export const MenuLabel = ({ children }: { children: ReactNode }) => <RM.Label className="menu-label">{children}</RM.Label>;
export const MenuSep = () => <RM.Separator className="menu-sep" />;


// ── popover ──

export const Popover = RP.Root;
export const PopoverTrigger = RP.Trigger;
export const PopoverClose = RP.Close;

export function PopoverContent({
  children,
  align = 'start',
  side = 'bottom',
  className,
  width,
  sideOffset = 8,
  onOpenAutoFocus,
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  width?: number;
  sideOffset?: number;
  onOpenAutoFocus?: (e: Event) => void;
}) {
  return (
    <RP.Portal>
      <RP.Content className={cx('pop', className)} data-spot="" align={align} side={side} sideOffset={sideOffset} collisionPadding={10} style={width ? { width } : undefined} onOpenAutoFocus={onOpenAutoFocus}>
        {children}
      </RP.Content>
    </RP.Portal>
  );
}

// ── dialog ──

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width,
  className,
  bare,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  className?: string;
  /** Render children directly, without the standard head/body/foot frame. */
  bare?: boolean;
  /** Called when focus would return to the trigger on close; preventDefault() to move it elsewhere. */
  onCloseAutoFocus?: (e: Event) => void;
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="overlay" />
        <RD.Content
          className={cx('dialog', className)}
          data-spot=""
          style={width ? { width } : undefined}

          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={keepForInnerScope}
        >
          {bare ? (
            <>
              <RD.Title className="sr-only">{title}</RD.Title>
              {children}
            </>
          ) : (
            <>
              <div className="dialog-head">
                <RD.Title className="dialog-title">{title}</RD.Title>
                {description && <RD.Description className="dialog-desc">{description}</RD.Description>}
              </div>
              <div className="dialog-body scroll">{children}</div>
              {footer && <div className="dialog-foot">{footer}</div>}
            </>
          )}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/**
 * Escape closes the innermost thing first. Radix hears Escape on the document before any element
 * does, so an element that handles Escape itself (an inline confirm, a field that clears) marks
 * itself `data-escape-scope` and the dialog leaves that key press to it.
 */
function keepForInnerScope(e: KeyboardEvent) {
  const t = e.target;
  if (t instanceof Element && t.closest('[data-escape-scope]')) e.preventDefault();
}

// ── switch ──

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <RS.Root className="switch" checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled}>
      <RS.Thumb className="switch-thumb" />
    </RS.Root>
  );
}

// ── slider ──

/**
 * A thin track with an ivory fill and a small solid thumb. Arrow keys step, Page Up/Down step
 * by ten, Home/End go to the ends. `onCommit` fires when a drag or key press ends.
 */
export function Slider({
  value,
  onChange,
  onCommit,
  min = 0,
  max = 100,
  step = 1,
  label,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Accessible name (the visible label usually says the same). */
  label: string;
  className?: string;
}) {
  return (
    <RSl.Root
      className={cx('slider', className)}
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange(v[0])}
      onValueCommit={onCommit ? (v) => onCommit(v[0]) : undefined}
    >
      <RSl.Track className="slider-track">
        <RSl.Range className="slider-range" />
      </RSl.Track>
      <RSl.Thumb className="slider-thumb" aria-label={label} />
    </RSl.Root>
  );
}

// ── segmented control ──

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  id,
  className,
}: {
  /** null selects nothing. */
  value: T | null;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; icon?: IconName }[];
  /** Unique id so the sliding pill animates within this control only. */
  id: string;
  className?: string;
}) {
  return (
    <div className={cx('seg', className)} role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} data-active={o.value === value} className="seg-item" onClick={() => onChange(o.value)}>
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="seg-pill" transition={{ type: 'spring', stiffness: 520, damping: 38 }} />}
          {o.icon && <Icon name={o.icon} size={14} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── toasts ──

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  // On body, above any dialog: `.app` isolates its own stacking context. Pointer events are kept
  // from reaching an open dialog's outside-click handler, so dismissing a toast leaves the dialog open.
  return createPortal(
    <div className="toasts" aria-live="polite" onPointerDown={(e) => e.nativeEvent.stopPropagation()}>
      {toasts.map((t) => (
        <motion.button
          key={t.id}
          layout
          initial={{ opacity: 0, y: 14, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          className="toast"
          data-level={t.level}
          onClick={() => dismiss(t.id)}
        >
          <Icon name={t.level === 'error' ? 'error' : t.level === 'success' ? 'check-circle' : 'info'} size={16} />
          <span>{t.text}</span>
        </motion.button>
      ))}
    </div>,
    document.body,
  );
}

// ── paths ──

/**
 * A path, folder or file shown as a label: the UI font, the directory dim and the name regular.
 * The directory gives way first (its start is elided), the name stays whole. Pass a path that is
 * already shortened for display (relPath / tildePath). Never monospace: that is for code only.
 */
export function PathLabel({ path, className, title }: { path: string; className?: string; title?: string }) {
  const norm = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  const dir = i >= 0 ? norm.slice(0, i + 1) : '';
  const name = i >= 0 ? norm.slice(i + 1) : norm;
  return (
    <span className={cx('path', className)} title={title ?? path}>
      {dir && <span className="path-dir">{dir}</span>}
      <span className="path-name">{name || norm}</span>
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {

  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}
