/**
 * The send flight: the composer records where the words left from; the bubble that arrives with
 * the same text flies from there into its place (Timeline's UserBubble), once.
 */
let pending: { text: string; rect: DOMRect; at: number } | null = null;

export function launchFlight(text: string, rect: DOMRect) {
  pending = { text, rect, at: performance.now() };
}

export function takeFlight(text: string) {
  const p = pending;
  if (!p || p.text !== text || performance.now() - p.at > 4000) return null;
  pending = null;
  return p;
}
