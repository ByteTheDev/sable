/**
 * Bypass never waits for a yes: Claude Code's own safety checks that still ask in that mode are
 * answered at once, and switching a chat to Bypass answers the prompts already waiting. Questions
 * still wait for the person. Driven with the Demo agent only.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../server/app';
import { bypassesAsking } from '../server/providers/claude';
import { DemoProvider } from '../server/providers/demo';
import type { Provider, ProviderContext } from '../server/providers/types';

const dirs: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function until(pred: () => boolean, what: string, ms = 8000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const temp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

describe('Bypass answers permission prompts itself', () => {
  it('knows the Claude Code mode that never asks', () => {
    expect(bypassesAsking('bypassPermissions')).toBe(true);
    for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk', undefined]) expect(bypassesAsking(mode)).toBe(false);
  });

  it('answers the prompts already waiting when the chat switches to Bypass', async () => {
    const app = new App({ home: temp('sable-bypass-'), providers: [(ctx: ProviderContext) => new DemoProvider(ctx, { speed: 0 }) as unknown as Provider], quiet: true });
    apps.push(app);
    const { session } = await app.call('session.create', { provider: 'demo', cwd: temp('sable-bypass-cwd-'), mode: 'default' });
    const rt = app.sessions.get(session.id)!;
    await app.call('session.send', { sessionId: session.id, text: 'refactor the session module' });
    await until(() => rt.prompts().permissions.length > 0, 'a permission prompt');

    await app.call('session.setMode', { sessionId: session.id, mode: 'bypassPermissions' });
    expect(rt.prompts().permissions).toHaveLength(0);
    // The turn goes on without another prompt and ends.
    await until(() => rt.meta.status === 'idle' && rt.items.some((i) => i.type === 'turn'), 'the end of the turn', 20000);
    expect(rt.prompts().permissions).toHaveLength(0);
  });
});
