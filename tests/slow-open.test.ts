/**
 * An agent that takes long to start (Codex's thread start can take most of a minute): the new
 * session answers early, the first message shows at once and goes out once the agent is there.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeEvent } from '@shared/protocol';
import { App } from '../server/app';
import type { SessionRuntime } from '../server/core/runtime';
import { DemoProvider } from '../server/providers/demo';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class SlowDemo extends DemoProvider {
  override async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }) {
    await sleep(2500);
    return super.open(rt, opts);
  }
}

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('a slow agent start', () => {
  it('answers session.create early and shows the first message while the agent starts', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-slow-'));
    homes.push(home);
    const app = new App({ home, providers: [(ctx) => new SlowDemo(ctx, { speed: 0 })], quiet: true });
    const statuses: string[] = [];
    app.subscribe((e: BridgeEvent) => {
      if (e.type === 'session.updated' && e.patch.status) statuses.push(e.patch.status);
    });
    const t0 = Date.now();
    const snap = await app.call('session.create', { provider: 'demo', cwd: home });
    expect(Date.now() - t0).toBeLessThan(2300);
    expect(snap.session.status).toBe('starting');

    const sending = app.call('session.send', { sessionId: snap.session.id, text: 'hi' });
    await sleep(50);
    const rt = app.runtime(snap.session.id);
    expect(rt.items.some((i) => i.type === 'user' && i.text === 'hi')).toBe(true);
    expect(rt.meta.status).toBe('starting');

    await sending;
    for (let i = 0; i < 100 && !rt.items.some((x) => x.type === 'turn'); i++) await sleep(50);
    expect(rt.items.some((x) => x.type === 'turn')).toBe(true);
    // Never "idle" between the start and the first turn.
    expect(statuses.indexOf('running')).toBeGreaterThanOrEqual(0);
    expect(statuses.slice(0, statuses.indexOf('running'))).not.toContain('idle');
    expect(rt.items.filter((x) => x.type === 'user')).toHaveLength(1);
    await app.dispose();
  });

  it('does not start the agent for a session closed while it was starting', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-slow-'));
    homes.push(home);
    const app = new App({ home, providers: [(ctx) => new SlowDemo(ctx, { speed: 0 })], quiet: true });
    const snap = await app.call('session.create', { provider: 'demo', cwd: home });
    const rt = app.runtime(snap.session.id);
    const sending = app.call('session.send', { sessionId: snap.session.id, text: 'hi' });
    await app.call('session.close', { sessionId: snap.session.id, remove: true });
    await sending;
    await sleep(1500);
    expect(rt.handle).toBeUndefined();
    expect(rt.items.some((x) => x.type === 'turn')).toBe(false);
    await app.dispose();
  });
});
