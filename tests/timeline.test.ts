import { describe, expect, it } from 'vitest';
import type { TimelineItem, ToolItem } from '@shared/protocol';
import { steadyTail } from '@/features/timeline/smooth';
import { changesOf } from '@/features/timeline/changes';

describe('steadyTail', () => {
  it('holds a last line that is only a marker', () => {
    expect(steadyTail('Intro\n- ')).toBe('Intro\n');
    expect(steadyTail('Intro\n12.')).toBe('Intro\n');
    expect(steadyTail('Intro\n## ')).toBe('Intro\n');
    expect(steadyTail('Intro\n- item')).toBe('Intro\n- item');
    expect(steadyTail('plain text')).toBe('plain text');
  });

  it('shows a table once its header and divider are in, then whole rows', () => {
    expect(steadyTail('Text\n| a | b')).toBe('Text\n');
    expect(steadyTail('Text\n| a | b |\n')).toBe('Text\n');
    expect(steadyTail('Text\n| a | b |\n|---|--')).toBe('Text\n');
    expect(steadyTail('Text\n| a | b |\n|---|---|\n')).toBe('Text\n| a | b |\n|---|---|\n');
    expect(steadyTail('Text\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3')).toBe('Text\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    expect(steadyTail('| a |\n|---|\n| 1 |\n\nAfter')).toBe('| a |\n|---|\n| 1 |\n\nAfter');
  });
});

describe('changesOf', () => {
  const tool = (id: string, kind: ToolItem['kind'], extra: Partial<ToolItem> = {}): ToolItem => ({ id, ts: 0, type: 'tool', name: kind, kind, title: kind, status: 'done', detail: {}, ...extra });
  const diff = (path: string, additions: number, deletions: number) => ({ path, status: 'modified' as const, additions, deletions, hunks: [] });

  it('counts distinct files and every line, sub-agents included, finished edits only', () => {
    const items: Record<string, TimelineItem> = {
      a: tool('a', 'edit', { result: { diff: [diff('src/a.ts', 3, 1)] } }),
      b: tool('b', 'edit', { result: { diff: [diff('src/a.ts', 2, 0)] } }),
      c: tool('c', 'write', { result: { diff: [diff('src/b.ts', 10, 0)] } }),
      d: tool('d', 'edit', { status: 'denied', result: { diff: [diff('src/c.ts', 5, 5)] } }),
      e: tool('e', 'agent'),
      f: tool('f', 'edit', { parentId: 'e', result: { diff: [diff('src/d.ts', 1, 4)] } }),
      g: tool('g', 'read'),
    };
    expect(changesOf(items, { e: ['f'] }, ['a', 'b', 'c', 'd', 'e', 'g'])).toEqual({ files: 3, add: 16, del: 5 });
    expect(changesOf(items, {}, ['g'])).toEqual({ files: 0, add: 0, del: 0 });
  });
});
