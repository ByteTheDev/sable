/**
 * The session view (with the conversation, the markdown stack and the composer's session parts) is
 * not part of the first paint: the home screen does not need it. It loads on demand and is warmed
 * early, so the first session still opens at once: when the home screen has settled, and at the
 * latest on the first keystroke in the home composer (before a send can ask for it).
 */
type SessionViewModule = typeof import('@/features/session/SessionView');

let pending: Promise<SessionViewModule> | null = null;
let loaded: SessionViewModule | null = null;

export function loadSessionView() {
  pending ??= import('@/features/session/SessionView').then(
    (m) => (loaded = m),
    (err) => {
      pending = null;
      throw err;
    },
  );
  return pending;
}

/** The session view's module when it has loaded (warmed), for a mount that need not wait a tick. */
export const sessionViewNow = () => loaded;
