import { useEffect } from 'react';
import { create } from 'zustand';
import type { TurnCapture } from '@shared/protocol';
import { bridge } from '@/lib/bridge';

/**
 * Before / after captures per session, as the bridge reports them (server/services/capture.ts):
 * listed once per session on first use, then kept current by `capture.updated`. Pictures are
 * fetched on demand and a few are kept.
 */

interface State {
  /** sessionId → turnId → capture. */
  bySession: Record<string, Record<string, TurnCapture>>;
}

export const useCaptures = create<State>(() => ({ bySession: {} }));

const asked = new Set<string>();
let listening = false;

function put(sessionId: string, list: TurnCapture[]) {
  useCaptures.setState((s) => {
    const mine = { ...s.bySession[sessionId] };
    for (const c of list) mine[c.turnId] = c;
    return { bySession: { ...s.bySession, [sessionId]: mine } };
  });
}

function load(sessionId: string) {
  bridge.call('capture.list', { sessionId }).then(
    (list) => put(sessionId, list),
    () => asked.delete(sessionId),
  );
}

function listen() {
  if (listening) return;
  listening = true;
  bridge.on((e) => {
    if (e.type === 'capture.updated') put(e.sessionId, [e.capture]);
    else if (e.type === 'session.removed' && asked.delete(e.id)) {
      useCaptures.setState((s) => {
        const { [e.id]: _gone, ...rest } = s.bySession;
        return { bySession: rest };
      });
    }
  });
  // A bridge that came back may have captured while away.
  bridge.onStatus((s) => {
    if (s === 'open') for (const id of asked) load(id);
  });
}

function ensure(sessionId: string) {
  listen();
  if (asked.has(sessionId)) return;
  asked.add(sessionId);
  load(sessionId);
}

/** The capture of one turn, if it has one. */
export function useTurnCapture(sessionId: string, turnId: string): TurnCapture | undefined {
  useEffect(() => ensure(sessionId), [sessionId]);
  return useCaptures((s) => s.bySession[sessionId]?.[turnId]);
}

// ── pictures ──

const pictures = new Map<string, Promise<string | null>>();
const KEEP = 12;

/** A picture as a data URL (null when it is gone). The last few stay in memory. */
export function picture(sessionId: string, id: string): Promise<string | null> {
  const key = `${sessionId}/${id}`;
  let p = pictures.get(key);
  if (p) {
    // Most recently used last.
    pictures.delete(key);
    pictures.set(key, p);
    return p;
  }
  p = bridge.call('capture.image', { sessionId, id }, 20_000).then(
    (r) => r?.data ?? null,
    () => {
      pictures.delete(key);
      return null;
    },
  );
  pictures.set(key, p);
  while (pictures.size > KEEP) pictures.delete(pictures.keys().next().value!);
  return p;
}
