import { sendMessage } from '@/state/actions';
import { useStore } from '@/state/store';
import { Flood, judgePrompt, type PromptRefusal } from './guard';

/**
 * The app's side of every widget frame.
 *
 * A frame is `<iframe sandbox="allow-scripts" src="/widget-frame.html">` (opaque origin, strict
 * CSP, no network). That page creates one nested sandboxed frame where the widget runs, and the
 * app talks to that nested frame directly. Messages (all carry `__sable: 1`):
 *
 *   frame → app   ready · size {h} · rendered {final} · prompt {text, gesture} · error {message} · blocked {directive, uri}
 *   page → app    left (the widget navigated its frame; the page dropped it)
 *   app → frame   init {css, fonts} · render {code, final}
 *
 * A message is accepted only from the exact window of a frame the app created (`event.source`),
 * within a budget per frame (`Flood`); a frame that floods is removed. Sizes are clamped by the
 * frame component (`HeightGuard`). `sendPrompt` goes through `judgePrompt`: right after a real
 * user gesture inside that frame, one at a time, never while a prompt waits for the user.
 */

export interface FrameMessage {
  type: string;
  [key: string]: unknown;
}

export interface FrameLink {
  outer: HTMLIFrameElement;
  flood: Flood;
  receive(m: FrameMessage): void;
  /** The frame flooded the app with messages: tear it down. */
  kill(): void;
}

const links = new Set<FrameLink>();
let listening = false;

const KNOWN = new Set(['ready', 'size', 'rendered', 'prompt', 'error', 'blocked', 'hover']);
const LIMITED = new Set(['prompt', 'error', 'blocked', 'hover']);

/** The window the widget runs in (the frame inside the frame), once it exists. */
function innerOf(l: FrameLink): Window | undefined {
  try {
    return l.outer.contentWindow?.frames[0] ?? undefined;
  } catch {
    return undefined;
  }
}

function onMessage(e: MessageEvent) {
  const src = e.source;
  if (!src || links.size === 0) return;
  for (const l of links) {
    // The frame page itself says one thing only: the widget navigated away and was dropped.
    if (src === l.outer.contentWindow) {
      if ((e.data as FrameMessage | null)?.type === 'left') l.receive({ type: 'left' });
      return;
    }
    if (innerOf(l) !== src) continue;
    const d = e.data as FrameMessage | null;
    const type = d && typeof d === 'object' && (d as { __sable?: unknown }).__sable === 1 && typeof d.type === 'string' ? d.type : '';
    // Everything counts toward the stop; only messages that cost something spend from the budget.
    // Sizes are coalesced per frame by the frame component; protocol steps are idempotent; the
    // rest is ignored, so a flood of junk can never starve the messages that matter.
    const v = l.flood.hit(performance.now(), LIMITED.has(type));
    if (v === 'kill') l.kill();
    else if (v === 'ok' && KNOWN.has(type)) l.receive(d!);
    return;
  }
}

/** Registers a frame; returns the function that forgets it. */
export function linkFrame(l: FrameLink): () => void {
  links.add(l);
  if (!listening) {
    window.addEventListener('message', onMessage);
    listening = true;
  }
  return () => {
    links.delete(l);
  };
}

/** Posts to the widget's window (nothing happens before it exists). */
export function postToFrame(l: FrameLink, msg: FrameMessage): boolean {
  const inner = innerOf(l);
  if (!inner) return false;
  inner.postMessage({ ...msg, __sable: 1 }, '*');
  return true;
}

/** Frames currently linked (for tests and the sandbox report). */
export const linkedFrames = () => links.size;

// ── sendPrompt ──

let inFlight = false;
const lastSent = new WeakMap<HTMLIFrameElement, number>();

const REFUSAL_TOAST: Partial<Record<PromptRefusal, string>> = {
  busy: 'The agent is still working. Try again when it finishes.',
  'prompt-open': 'Answer the open prompt first.',
};

/**
 * A widget asked to send `text` as the user. Returns why it was refused, or null when it was sent.
 * Refusals a widget could cause on its own (no gesture, too long, too soon) stay silent.
 */
export function handlePrompt(outer: HTMLIFrameElement, sessionId: string | undefined, text: unknown): PromptRefusal | null {
  const s = useStore.getState();
  const meta = sessionId ? s.sessions[sessionId] : undefined;
  const data = sessionId ? s.data[sessionId] : undefined;
  const status = meta?.status;
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  const verdict = judgePrompt({
    text,
    enabled: !!meta && s.settings.generativeUi !== false,
    frameFocused: document.activeElement === outer,
    userActive: ua ? ua.isActive : false,
    sessionBusy: status === 'running' || status === 'starting' || status === 'awaiting',
    promptOpen: !!data && (data.permissions.length > 0 || data.questions.length > 0),
    inFlight,
    now: Date.now(),
    lastSentAt: lastSent.get(outer) ?? 0,
  });
  if (!verdict.ok) {
    const msg = REFUSAL_TOAST[verdict.reason];
    if (msg) s.toast(msg, 'info');
    return verdict.reason;
  }
  inFlight = true;
  lastSent.set(outer, Date.now());
  void sendMessage(sessionId!, verdict.text).finally(() => {
    inFlight = false;
  });
  return null;
}
