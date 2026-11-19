import { describe, expect, it } from 'vitest';
import type { ToolItem } from '../shared/protocol';
import { SessionRuntime } from '../server/core/runtime';

const tool = (over: Partial<ToolItem>): ToolItem => ({ id: over.id ?? 'x', type: 'tool', ts: 1, name: 'Agent', kind: 'agent', title: 't', status: 'done', detail: {}, ...over }) as ToolItem;

describe('background work whose agent process is gone', () => {
  it('marks sub-agents and workflows still shown as running as stopped, and leaves finished ones alone', () => {
    const rt = new SessionRuntime({ id: 's' } as never, () => {}, () => {});
    rt.load([
      tool({ id: 'bg', result: { agent: { background: 'running' } } as ToolItem['result'] }),
      tool({ id: 'done', result: { agent: { background: 'done' } } as ToolItem['result'] }),
      tool({ id: 'wf', workflow: { status: 'running' } as ToolItem['workflow'] }),
      tool({ id: 'plain', name: 'Read', kind: 'read' as ToolItem['kind'] }),
    ]);
    rt.stopBackground();
    expect(rt.get<ToolItem>('bg')?.result?.agent?.background).toBe('stopped');
    expect(rt.get<ToolItem>('done')?.result?.agent?.background).toBe('done');
    expect(rt.get<ToolItem>('wf')?.workflow?.status).toBe('stopped');
    expect(rt.get<ToolItem>('plain')?.result).toBeUndefined();
  });
});
