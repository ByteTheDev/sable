import { useLayoutEffect, useRef, useState } from 'react';
import { TAKE_BACKS, blurTo, cleanName, editStep, focusAfterMenu, movesFocus, pressAt, type EditStep } from './rename';

interface Props {
  value: string;
  placeholder?: string;
  label: string;
  className: string;
  /**
   * The edit is over: `name` is the cleaned text to keep (undefined after Escape). `back`: it ended
   * from the keyboard, so focus goes back to the row (after a press, the press decides where it is).
   */
  onDone: (name: string | undefined, back: boolean) => void;
}

/** How long after a key that moves focus (Tab, a shortcut) a focus move counts as the person's. */
const KEY_WINDOW = 800;

/**
 * A name edited in place (a folder, a project, a chat). It takes focus, its words selected, before
 * the frame it first shows in (a layout effect: the name becomes a live field in one step), and
 * keeps it until the edit is meant to end (rename.ts): its own listeners, not React's blur, since a
 * row the list moves while it is edited loses focus inside React's commit.
 */
export function NameField({ value, placeholder, label, className, onDone }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value);
  const textRef = useRef(text);
  textRef.current = text;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const ended = useRef(false);
  const run = useRef<(step: EditStep, e?: Event) => void>(() => {});

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    ended.current = false;
    let raf = 0;
    let keyAt = -Infinity;
    let takeBacks = 0;
    // What took focus away, to be taken back from (and only from it).
    let thief: Element | null = null;
    run.current = (step, e) => {
      if (ended.current) return;
      if (step.end) {
        ended.current = true;
        doneRef.current(step.save ? cleanName(textRef.current) : undefined, step.back);
        return;
      }
      if (step.hold === 'press' && e instanceof PointerEvent) {
        // Beside the text on its own row: the caret goes to the near end, focus stays.
        e.preventDefault();
        const end = e.clientX < el.getBoundingClientRect().left ? 0 : el.value.length;
        el.setSelectionRange(end, end);
        if (document.activeElement !== el) el.focus({ preventScroll: true });
      } else if (step.hold === 'focus') {
        // Back to the field next frame, unless something else has taken focus meanwhile (a frame, a dialog).
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const at = document.activeElement;
          const free = !at || at === document.body || at === thief || !!at.closest('.pop[data-state="closed"]');
          if (!ended.current && el.isConnected && document.hasFocus() && free) el.focus({ preventScroll: true });
          thief = null;
        });
      }
    };
    const onPress = (e: PointerEvent) => run.current(editStep({ type: 'press', at: pressAt(e.target, el), primary: e.button === 0 }), e);
    // A key that moves focus counts while it is down (Tab's move can come late in a long list) and a moment after.
    let keyDown = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.type === 'keydown' ? !movesFocus(e) : !keyDown) return;
      keyDown = e.type === 'keydown';
      keyAt = performance.now();
    };
    const onOut = (e: FocusEvent) => {
      let to = blurTo(e.relatedTarget, keyDown || performance.now() - keyAt < KEY_WINDOW);
      if (to === 'taken') {
        // The app moved focus on its own: taken back a few times, then let go (never a fight).
        if (++takeBacks > TAKE_BACKS) to = 'control';
        else thief = e.relatedTarget as Element;
      }
      run.current(editStep({ type: 'blur', to }));
    };
    document.addEventListener('pointerdown', onPress, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKey, true);
    el.addEventListener('focusout', onOut);
    const cancelFocus = focusAfterMenu(
      () => {
        el.focus({ preventScroll: true });
        el.select();
      },
      // The menu it came from has closed: focus back here if anything took it, what was typed untouched.
      () => {
        if (!ended.current && el.isConnected && document.activeElement !== el) el.focus({ preventScroll: true });
      },
    );
    return () => {
      cancelFocus();
      cancelAnimationFrame(raf);
      document.removeEventListener('pointerdown', onPress, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKey, true);
      el.removeEventListener('focusout', onOut);
    };
  }, []);

  return (
    <input
      ref={ref}
      className={className}
      value={text}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      // The row's menu and a folder's drag stay out of the way: the field keeps the native menu (paste).
      onContextMenu={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        const step = editStep({ type: 'key', key: e.key });
        if (!step.end) return;
        e.preventDefault();
        run.current(step);
      }}
    />
  );
}
