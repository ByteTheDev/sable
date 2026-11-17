/**
 * Codex's warnings about its own setup ("Codex is ignoring 2 unrecognized configuration settings")
 * go to the agent's status in Settings › Agents, once per app run, never into a conversation; and
 * a notice is never counted as a step of a turn. Fake app-server only.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type BridgeEvent, type SessionMeta } from '@shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { CodexProvider, isSetupWarning } from '../server/providers/codex';
import { groupTurns } from '@/features/timeline/turns';

const CONFIG_WARNING =
  'Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.\n' +
  'user (config.toml): `computer_use.windows.always_allowed_app_ids` is ignored.\n' +
  'user (config.toml): `features.remote_connections` is ignored.';

async function codexSession(events: BridgeEvent[]) {
  const p = new CodexProvider({ emit: (e: BridgeEvent) => events.push(e), log: () => {}, settings: () => DEFAULT_SETTINGS });
  const rpc = {
    request: async (method: string) =>
      method === 'thread/start' ? { thread: { id: 'th1', model: 'm' }, model: 'm' } : method === 'account/read' ? { account: { type: 'apiKey' }, requiresOpenaiAuth: true } : {},
  };
  const anyP = p as unknown as { client: () => Promise<unknown>; caps: () => Promise<unknown>; version: () => Promise<unknown>; onNotification: (m: string, p: unknown) => void };
  anyP.client = async () => rpc;
  anyP.version = async () => ({ installed: true, version: '1' });
  anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '$', features: {} });
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider: 'codex', cwd: process.cwd(), title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const rt = new SessionRuntime(meta, () => {}, () => {});
  await p.open(rt, {});
  return { p, rt, notify: anyP.onNotification.bind(p) };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('Codex setup warnings', () => {
  it('tells config warnings from a thread’s own', () => {
    expect(isSetupWarning({ threadId: 'th1', message: CONFIG_WARNING })).toBe(true);
    expect(isSetupWarning({ threadId: null, message: 'anything' })).toBe(true);
    expect(isSetupWarning({ threadId: 'th1', message: 'The command output was truncated' })).toBe(false);
  });

  it('keeps the config warning out of the timeline and reports it once on the agent', async () => {
    const events: BridgeEvent[] = [];
    const { p, rt, notify } = await codexSession(events);
    notify('warning', { threadId: 'th1', message: CONFIG_WARNING });
    notify('warning', { threadId: 'th1', message: CONFIG_WARNING });
    await flush();
    expect(rt.items.some((i) => i.type === 'notice')).toBe(false);
    const updates = events.filter((e) => e.type === 'provider.updated');
    expect(updates).toHaveLength(1);
    const info = await p.info();
    expect(info.warnings).toHaveLength(1);
    expect(info.warnings![0].text).toMatch(/ignoring 2 unrecognized configuration settings/);
    expect(info.warnings![0].detail).toMatch(/features\.remote_connections/);
  });

  it('a configWarning notification lands there too, and a thread warning still shows in its timeline', async () => {
    const events: BridgeEvent[] = [];
    const { p, rt, notify } = await codexSession(events);
    notify('configWarning', { summary: 'Invalid value for model_reasoning_effort', details: 'expected one of low, medium, high' });
    await flush();
    expect((await p.info()).warnings?.some((w) => /model_reasoning_effort/.test(w.text))).toBe(true);
    notify('warning', { threadId: 'th1', message: 'The patch could not be applied to one file' });
    expect(rt.items.filter((i) => i.type === 'notice')).toHaveLength(1);
  });
});

describe('A notice is never a step', () => {
  it('a turn whose only extra item is a notice counts no steps', () => {
    // U: "hey", n: a notice, t: the answer, T: turn end.
    const { groups } = groupTurns(['1', '2', '3', '4'], 'UntT', false);
    const turn = groups[0];
    expect(turn.kind).toBe('turn');
    if (turn.kind !== 'turn') return;
    expect(turn.segments[0].steps).toBe(0);
    expect(turn.segments[0].answer).toBe('3');
  });

  it('tool calls still count, notices between them do not', () => {
    const { groups } = groupTurns(['1', '2', '3', '4', '5', '6'], 'UwnwtT', false);
    const turn = groups[0];
    if (turn.kind !== 'turn') throw new Error('not a turn');
    expect(turn.segments[0].steps).toBe(2);
  });
});
