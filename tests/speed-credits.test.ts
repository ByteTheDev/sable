/**
 * New models listed from what the agent offers, speeds (Claude Code's fast mode, Codex's service
 * tiers) and what happens at a plan limit with credits, and when a full window resets. The Demo
 * agent stands in for the real ones; nothing reaches a real profile.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelInfo, RateLimit } from '@shared/protocol';
import { modelName, modelNameById, speedFor, toggledSpeed, visibleModels } from '../src/lib/models';
import { codexSpeeds, mapModel, serviceTierFor } from '../server/providers/codex-map';
import type { Model } from '../server/providers/codex-types';
import { startSettings } from '../server/providers/claude';
import { creditsAvailable, decideAtLimit, dueResets, nextResetAlert, runningOnCredits } from '../server/core/limit-policy';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';

const codexModel = (over: Partial<Model>): Model => ({
  id: 'x',
  model: 'x',
  displayName: 'X',
  description: '',
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: 'medium',
  isDefault: false,
  ...over,
});

describe('models the agent offers', () => {
  const models: ModelInfo[] = [
    mapModel(codexModel({ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true })),
    // Released tomorrow: Sable has never heard of it.
    mapModel(codexModel({ id: 'nova-1', model: 'nova-1', displayName: 'Nova One' })),
    mapModel(codexModel({ id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6-Sol', upgrade: 'gpt-6.1-sol' })),
    mapModel(codexModel({ id: 'internal-eval', model: 'internal-eval', displayName: 'Internal', hidden: true })),
  ];

  it('lists an unknown new model under its own display name', () => {
    const shown = visibleModels('codex', models, undefined).map((m) => m.id);
    expect(shown).toContain('nova-1');
    expect(modelName(models[1])).toBe('Nova One');
    expect(modelNameById('nova-1', models)).toBe('Nova One');
  });

  it('keeps hidden and superseded models behind Show all', () => {
    const shown = visibleModels('codex', models, undefined).map((m) => m.id);
    expect(shown).not.toContain('internal-eval');
    expect(shown).not.toContain('gpt-6-sol');
    expect(models.find((m) => m.id === 'internal-eval')?.picker).toBe(false);
  });

  it("lets the user's own choice win either way", () => {
    const shown = visibleModels('codex', models, { 'codex:gpt-6-sol': true, 'codex:nova-1': false }).map((m) => m.id);
    expect(shown).toContain('gpt-6-sol');
    expect(shown).not.toContain('nova-1');
  });

  it('dedupes an alias of an offered model', () => {
    const claude: ModelInfo[] = [
      { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday tasks', picker: true },
      { id: 'opus', name: 'Opus', description: 'Opus 5.5 · Best for everyday tasks', picker: true },
      { id: 'claude-next-6', name: 'Next 6', picker: true },
    ];
    expect(visibleModels('claude', claude, undefined).map((m) => m.id)).toEqual(['opus', 'claude-next-6']);
  });
});

describe('speeds', () => {
  const tiers = codexSpeeds({
    serviceTiers: [
      { id: 'default', name: 'Standard', description: '' },
      { id: 'priority', name: 'Fast', description: 'Faster responses. Uses credits faster.' },
      { id: 'ultrafast', name: 'Ultrafast', description: 'Fastest.' },
    ],
  });
  const model: ModelInfo = { id: 'gpt', name: 'GPT', speeds: tiers };
  const plain: ModelInfo = { id: 'mini', name: 'Mini' };

  it("reads Codex's service tiers, without standard, with a cost note only where it costs more", () => {
    expect(tiers.map((t) => t.id)).toEqual(['priority', 'ultrafast']);
    expect(tiers[0].note).toBe('Faster responses');
    expect(tiers[1].note).toBeUndefined();
  });

  it('Codex receives the tier on the turn, null for standard, nothing when never chosen', () => {
    expect(serviceTierFor(model, 'ultrafast')).toBe('ultrafast');
    expect(serviceTierFor(model, 'standard')).toBeNull();
    expect(serviceTierFor(plain, 'ultrafast')).toBeNull();
    expect(serviceTierFor(model, undefined)).toBeUndefined();
  });

  it('Claude Code starts with fast mode only when the session chose it (its own saved /fast never carries over)', () => {
    expect(startSettings({ speed: 'fast' })).toEqual({ fastMode: true });
    expect(startSettings({ speed: 'standard', ultracode: true })).toEqual({ ultracode: true, fastMode: false });
    expect(startSettings({})).toEqual({ fastMode: false });
  });

  it('a model without the speed falls back to standard; /fast toggles the fastest', () => {
    expect(speedFor(plain, 'priority')).toBe('standard');
    expect(speedFor(model, 'priority')).toBe('priority');
    expect(toggledSpeed(model, 'standard')).toBe('ultrafast');
    expect(toggledSpeed(model, 'priority')).toBe('standard');
    expect(toggledSpeed(plain, undefined)).toBe('standard');
  });
});

describe('a session switches speed', () => {
  const temps: string[] = [];
  const apps: App[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.dispose();
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('applies a speed the model offers, hides one it does not, and falls back on a model switch', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-speed-'));
    temps.push(home);
    const app = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true, userHome: home });
    apps.push(app);
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), model: 'demo-large' });
    const id = snap.session.id;
    const rt = app.runtime(id);
    // One short turn starts the agent, which brings the model list.
    await app.call('session.send', { sessionId: id, text: 'hi' });
    for (let t0 = Date.now(); !rt.caps || rt.turnActive; ) {
      if (Date.now() - t0 > 4000) throw new Error('the demo turn did not end');
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await app.call('session.setSpeed', { sessionId: id, speed: 'ultrafast' })).speed).toBe('ultrafast');
    expect(app.sessions.get(id)?.meta.fast).toBe(true);
    // Demo Fast offers no speeds: switching to it drops back to standard.
    await app.call('session.setModel', { sessionId: id, model: 'demo-fast' });
    expect(app.sessions.get(id)?.meta.speed).toBe('standard');
    expect((await app.call('session.setSpeed', { sessionId: id, speed: 'fast' })).speed).toBe('standard');
  });
});

describe('at a limit', () => {
  it('decides credits, then the next account, then stop, in every combination', () => {
    for (const creditsAllowed of [false, true])
      for (const avail of [false, true])
        for (const continueAtLimit of [false, true])
          for (const next of [undefined, 'b']) {
            const d = decideAtLimit({ creditsAllowed, creditsAvailable: avail, continueAtLimit, next });
            const want = creditsAllowed && avail ? 'credits' : continueAtLimit && next ? 'next' : 'stop';
            expect(d, JSON.stringify({ creditsAllowed, avail, continueAtLimit, next })).toBe(want);
          }
  });

  it('knows when credits can carry an account and when they do', () => {
    expect(creditsAvailable({ extra: { enabled: true, used: 100, limit: 5000 } })).toBe(true);
    expect(creditsAvailable({ extra: { enabled: true, used: 5000, limit: 5000 } })).toBe(false);
    expect(creditsAvailable({ extra: { enabled: false } })).toBe(false);
    expect(creditsAvailable({ credits: { balance: '0' } })).toBe(false);
    expect(creditsAvailable({ credits: { balance: '12.5' } })).toBe(true);
    expect(creditsAvailable({ credits: { unlimited: true } })).toBe(true);
    expect(creditsAvailable(undefined)).toBe(false);
    expect(runningOnCredits({ credits: { has: true, inUse: true } })).toBe(true);
    expect(runningOnCredits({ extra: { enabled: true } })).toBe(false);
  });
});

describe('reset notifications', () => {
  const now = 1_000_000;
  const win = (id: string, percent: number, resetsAt?: number): RateLimit => ({ id, label: id, percent, resetsAt });
  const accounts = [
    { provider: 'claude' as const, accountId: 'default', limits: [win('five_hour', 100, now + 60_000), win('seven_day', 40, now + 30_000)] },
    { provider: 'codex' as const, accountId: 'work', limits: [win('codex:primary', 100, now + 20_000), win('codex:secondary', 100, now - 5_000)] },
  ];

  it('fires at the earliest reset of a full window still ahead', () => {
    expect(nextResetAlert(accounts, now)).toEqual({ at: now + 20_000, provider: 'codex', accountId: 'work', window: 'codex:primary' });
    // A window with room never alerts, nor one whose reset has passed.
    expect(nextResetAlert(accounts, now + 20_000)?.at).toBe(now + 60_000);
    expect(nextResetAlert(accounts, now + 60_000)).toBeUndefined();
  });

  it('announces each reset once, in order, when the timer fires late', () => {
    expect(dueResets(accounts, now, now + 10_000)).toEqual([]);
    expect(dueResets(accounts, now, now + 70_000).map((r) => r.window)).toEqual(['codex:primary', 'five_hour']);
    expect(dueResets(accounts, now + 70_000, now + 90_000)).toEqual([]);
  });
});
