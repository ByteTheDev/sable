import { STANDARD_SPEED, type ModelInfo, type SpeedInfo } from './protocol';

/** The speeds a model offers beyond standard (empty when it has none, or the model is unknown). */
export const modelSpeeds = (m: ModelInfo | undefined) => m?.speeds ?? [];

/** A speed billed outside the plan (Claude Code's fast mode is paid from extra usage, even with plan usage left). */
export const isPaidSpeed = (s: SpeedInfo | undefined) => !!s?.paid;

/** The speed a session can keep on a model: the one asked for when the model offers it, otherwise standard. */
export function speedFor(m: ModelInfo | undefined, speed: string | undefined): string {
  return speed && speed !== STANDARD_SPEED && modelSpeeds(m).some((s) => s.id === speed) ? speed : STANDARD_SPEED;
}

/**
 * The speeds the composer lists for an account: those included in the plan, and a paid one only
 * when the account has extra usage on (`extraUsage`, from its limits report). Unknown means no.
 */
export function offeredSpeeds(m: ModelInfo | undefined, extraUsage: boolean | undefined): SpeedInfo[] {
  const all = modelSpeeds(m);
  return extraUsage ? all : all.filter((s) => !s.paid);
}

/** The speeds that may be a default for new sessions: a paid one never is. */
export const defaultableSpeeds = (m: ModelInfo | undefined) => modelSpeeds(m).filter((s) => !s.paid);

/** The speed a new session starts with from a saved default: a paid speed (or one the model lacks) starts as standard. */
export function startSpeedFor(m: ModelInfo | undefined, speed: string | undefined): string {
  const s = speedFor(m, speed);
  return isPaidSpeed(modelSpeeds(m).find((x) => x.id === s)) ? STANDARD_SPEED : s;
}

/** What `/fast` switches to: standard when a faster speed is on, otherwise the fastest offered (the last listed). */
export function toggledSpeed(m: ModelInfo | undefined, speed: string | undefined, offered: SpeedInfo[] = modelSpeeds(m)): string {
  if (speedFor(m, speed) !== STANDARD_SPEED || !offered.length) return STANDARD_SPEED;
  return offered[offered.length - 1].id;
}
