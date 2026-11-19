import type { BridgeEvent, SessionMeta } from '../../shared/protocol';

/**
 * Keep awake: while an agent works (a turn runs, or an /until loop runs its check between turns)
 * the computer should not go to sleep, or an overnight run stops halfway. The bridge only says
 * whether work is running; the desktop shell holds the OS's sleep block (`electron/main.ts`,
 * `powerSaveBlocker` 'prevent-app-suspension': the screen may still turn off).
 *
 * Nothing runs at rest: the state is recomputed only when a session's status or loop changes.
 */

export interface AwakeSource {
  sessions: Iterable<{ meta: SessionMeta; turnActive: boolean }>;
  subscribe(listener: (e: BridgeEvent) => void): () => void;
}

/** Whether this session's agent is at work now. */
export function working(s: { meta: SessionMeta; turnActive: boolean }): boolean {
  const st = s.meta.status;
  return s.turnActive || st === 'running' || st === 'starting' || s.meta.until?.phase === 'checking';
}

/**
 * Calls `onChange(true)` when work starts anywhere and `onChange(false)` once nothing has worked
 * for `graceMs` (an /until loop's gap between check and next turn, or a queued message starting,
 * does not release and take the block again). Returns a stop function.
 */
export function watchAwake(src: AwakeSource, onChange: (busy: boolean) => void, graceMs = 60_000): () => void {
  let busy = false;
  let release: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    const now = [...src.sessions].some(working);
    if (now) {
      clearTimeout(release);
      release = undefined;
      if (!busy) {
        busy = true;
        onChange(true);
      }
    } else if (busy && !release) {
      release = setTimeout(() => {
        release = undefined;
        if ([...src.sessions].some(working)) return;
        busy = false;
        onChange(false);
      }, graceMs);
      release.unref?.();
    }
  };
  const off = src.subscribe((e) => {
    if (e.type === 'session.updated' && ('status' in e.patch || 'until' in e.patch)) check();
    else if (e.type === 'session.removed' || e.type === 'session.added') check();
  });
  check();
  return () => {
    off();
    clearTimeout(release);
    if (busy) onChange(false);
    busy = false;
  };
}
