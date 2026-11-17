/**
 * Saved choices survive every update: state files in the shape 0.1.0, 0.1.2 and 0.1.3 wrote, with
 * choices the user made, load with every choice still there. A migration only fills what is
 * missing. Also: a saved model the agent no longer lists stays in the menu.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelInfo } from '@shared/protocol';
import { Store, fillMissing } from '../server/core/store';
import { visibleModels } from '@/lib/models';

const IMAGE = 'a1b2c3d4e5f60718';

/** The settings keys each release wrote (from its DEFAULT_SETTINGS), with the user's own choices. */
function settingsOf(version: '0.1.0' | '0.1.2' | '0.1.3') {
  return {
    accent: 'spectrum',
    ambience: 'full',
    fontScale: 1.1,
    defaultProvider: 'codex',
    // A model the agents may no longer list, an effort the model may not support.
    defaultModels: { claude: 'claude-opus-4-1-20250805', codex: 'gpt-5-codex' },
    defaultModes: { claude: 'acceptEdits', codex: 'full-access' },
    defaultEfforts: { claude: version === '0.1.0' ? 'max' : 'ultra', codex: 'minimal' },
    notifyOnDone: false,
    sendWithEnter: false,
    showThinking: false,
    backdrop: 'tubes',
    texture: 'dither',
    backdropConfig: {
      source: 'image',
      pattern: 'tubes',
      image: IMAGE,
      style: 'halftone',
      amount: 37,
      sessionAmount: 12,
      focus: { x: 0.25, y: 0.5 },
      reach: 55,
      detail: 64,
      speed: 0,
      angle: 120,
      colour: 'mono',
      hue: 200,
      saturation: 40,
      react: false,
      ...(version === '0.1.0' ? {} : { effect: 'aurora', effectAmount: 33 }),
    },
    backdropImages: [{ id: IMAGE, name: 'photo.jpg' }],
    onboarded: true,
    modelVisibility: { 'claude:claude-sonnet-4-5': true, 'codex:gpt-5': false },
    conciseReplies: false,
    rev: version === '0.1.0' ? 3 : 4,
  };
}

const session = (id: string, provider: string, model: string, effort: string) => ({
  id,
  provider,
  cwd: 'C:\\work\\app',
  title: 't',
  titleSource: 'auto',
  model,
  effort,
  mode: 'default',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
});

describe('saved choices after an update', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  for (const version of ['0.1.0', '0.1.2', '0.1.3'] as const) {
    it(`keeps every choice of a ${version} profile`, () => {
      const dir = mkdtempSync(path.join(tmpdir(), `sable-saved-${version}-`));
      dirs.push(dir);
      const settings = settingsOf(version);
      const sessions = [session('s1', 'claude', 'claude-opus-4-1-20250805', 'max'), session('s2', 'codex', 'gpt-5-codex', 'minimal')];
      writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ projects: [], settings, sessions, accounts: [] }));

      const s = new Store(dir).state;
      const got = s.settings as unknown as Record<string, unknown>;
      // Every top-level choice is as saved (the backdrop config is checked below).
      for (const [k, v] of Object.entries(settings)) if (k !== 'backdropConfig' && k !== 'rev') expect(got[k], k).toEqual(v);
      expect(got.rev).toBe(4);
      // The backdrop: every field the user set is still there.
      const bc = s.settings.backdropConfig as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(settings.backdropConfig)) expect(bc[k], `backdropConfig.${k}`).toEqual(v);
      // What later versions added is filled in.
      expect(bc.effect).toBeDefined();
      expect(s.settings.defaultSpeeds === undefined || typeof s.settings.defaultSpeeds === 'object').toBe(true);
      // Sessions keep their model and effort.
      expect(s.sessions.map((x) => [x.model, x.effort])).toEqual([
        ['claude-opus-4-1-20250805', 'max'],
        ['gpt-5-codex', 'minimal'],
      ]);
    });
  }

  it('a profile without a version mark keeps a backdrop config it already has', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sable-saved-norev-'));
    dirs.push(dir);
    const { rev: _rev, ...settings } = settingsOf('0.1.3');
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ projects: [], settings, sessions: [], accounts: [] }));
    const s = new Store(dir).state;
    expect(s.settings.backdropConfig.amount).toBe(37);
    expect(s.settings.backdropConfig.pattern).toBe('tubes');
    expect(s.settings.backdrop).toBe('tubes');
  });
});

describe('fillMissing', () => {
  it('fills only what is missing, also inside nested objects', () => {
    const d = { a: 1, b: { x: 1, y: 2 }, c: [1], e: false, n: null as null | number };
    expect(fillMissing(d, { b: { x: 5 }, c: [], e: true, n: 4, extra: 'kept' })).toEqual({ a: 1, b: { x: 5, y: 2 }, c: [], e: true, n: 4, extra: 'kept' });
    expect(fillMissing(d, { a: 0, e: false, n: null })).toMatchObject({ a: 0, e: false, n: null });
  });
});

describe('a saved model the agent no longer lists', () => {
  const models: ModelInfo[] = [
    { id: 'gpt-6', name: 'gpt-6', isDefault: true, picker: true },
    { id: 'gpt-6-mini', name: 'gpt-6-mini', picker: true },
  ];
  it('stays in the menu, by its name only', () => {
    const list = visibleModels('codex', models, {}, 'gpt-5-codex');
    expect(list.map((m) => m.id)).toContain('gpt-5-codex');
    const saved = list.find((m) => m.id === 'gpt-5-codex')!;
    expect(saved.name).toBe('GPT-5-Codex');
    expect(saved.description).toBeUndefined();
  });
  it('adds nothing when the saved model is listed or none is saved', () => {
    expect(visibleModels('codex', models, {}, 'gpt-6').map((m) => m.id)).not.toContain(undefined);
    expect(visibleModels('codex', models, {}).every((m) => models.includes(m))).toBe(true);
  });
});
