import { STANDARD_SPEED, type ModelInfo } from './protocol';

/** The speeds a model offers beyond standard (empty when it has none, or the model is unknown). */
export const modelSpeeds = (m: ModelInfo | undefined) => m?.speeds ?? [];

/** The speed a session can keep on a model: the one asked for when the model offers it, otherwise standard. */
export function speedFor(m: ModelInfo | undefined, speed: string | undefined): string {
  return speed && speed !== STANDARD_SPEED && modelSpeeds(m).some((s) => s.id === speed) ? speed : STANDARD_SPEED;
}

/** What `/fast` switches to: standard when a faster speed is on, otherwise the fastest the model offers (the last listed). */
export function toggledSpeed(m: ModelInfo | undefined, speed: string | undefined): string {
  const speeds = modelSpeeds(m);
  if (speedFor(m, speed) !== STANDARD_SPEED || !speeds.length) return STANDARD_SPEED;
  return speeds[speeds.length - 1].id;
}
