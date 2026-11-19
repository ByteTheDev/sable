/**
 * Lead-ins: the one-line announcements an agent writes before a step ("Let me read the handler.",
 * "Now I'll run the tests."). They say what the next step does, so they read as part of the work:
 * folded with the steps they announce, and named by the live line while those steps run. A text
 * that also says what the agent found ("The guard answers 403. Let me fix it.") is a report and
 * stays in view.
 *
 * Pure and cheap: `shapeOf` asks on every streamed word of a short text, and gives up at once on a
 * long one.
 */

/** Longer than this, a text is never a lead-in (a plan, a report). */
export const LEAD_MAX = 200;

/** Words that may open an announcement before its verb: "Now, let me...", "Perfect! Let me...". */
const OPENERS = ['ok', 'okay', 'alright', 'now', 'next', 'first', 'then', 'so', 'great', 'good', 'perfect', 'excellent', 'nice', 'right', 'sure', 'got it', 'and'];
/** Openers that also stand as a sentence of their own ("Perfect."). */
const FILLERS = ['ok', 'okay', 'alright', 'great', 'good', 'perfect', 'excellent', 'nice', 'right', 'sure', 'got it'];
/** How an announcement goes on: the agent says what it is about to do. */
const PHRASES = [
  'let me',
  "let's",
  "i'll",
  'i will',
  "i'm going to",
  'i am going to',
  "i'm now going to",
  'i need to',
  'i want to',
  'i should',
  'we need to',
  'time to',
  'lass mich',
  'lass uns',
  'ich werde',
  'ich schaue',
  'ich prüfe',
  'ich sehe mir',
];
/** "I'm checking ...", or the bare form "Checking ...": what it is doing now. */
const DOING = ['checking', 'looking', 'reading', 'searching', 'scanning', 'inspecting', 'reviewing', 'opening', 'exploring', 'investigating', 'verifying', 'tracing', 'pulling', 'grabbing', 'digging'];

/**
 * Verbs that make an announcement a report after all: "I should note the key is read from .env",
 * "I need to point out the tests were failing before". What the agent says, not what it does next.
 */
const SAYING = ['note', 'mention', 'point out', 'flag', 'say', 'warn', 'add that', 'clarify', 'stress', 'emphasize', 'emphasise', 'highlight', 'admit', 'be clear', 'be honest', 'summarize', 'summarise', 'recap'];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OPENER = `(?:(?:${OPENERS.map(esc).join('|')})[,!.]?\\s+)`;
const ANNOUNCE = new RegExp(`^${OPENER}*(?:${[...PHRASES, ...DOING].map(esc).join('|')}|i'm (?:now )?(?:${DOING.join('|')}))\\b`);
const SAYS = new RegExp(`^${OPENER}*(?:${PHRASES.map(esc).join('|')})\\s+(?:(?:also|just|briefly|quickly|first)\\s+)?(?:${SAYING.map(esc).join('|')})\\b`);
/** "Looking at the logs, the guard throws first.": a bare doing word that leads into a finding. */
const FINDING = new RegExp(`^${OPENER}*(?:${DOING.join('|')})\\b[^,]*,\\s*\\S`);
const FILLER = new RegExp(`^(?:${FILLERS.map(esc).join('|')})[,!.]*$`);
const LEADING = new RegExp(`^${OPENER}*`);
const STARTS = [...PHRASES, ...DOING, ...DOING.map((d) => `i'm ${d}`), ...OPENERS];

/** Plain words: no code ticks, emphasis or link targets; curly apostrophes made straight. */
function plain(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/[‘’]/g, "'")
    .trim();
}

const sentences = (s: string) => s.split(/(?<=[.!?:])\s+/).filter(Boolean);

/** A sentence still being written that may yet turn out an announcement. */
function mayStart(part: string): boolean {
  const rest = part.replace(LEADING, '');
  if (!rest) return true;
  return STARTS.some((p) => p.startsWith(rest) || (rest.startsWith(p) && /^[\s,!.]/.test(rest.slice(p.length) || ' ')));
}

/**
 * Whether a text is a lead-in. While it streams, a text that may still become one counts as one
 * (an empty one too): it shows the moment it is plainly something else, and a lead-in never shows
 * and then folds away. Questions and anything over one line or `LEAD_MAX` are never lead-ins.
 */
export function isLeadIn(text: string, streaming: boolean): boolean {
  if (text.length > LEAD_MAX + 40) return false;
  const t = plain(text).toLowerCase();
  if (!t) return streaming;
  if (t.length > LEAD_MAX || t.includes('\n')) return false;
  const parts = sentences(t);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.endsWith('?') || p.startsWith('let me know') || p.startsWith("let's discuss")) return false;
    if (SAYS.test(p)) return false;
    // "Looking at the logs, the guard throws": a finding. "Looking good, let me run the tests": not.
    if (FINDING.test(p) && !ANNOUNCE.test(p.slice(p.indexOf(',') + 1).trim())) return false;
    if (ANNOUNCE.test(p) || FILLER.test(p)) continue;
    // The sentence being written: it may still become one.
    if (streaming && i === parts.length - 1 && mayStart(p)) continue;
    return false;
  }
  return true;
}

/** What strips off an announcement to leave what it does: "Let me run the tests." → "Run the tests". */
const SUBJECT = /^(?:let me|let's|i'll|i will|i'm (?:now )?going to|i am going to|i need to|i want to|i should|we need to|time to|lass mich|lass uns)\s+(?:(?:first|now|also|quickly|just|then|next|go ahead and|start by)\s+)*/i;

/**
 * A lead-in as the live line's title, in the voice of a step's own title: "Now let me run the
 * tests." reads "Run the tests", "I'm checking the routes" reads "Checking the routes".
 */
export function leadTitle(text: string): string {
  const parts = sentences(plain(text).replace(/\s+/g, ' '));
  const first = parts.find((p) => !FILLER.test(p.toLowerCase())) ?? parts[0] ?? '';
  let s = first.replace(new RegExp(LEADING.source, 'i'), '');
  s = s.replace(SUBJECT, '').replace(/^i'm\s+(?:now\s+)?/i, '');
  s = s.replace(/[\s.:!…]+$/u, '');
  if (!s) return first.replace(/[\s.:!…]+$/u, '');
  return s[0].toUpperCase() + s.slice(1);
}
