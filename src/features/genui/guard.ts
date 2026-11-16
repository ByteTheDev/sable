/**
 * The rules a widget frame lives by, kept pure so they can be tested: when a widget may send a
 * message as the user, how many messages it may post, and how its height may change.
 * A widget is code a model wrote, possibly after reading a hostile page: nothing it says is trusted.
 */

/** The longest message a widget may send. Longer ones are refused, never cut. */
export const PROMPT_MAX = 2000;
/** The tallest a frame may become (taller content is cut off inside it). */
export const MAX_FRAME_H = 20_000;
/** Between two messages from the same widget, at least this long. */
export const PROMPT_GAP_MS = 1500;

export interface PromptContext {
  text: unknown;
  /** The feature is on. */
  enabled: boolean;
  /** The frame holds focus in the app: the user clicked or tabbed into it. */
  frameFocused: boolean;
  /** The app has transient user activation (a real click or key press within the last few seconds). */
  userActive: boolean;
  /** The agent is working (or starting) in this session. */
  sessionBusy: boolean;
  /** A permission or question prompt is waiting for the user. */
  promptOpen: boolean;
  /** A message from a widget is already being sent. */
  inFlight: boolean;
  now: number;
  /** When this frame last sent a message (0: never). */
  lastSentAt: number;
}

export type PromptRefusal = 'disabled' | 'empty' | 'too-long' | 'no-gesture' | 'busy' | 'prompt-open' | 'too-soon';
export type PromptVerdict = { ok: true; text: string } | { ok: false; reason: PromptRefusal };

/** Control characters other than tab and newline are dropped; blank runs are tidied. */
export function cleanPromptText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Decides whether a widget's sendPrompt goes through. */
export function judgePrompt(c: PromptContext): PromptVerdict {
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  const text = cleanPromptText(c.text);
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > PROMPT_MAX) return { ok: false, reason: 'too-long' };
  // Only right after the user acted inside this very frame.
  if (!c.frameFocused || !c.userActive) return { ok: false, reason: 'no-gesture' };
  if (c.promptOpen) return { ok: false, reason: 'prompt-open' };
  if (c.sessionBusy || c.inFlight) return { ok: false, reason: 'busy' };
  if (c.lastSentAt && c.now - c.lastSentAt < PROMPT_GAP_MS) return { ok: false, reason: 'too-soon' };
  return { ok: true, text };
}

/**
 * Message budget per frame: a steady rate with a small burst, and a hard stop for a frame that
 * keeps flooding (it is then removed).
 */
export class Flood {
  private tokens: number;
  private last = 0;
  private window: number[] = [];

  constructor(
    private readonly perSecond = 60,
    private readonly burst = 120,
    /** More than this many messages within `killWindowMs` stops the frame. */
    private readonly killAfter = 1500,
    private readonly killWindowMs = 10_000,
  ) {
    this.tokens = burst;
  }

  /** `limited`: the message spends from the budget; others (sizes, which are coalesced) only count toward the stop. */
  hit(now: number, limited = true): 'ok' | 'drop' | 'kill' {
    this.window.push(now);
    while (this.window.length && now - this.window[0] > this.killWindowMs) this.window.shift();
    if (this.window.length > this.killAfter) return 'kill';
    if (!limited) return 'ok';
    if (this.last) this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return 'drop';
    this.tokens -= 1;
    return 'ok';
  }
}

/**
 * Height reports from a frame. Clamps them, and stops following a finished widget whose height
 * keeps growing on its own (content sized to the frame: each new height makes it taller again).
 */
export class HeightGuard {
  frozen = false;
  private last = -1;
  private growths: number[] = [];

  constructor(
    private readonly maxGrowths = 14,
    private readonly windowMs = 3000,
  ) {}

  /** The height to use, or null to ignore the report. */
  push(raw: unknown, now: number, final: boolean): number | null {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : NaN;
    if (Number.isNaN(n)) return null;
    const h = Math.max(0, Math.min(MAX_FRAME_H, Math.round(n)));
    // Stopped following growth; shrinking cannot loop, so it is still taken.
    if (this.frozen) {
      if (h >= this.last - 1) return null;
      this.last = h;
      return h;
    }
    if (final) {
      if (h > this.last + 1) {
        this.growths.push(now);
        while (this.growths.length && now - this.growths[0] > this.windowMs) this.growths.shift();
        if (this.growths.length > this.maxGrowths) {
          this.frozen = true;
          return null;
        }
      } else if (h < this.last - 1) this.growths = [];
    }
    this.last = h;
    return h;
  }

  /** Streaming is over: only growth after this point counts. */
  settle() {
    this.growths = [];
  }
}
