/**
 * Lanes in the UI: the session's lane (`SessionMeta.lane`), its last forecast (a dry merge into
 * the folder's branch, asked of the bridge when something shows it), and the lane's actions.
 * The header's mark and the Changes tab's lane section read the same forecast.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { LaneForecast, LaneLandResult, SessionLane } from '@shared/protocol';
import { bridge } from '@/lib/bridge';
import { useStore } from '@/state/store';

interface LaneEntry {
  forecast?: LaneForecast;
  /** The lane the forecast is about (a new lane starts afresh). */
  path?: string;
  loading: boolean;
  /** How the session's last lane ended, for the mark's last moment. */
  ended?: 'landed' | 'discarded';
}

export const useLanes = create<{ byId: Record<string, LaneEntry | undefined> }>(() => ({ byId: {} }));

const patch = (id: string, p: Partial<LaneEntry>) => useLanes.setState((s) => ({ byId: { ...s.byId, [id]: { loading: false, ...s.byId[id], ...p } } }));

const inflight = new Map<string, Promise<void>>();

/** Asks the bridge for a fresh forecast (one at a time per session). */
export function refreshLane(sessionId: string): Promise<void> {
  const running = inflight.get(sessionId);
  if (running) return running;
  const lane = useStore.getState().sessions[sessionId]?.lane;
  if (!lane) return Promise.resolve();
  patch(sessionId, { loading: true });
  const p = bridge
    .call('lane.forecast', { sessionId }, 60_000)
    .then((forecast) => patch(sessionId, { forecast, path: lane.path, loading: false }))
    .catch(() => patch(sessionId, { loading: false }))
    .finally(() => inflight.delete(sessionId));
  inflight.set(sessionId, p);
  return p;
}

/** The session's lane, or undefined. */
export const useSessionLane = (sessionId: string): SessionLane | undefined => useStore((s) => s.sessions[sessionId]?.lane ?? undefined);

/** The lane's forecast; asked once when the lane shows and again whenever the session's turn ends. */
export function useLaneForecast(sessionId: string, lanePath: string | undefined): LaneEntry | undefined {
  const status = useStore((s) => s.sessions[sessionId]?.status);
  const entry = useLanes((s) => s.byId[sessionId]);
  const idle = status === 'idle';
  useEffect(() => {
    if (lanePath && idle) void refreshLane(sessionId);
  }, [sessionId, lanePath, idle]);
  return entry && entry.path === lanePath ? entry : entry ? { ...entry, forecast: undefined } : undefined;
}

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: (err as Error)?.message || String(err) };
}

/** Lands the lane on the folder's branch (its uncommitted edits committed first with `message`). */
export async function landLane(sessionId: string, message: string): Promise<LaneLandResult> {
  // Said before the call: the lane leaves the session (an event) before the call answers.
  patch(sessionId, { ended: 'landed' });
  const res = await bridge.call('lane.land', { sessionId, message }, 300_000).catch(fail);
  if (res.ok) patch(sessionId, { forecast: undefined, path: undefined });
  else {
    patch(sessionId, { ended: undefined });
    void refreshLane(sessionId);
  }
  return res;
}

/** Drops the lane and its work; the chat goes back to its folder. */
export async function discardLane(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  patch(sessionId, { ended: 'discarded' });
  const res = await bridge.call('lane.discard', { sessionId }, 120_000).catch(fail);
  if (res.ok) patch(sessionId, { forecast: undefined, path: undefined });
  else patch(sessionId, { ended: undefined });
  return res;
}

/** Moves the chat into a lane of its own now. */
export async function createLane(sessionId: string): Promise<void> {
  const res = await bridge.call('lane.create', { sessionId }, 300_000).catch(fail);
  if (res.ok) patch(sessionId, { ended: undefined });
  else useStore.getState().toast(res.error ?? 'Could not make a lane.', 'error');
}

export async function openLaneFolder(sessionId: string) {
  const res = await bridge.call('lane.open', { sessionId }).catch(fail);
  if (!res.ok) useStore.getState().toast(res.error ?? 'Could not open the lane folder.', 'error');
}

/** `sable/until-green` reads as its last part where room is short. */
export const laneName = (branch: string) => branch.replace(/^sable\//, '');
