import { memo, useSyncExternalStore } from 'react';
import { Tip } from '@/ui';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export type SendGlyph = 'send' | 'steer';

// ── the modifier key (one set of listeners for the app) ──

let held = false;
const subs = new Set<() => void>();
const setHeld = (v: boolean) => {
  if (held === v) return;
  held = v;
  subs.forEach((f) => f());
};
let listening = false;
function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  const key = MAC ? 'Meta' : 'Control';
  window.addEventListener('keydown', (e) => setHeld(e.key === key || (MAC ? e.metaKey : e.ctrlKey)), true);
  window.addEventListener('keyup', (e) => e.key === key && setHeld(false), true);
  window.addEventListener('blur', () => setHeld(false));
}
const subscribe = (f: () => void) => {
  listen();
  subs.add(f);
  return () => subs.delete(f);
};

/** True while the platform's modifier (Ctrl, or Cmd on a Mac) is held and `on`. Lets go when the window loses focus. */
export function useModHeld(on: boolean): boolean {
  const v = useSyncExternalStore(subscribe, () => held, () => false);
  return on && v;
}

/**
 * The send key's glyph: one arrow.
 * - send: straight up. While a turn runs Enter queues and the key keeps this arrow: the message
 *   still goes up, only after the turn (the tooltip says so).
 * - steer (the modifier held while a turn runs): the arrow leans into the turn, up and to the right.
 * Ultra and ultracode are shown by the effort chip, never by the key.
 */
export function SendGlyphSvg({ glyph }: { glyph: SendGlyph }) {
  return (
    <svg className="sk-glyph" data-glyph={glyph} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <g className="sk-arrow">
        <path className="sk-shaft" d="M8 12.75V3.75" />
        <path className="sk-head" d="M4.25 7.5 8 3.75l3.75 3.75" />
      </g>
    </svg>
  );
}

export interface SendKeyProps {
  canSend: boolean;
  /** A turn is running: Enter queues, the modifier steers. */
  busy: boolean;
  /** Show the stop key in the slot (busy with nothing typed). */
  showStop: boolean;
  /** The agent takes messages mid-turn. */
  steerable: boolean;
  /** Shown by the effort chip; the key's arrow stays the same. */
  ultracode?: boolean;
  sendWithEnter: boolean;
  shell: boolean;
  /** Only the session composer has a stop key. */
  stoppable: boolean;
  onSend: (steer: boolean) => void;
  onStop: () => void;
}

/**
 * The send and stop keys, sharing one 28 px slot.
 * Send is a solid ivory disc with a dark glyph; stop an ivory disc with a dark square, static.
 */
export const SendKey = memo(function SendKey({ canSend, busy, showStop, steerable, sendWithEnter, shell, stoppable, onSend, onStop }: SendKeyProps) {
  const queueing = busy && !shell;
  const held = useModHeld(queueing && steerable);
  const steer = queueing && steerable && held;
  const glyph: SendGlyph = steer ? 'steer' : 'send';
  const steerKeys = sendWithEnter ? 'mod+enter' : 'mod+shift+enter';
  const label = shell ? 'Run in terminal' : steer ? 'Steer into this turn' : queueing ? 'Queue message' : 'Send';

  return (
    <div className="cmp-keys">
      <Tip label={label} keys={steer ? steerKeys : sendWithEnter ? 'enter' : 'mod+enter'} side="top">
        <button
          type="button"
          className="cmp-send"
          data-on={!showStop || undefined}
          data-ready={canSend || undefined}
          aria-label={label}
          aria-disabled={!canSend}
          tabIndex={showStop ? -1 : 0}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => canSend && onSend(queueing && steerable && (MAC ? e.metaKey : e.ctrlKey))}
        >
          <SendGlyphSvg glyph={glyph} />
        </button>
      </Tip>
      {stoppable && (
        <Tip label="Stop" keys="esc" side="top">
          <button
            type="button"
            className="cmp-stop"
            data-on={showStop || undefined}
            aria-label="Stop"
            tabIndex={showStop ? 0 : -1}
            aria-hidden={!showStop}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onStop}
          >
            <span className="cmp-stop-sq" aria-hidden />
          </button>
        </Tip>
      )}
    </div>
  );
});
