/** Continue in the other agent: a new session that starts from a summary of another one, which stays as it was. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../server/app';
import { handoverText } from '../server/accounts/handover';
import { DemoProvider } from '../server/providers/demo';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function until(pred: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Continue in the other agent', () => {
  it('names the agent the conversation came from', () => {
    const text = handoverText([{ id: 'u', ts: 0, type: 'user', text: 'fix the build' }], { from: 'Claude Code' });
    expect(text).toMatch(/^This continues a conversation the user had with Claude Code/);
    expect(text).toContain('User: fix the build');
  });

  it('starts the new session with a summary of the source and leaves the source untouched', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-continue-'));
    homes.push(home);
    const app = new App({ home, providers: [(c) => new DemoProvider(c, { speed: 0 })], quiet: true });
    apps.push(app);
    const cwd = mkdtempSync(path.join(tmpdir(), 'sable-continue-cwd-'));
    homes.push(cwd);
    const a = await app.call('session.create', { provider: 'demo', cwd });
    await app.call('session.send', { sessionId: a.session.id, text: 'hi' });
    await until(() => !!app.sessions.get(a.session.id)?.items.some((i) => i.type === 'text' && i.text.length > 0) && app.sessions.get(a.session.id)?.meta.status === 'idle', 'the first turn');
    const before = JSON.stringify(app.sessions.get(a.session.id)!.items);

    const b = await app.call('session.create', { provider: 'demo', cwd, handoverFrom: a.session.id });
    const handovers = (app as unknown as { handovers: Map<string, string> }).handovers;
    expect(handovers.get(b.session.id)).toMatch(/User: hi/);
    expect(handovers.get(b.session.id)).toMatch(/with Demo/);
    expect(app.sessions.get(b.session.id)!.items.some((i) => i.type === 'notice' && /Continued from/.test(i.text))).toBe(true);
    expect(JSON.stringify(app.sessions.get(a.session.id)!.items)).toBe(before);
  });
});
