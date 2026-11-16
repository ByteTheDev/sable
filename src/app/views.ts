/**
 * The session view (with the conversation, the markdown stack and the composer's session parts) is
 * not part of the first paint: the home screen does not need it. It loads on demand and is warmed
 * early, so the first session still opens at once: when the home screen has settled, and at the
 * latest on the first keystroke in the home composer (before a send can ask for it).
 */
let pending: Promise<typeof import('@/features/session/SessionView')> | null = null;

export function loadSessionView() {
  pending ??= import('@/features/session/SessionView').catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}
