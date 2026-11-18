/**
 * The person's message card, as numbers shared by the card (timeline.css `.user-card`) and the
 * bubble that flies to it from the composer (composer/flight.ts): both must agree to the pixel.
 */

/** The card's type: the answer's size and leading (components/markdown.css `.md`). */
export const CARD_FONT = 14;
export const CARD_LINE = CARD_FONT * 1.62;
/** The card's padding: the words stand this far in from its left and top edges. */
export const CARD_PAD_X = 16;
export const CARD_PAD_TOP = 10;

/** Past this many characters or lines a message is clipped, to ten whole lines (`.user-text[data-clipped]`). */
const LONG_CHARS = 1400;
const LONG_LINES = 18;

export const isLongMessage = (text: string) => text.length > LONG_CHARS || text.split('\n').length > LONG_LINES;
