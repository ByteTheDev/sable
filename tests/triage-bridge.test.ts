/** app.hello lists every session's open prompts, so a window sees what waits without loading each timeline. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppState, SessionSnapshot } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';

let app: App;
let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'sable-triage-'));
  app = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true, userHome: home });
});

afterAll(async () => {
  await app?.dispose();
  rmSync(home, { recursive: true, force: true });
});

/** Asks app.hello until its prompts satisfy `pred`. */
async function helloUntil(pred: (h: AppState) => boolean, ms = 10_000): Promise<AppState> {
  const end = Date.now() + ms;
  for (;;) {
    const h = (await app.call('app.hello', {})) as AppState;
    if (pred(h)) return h;
    if (Date.now() > end) throw new Error('timed out waiting for app.hello');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('pending prompts in app.hello', () => {
  it('lists a waiting permission of a session, and drops it once answered', async () => {
    const call = <T>(method: string, params: unknown) => app.call(method as never, params as never) as Promise<T>;
    const empty = await call<AppState>('app.hello', {});
    expect(empty.prompts).toEqual({ permissions: [], questions: [] });

    const snap = await call<SessionSnapshot>('session.create', { provider: 'demo', cwd: path.join(home, 'relay-api'), mode: 'default' });
    const id = snap.session.id;
    await call('session.send', { sessionId: id, text: 'refactor the session module' });
    const hello = await helloUntil((h) => (h.prompts?.permissions.length ?? 0) > 0);
    const req = hello.prompts!.permissions[0];
    expect(req).toMatchObject({ sessionId: id, kind: 'edit' });

    await call('permission.respond', { sessionId: id, requestId: req.id, optionId: 'deny' });
    await helloUntil((h) => !h.prompts?.permissions.some((p) => p.id === req.id));
    await call('session.interrupt', { sessionId: id }).catch(() => {});
  });
});
