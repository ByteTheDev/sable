/**
 * Fixes from checking the provider wiring against real Claude Code and Codex turns (16 Nov). The
 * shapes below are the ones those turns sent; no real agent runs here.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type BridgeEvent, type RateLimit, type SessionMeta, type TimelineItem } from '@shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import { transcript } from '../server/providers/codex-map';
import { WIDGET_DESCRIPTION, WIDGET_SHOWN, dynamicToolAnswer, widgetResult } from '../server/providers/widget-tool';

const ctx = (events: BridgeEvent[] = []) => ({ emit: (e: BridgeEvent) => events.push(e), log: () => {}, settings: () => DEFAULT_SETTINGS });

function runtime(provider: SessionMeta['provider']) {
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider, cwd: process.cwd(), title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  return new SessionRuntime(meta, () => {}, () => {});
}

/** A Codex session on a fake app-server: thread/start answers, everything else is empty. */
async function codexSession() {
  const p = new CodexProvider(ctx());
  const rpc = { request: async (method: string) => (method === 'thread/start' ? { thread: { id: 'th1', model: 'm' }, model: 'm' } : {}) };
  const anyP = p as unknown as { client: () => Promise<unknown>; caps: () => Promise<unknown> };
  anyP.client = async () => rpc;
  anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '$', features: {} });
  const rt = runtime('codex');
  await p.open(rt, {});
  const s = p.sessions.get('th1') as unknown as { onNotification: (m: string, p: unknown) => void };
  return { rt, s };
}

const agentMessage = (text: string) => ({ type: 'agentMessage', id: 'msg1', text, phase: 'final_answer', startedAtMs: 1, completedAtMs: text ? 2 : null });

describe('Codex: an empty final reply leaves nothing behind', () => {
  // Seen live: after show_widget the model ended the turn with an agentMessage of "" (4 tokens).
  it('removes the empty text item the started event created', async () => {
    const { rt, s } = await codexSession();
    s.onNotification('item/started', { threadId: 'th1', turnId: 't1', item: agentMessage('') });
    expect(rt.items.some((i) => i.type === 'text')).toBe(true);
    s.onNotification('item/completed', { threadId: 'th1', turnId: 't1', item: { ...agentMessage(''), completedAtMs: 2 } });
    expect(rt.items.some((i) => i.type === 'text')).toBe(false);
  });

  it('keeps a reply whose text streamed in deltas, and adds no item for one that only completes empty', async () => {
    const { rt, s } = await codexSession();
    s.onNotification('item/started', { threadId: 'th1', turnId: 't1', item: agentMessage('') });
    s.onNotification('item/agentMessage/delta', { threadId: 'th1', turnId: 't1', itemId: 'msg1', delta: 'Done.' });
    s.onNotification('item/completed', { threadId: 'th1', turnId: 't1', item: { ...agentMessage(''), completedAtMs: 2 } });
    expect(rt.items.filter((i) => i.type === 'text').map((i) => (i as { text: string }).text)).toEqual(['Done.']);
    s.onNotification('item/completed', { threadId: 'th1', turnId: 't2', item: { ...agentMessage(''), id: 'msg2', completedAtMs: 2 } });
    expect(rt.items.filter((i) => i.type === 'text')).toHaveLength(1);
  });

  it('drops it from a loaded transcript too', () => {
    const items = transcript([
      {
        id: 't1',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
        items: [
          { type: 'dynamicToolCall', id: 'c1', namespace: null, tool: 'show_widget', arguments: { title: 'Chart', code: '<svg/>' }, status: 'completed', contentItems: [], success: true },
          agentMessage(''),
        ],
      },
    ] as never);
    expect(items.map((i: TimelineItem) => i.type)).toEqual(['tool', 'turn']);
  });
});

describe('Codex: a resumed session takes a title', () => {
  async function resumed(thread: Record<string, unknown>, turns: unknown[], title = 'New session') {
    const p = new CodexProvider(ctx());
    const rpc = {
      request: async (method: string) =>
        method === 'thread/resume' ? { thread: { id: 'th9', model: 'm', ...thread }, model: 'm' } : method === 'thread/turns/list' ? { data: turns, nextCursor: null } : {},
    };
    const anyP = p as unknown as { client: () => Promise<unknown>; caps: () => Promise<unknown> };
    anyP.client = async () => rpc;
    anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '$', features: {} });
    const rt = runtime('codex');
    rt.update({ providerSessionId: 'th9', title });
    await p.open(rt, { loadTranscript: true });
    return rt.meta.title;
  }
  const turn = { id: 't1', status: 'completed', startedAt: 1, completedAt: 2, items: [{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Show a bar chart\nof three numbers' }] }] };

  it('uses the first prompt when the thread has no name', async () => {
    expect(await resumed({ name: null, preview: '' }, [turn])).toBe('Show a bar chart');
  });
  it('prefers the thread name, and keeps a title it was given', async () => {
    expect(await resumed({ name: 'Charts', preview: '' }, [turn])).toBe('Charts');
    expect(await resumed({ name: null, preview: '' }, [turn], 'From history')).toBe('From history');
  });
});

describe('the show_widget wording', () => {
  it('tells the agent the frame is there and to fill the width', () => {
    expect(WIDGET_DESCRIPTION).toContain('no outer card, border or background');
    expect(WIDGET_DESCRIPTION).toContain('use the full width');
    expect(WIDGET_DESCRIPTION).toContain('width="100%"');
  });
  it('answers both agents the same: shown, do not describe or repeat it', () => {
    expect(widgetResult({ title: 'T', code: '<svg/>' }).text).toBe(WIDGET_SHOWN);
    expect(dynamicToolAnswer({ tool: 'show_widget', arguments: { title: 'T', code: '<svg/>' } }).contentItems[0].text).toBe(WIDGET_SHOWN);
    expect(WIDGET_SHOWN).toMatch(/now sees the widget/);
    expect(WIDGET_SHOWN).toMatch(/not describe it or repeat its values/);
  });
});

describe('Claude: plan limits from rate_limit_event', () => {
  // The event a real turn sent: one weekly window, utilization 0..1, reset in epoch seconds.
  const live = { status: 'allowed', resetsAt: 1795302000, rateLimitType: 'seven_day', overageStatus: 'rejected', isUsingOverage: false, unifiedWindows: { seven_day: { utilization: 0.21, resetsAt: 1795302000, status: 'allowed' } } };

  it('reads the window the CLI sends', () => {
    const events: BridgeEvent[] = [];
    const p = new ClaudeProvider(ctx(events));
    expect(p.onRateLimit(live)).toBeUndefined();
    const up = events.find((e) => e.type === 'limits.updated') as Extract<BridgeEvent, { type: 'limits.updated' }>;
    expect(up.limits).toEqual([{ id: 'seven_day', label: 'Weekly · all models', percent: 21, resetsAt: 1795302000_000, windowMins: 10_080 }]);
    expect(up.meta).toEqual({ planLimits: true });
  });

  it('keeps windows it has no name for, labelled by their length', () => {
    const events: BridgeEvent[] = [];
    const p = new ClaudeProvider(ctx(events));
    p.onRateLimit({ ...live, unifiedWindows: { ...live.unifiedWindows, seven_day_fable: { utilization: 0.5, resetsAt: 1795302000 }, five_hour_extra: { utilization: 0.1, resetsAt: 1795302000 }, mystery: { utilization: 0.3 } } });
    const up = events.at(-1) as Extract<BridgeEvent, { type: 'limits.updated' }>;
    expect(up.limits.map((l) => [l.id, l.label, l.percent, l.windowMins])).toEqual([
      ['seven_day', 'Weekly · all models', 21, 10_080],
      ['five_hour_extra', '5-hour limit · Extra', 10, 300],
      ['seven_day_fable', 'Weekly · Fable', 50, 10_080],
    ]);
  });

  it('keeps a remembered window whose reset has passed as rolled over (empty, no reset) when newer windows arrive', () => {
    const events: BridgeEvent[] = [];
    const p = new ClaudeProvider(ctx(events));
    const stale: RateLimit = { id: 'five_hour', label: '5-hour limit', percent: 80, resetsAt: Date.now() - 60_000, windowMins: 300 };
    (p as unknown as { limitsCache: RateLimit[] }).limitsCache = [stale];
    p.onRateLimit(live);
    const up = events.at(-1) as Extract<BridgeEvent, { type: 'limits.updated' }>;
    expect(up.limits.map((l) => l.id)).toEqual(['five_hour', 'seven_day']);
    expect(up.limits[0]).toMatchObject({ percent: 0, resetsAt: undefined });
  });
});
