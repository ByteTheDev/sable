import { describe, expect, it } from 'vitest';
import { packDrafts, unpackDrafts } from '@/features/composer/drafts';

describe('drafts kept across a restart', () => {
  it('keeps text only, and only drafts with something in them', () => {
    const packed = packDrafts({
      a: { text: 'half a thought', attachments: [{ id: '1', kind: 'image', name: 'x.png', dataUrl: 'data:...' } as never] },
      b: { text: '   ', attachments: [] },
      c: { text: '', attachments: [] },
    });
    expect(packed).toEqual({ a: 'half a thought' });
  });

  it('round-trips through storage', () => {
    const raw = JSON.stringify(packDrafts({ home: { text: 'first\nsecond', attachments: [] }, s1: { text: 'fix the test', attachments: [] } }));
    expect(unpackDrafts(raw)).toEqual({ home: { text: 'first\nsecond', attachments: [] }, s1: { text: 'fix the test', attachments: [] } });
  });

  it('keeps the most recent drafts when there are too many', () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`s${i}`, { text: `t${i}`, attachments: [] }]));
    const packed = packDrafts(many);
    expect(Object.keys(packed)).toHaveLength(40);
    expect(packed.s59).toBe('t59');
    expect(packed.s0).toBeUndefined();
  });

  it('drops what is malformed instead of failing', () => {
    expect(unpackDrafts(null)).toEqual({});
    expect(unpackDrafts('not json')).toEqual({});
    expect(unpackDrafts('[1,2]')).toEqual({});
    expect(unpackDrafts(JSON.stringify({ a: 3, b: 'ok', c: null }))).toEqual({ b: { text: 'ok', attachments: [] } });
  });
});
