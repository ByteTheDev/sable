/**
 * The backdrop config: its default, the built-in presets, and `normalizeBackdrop`, which every
 * stored or user-supplied value passes through (bridge migration, settings handler and UI).
 * Pure: no imports with side effects, so both the bridge and the UI use it.
 */
import { DEFAULT_BACKDROP, type BackdropColour, type BackdropConfig, type BackdropPattern, type BackdropSource, type BackdropStyle } from './protocol';

export { DEFAULT_BACKDROP };

const SOURCES: readonly BackdropSource[] = ['pattern', 'image', 'off'];
export const BACKDROP_PATTERNS: readonly BackdropPattern[] = ['streaks', 'tubes', 'tiles', 'aurora'];
const STYLES: readonly BackdropStyle[] = ['dither', 'ascii', 'halftone', 'soft'];
const COLOURS: readonly BackdropColour[] = ['agent', 'mono', 'custom', 'image'];

/** Patterns with a direction (`angle` applies). */
export const DIRECTIONAL: readonly BackdropPattern[] = ['streaks', 'tubes'];

export interface BackdropPreset {
  id: string;
  name: string;
  config: BackdropConfig;
}

const preset = (id: string, name: string, patch: Partial<BackdropConfig>): BackdropPreset => ({ id, name, config: { ...DEFAULT_BACKDROP, ...patch } });

export const BACKDROP_PRESETS: readonly BackdropPreset[] = [
  // Quiet, the default (14), Streaks and Vivid are spaced so each step reads at thumbnail size.
  preset('quiet', 'Quiet', { amount: 6, sessionAmount: 18, speed: 20 }),
  preset('streaks', 'Streaks', { amount: 32, detail: 80, speed: 45, sessionAmount: 40 }),
  preset('corner', 'Corner', { pattern: 'aurora', amount: 70, reach: 46, focus: { x: 1, y: 1 }, speed: 30 }),
  preset('ascii', 'ASCII', { style: 'ascii', pattern: 'streaks', amount: 50, detail: 76 }),
  preset('halftone', 'Halftone', { style: 'halftone', pattern: 'aurora', amount: 56, reach: 64, focus: { x: 0.5, y: 0 }, detail: 76 }),
  preset('still', 'Still', { pattern: 'tiles', amount: 44, speed: 0, reach: 72, focus: { x: 0.2, y: 1 } }),
  preset('mono', 'Mono', { colour: 'mono', pattern: 'tubes', amount: 42 }),
  // The old full-bleed look: everything at full strength.
  preset('vivid', 'Vivid', { amount: 60, detail: 82, speed: 50, sessionAmount: 60 }),
];

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return n < lo ? lo : n > hi ? hi : n;
};

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

const IMAGE_ID = /^[a-f0-9]{8,64}$/;

/** True for an id the bridge could have made (hex only, so it can never name a path). */
export const isBackdropImageId = (id: unknown): id is string => typeof id === 'string' && IMAGE_ID.test(id);

/**
 * A complete, valid config from anything: numbers clamped (and rounded where they are steps),
 * unknown values replaced by the default, unknown keys dropped. With `images` (the ids that
 * exist), an image that is gone is cleared.
 */
export function normalizeBackdrop(input: unknown, images?: readonly string[]): BackdropConfig {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const d = DEFAULT_BACKDROP;
  const focus = o.focus && typeof o.focus === 'object' ? (o.focus as Record<string, unknown>) : {};
  let image = isBackdropImageId(o.image) ? o.image : null;
  if (image && images && !images.includes(image)) image = null;
  const source = pick(o.source, SOURCES, d.source);
  let colour = pick(o.colour, COLOURS, d.colour);
  // The image's own colours exist only when an image is drawn.
  if (colour === 'image' && source !== 'image') colour = 'agent';
  const round = (v: unknown, lo: number, hi: number, f: number) => Math.round(clamp(v, lo, hi, f));
  return {
    source,
    pattern: pick(o.pattern, BACKDROP_PATTERNS, d.pattern),
    image,
    style: pick(o.style, STYLES, d.style),
    amount: round(o.amount, 0, 100, d.amount),
    sessionAmount: round(o.sessionAmount, 0, 100, d.sessionAmount),
    focus: { x: Math.round(clamp(focus.x, 0, 1, d.focus.x) * 1000) / 1000, y: Math.round(clamp(focus.y, 0, 1, d.focus.y) * 1000) / 1000 },
    reach: round(o.reach, 0, 100, d.reach),
    detail: round(o.detail, 0, 100, d.detail),
    speed: round(o.speed, 0, 100, d.speed),
    angle: round(o.angle, 0, 180, d.angle),
    colour,
    hue: round(o.hue, 0, 360, d.hue),
    saturation: round(o.saturation, 0, 100, d.saturation),
    react: typeof o.react === 'boolean' ? o.react : d.react,
  };
}

/** Whether two configs draw the same thing. */
export function sameBackdrop(a: BackdropConfig, b: BackdropConfig): boolean {
  for (const k of Object.keys(a) as (keyof BackdropConfig)[]) {
    if (k === 'focus') {
      if (a.focus.x !== b.focus.x || a.focus.y !== b.focus.y) return false;
    } else if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * The config for a profile saved before `backdropConfig` existed, from its old switches:
 * ambience off → source off, calm → low and still, full → the new default. The pattern and
 * texture chosen then are kept.
 */
export function migrateBackdrop(old: { ambience?: unknown; backdrop?: unknown; texture?: unknown }): BackdropConfig {
  const pattern = pick(old.backdrop, BACKDROP_PATTERNS, DEFAULT_BACKDROP.pattern);
  const style = old.texture === 'ascii' ? 'ascii' : 'dither';
  const base = { ...DEFAULT_BACKDROP, pattern, style } satisfies BackdropConfig;
  if (old.ambience === 'off') return { ...base, source: 'off' };
  if (old.ambience === 'calm') return { ...base, amount: 6, sessionAmount: 18, speed: 0 };
  return base;
}

/** Cell size in CSS px for the dither texture (detail 100 = 3px, 0 = 14px). */
export const backdropCell = (detail: number) => Math.round(3 + ((100 - detail) / 100) * 11);
