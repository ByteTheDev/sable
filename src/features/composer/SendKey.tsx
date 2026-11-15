import { memo, useSyncExternalStore } from 'react';
import { Kbd, Tip } from '@/ui';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export type SendGlyph = 'send' | 'queue' | 'steer';

// ── the modifier key, shared by the send key and its hint (one set of listeners for the app) ──

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
 * The send key's glyph: one drawing whose parts move between three states, so a change of
 * meaning is a morph, not a swap.
 * - send: an arrow straight up.
 * - queue: the shaft retracts into two lines below the head: "onto the list".
 * - steer: the lines drop away and the arrow leans into the turn, up and to the right.
 * With `double` (ultracode) a second head rides under the first.
 */
export function SendGlyphSvg({ glyph, double }: { glyph: SendGlyph; double?: boolean }) {
  return (
    <svg className="sk-glyph" data-glyph={glyph} data-double={double || undefined} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <g className="sk-arrow">
        <path className="sk-shaft" d="M8 13.25V3.6" />
        <path className="sk-head" d="M3.9 7.6 8 3.5l4.1 4.1" />
        <path className="sk-head2" d="M3.9 7.6 8 3.5l4.1 4.1" />
      </g>
      <path className="sk-line sk-line-1" d="M4.4 10.4h7.2" />
      <path className="sk-line sk-line-2" d="M5.6 13.4h4.8" />
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
  ultracode: boolean;
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
export const SendKey = memo(function SendKey({ canSend, busy, showStop, steerable, ultracode, sendWithEnter, shell, stoppable, onSend, onStop }: SendKeyProps) {
  const queueing = busy && !shell;
  const held = useModHeld(queueing && steerable);
  const steer = queueing && steerable && held;
  const glyph: SendGlyph = !queueing ? 'send' : steer ? 'steer' : 'queue';
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
          <SendGlyphSvg glyph={glyph} double={ultracode} />
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

/**
 * The key hint while a turn runs and something is typed: which keys queue, and (with the modifier
 * held) which steer. It lives in the toolbar's free space, so it never moves another control.
 */
export const SendHint = memo(function SendHint({ on, steerable, sendWithEnter }: { on: boolean; steerable: boolean; sendWithEnter: boolean }) {
  const steer = useModHeld(on && steerable);
  const queueKeys = sendWithEnter ? 'enter' : 'mod+enter';
  const steerKeys = sendWithEnter ? 'mod+enter' : 'mod+shift+enter';
  return (
    <div className="sk-hint" data-on={on || undefined} aria-hidden>
      <span className="sk-hint-in" key={steer ? 'steer' : 'queue'}>
        <Kbd combo={steer ? steerKeys : queueKeys} />
        {steer ? 'Steer into this turn' : steerable ? 'Queue' : 'Queue for when this turn ends'}
      </span>
    </div>
  );
});
