/**
 * Whether a send is still in the air: a bubble or words flying to their place (flight.ts), or the
 * home composer gliding to the dock (home/handoff.ts). Chrome that need not change in the send's
 * frames (the sidebar's order, the top bar's extras) waits for the landing through `afterSend`,
 * so the main thread is free for the landing itself.
 */

let inAir = 0;
const waiting = new Set<() => void>();

/** Marks one thing in the air; the returned function lands it (safe to call twice). */
export function holdSend(): () => void {
  inAir++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inAir = Math.max(0, inAir - 1);
    if (inAir) return;
    const list = [...waiting];
    waiting.clear();
    for (const fn of list) fn();
  };
}

export const sendInAir = () => inAir > 0;

/** Runs `fn` once nothing is in the air (at once when nothing is). Returns a cancel. */
export function afterSend(fn: () => void): () => void {
  if (!inAir) {
    fn();
    return () => {};
  }
  waiting.add(fn);
  return () => waiting.delete(fn);
}
