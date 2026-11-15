import { describe, expect, it } from 'vitest';
import { readFiles, sameFileKey } from '../src/features/composer/attach';

describe('composer attachments', () => {
  it('sends a desktop file by its real path, whatever its type or size', async () => {
    const big = new File([new Uint8Array(5 * 1024 * 1024)], 'dump.bin', { type: 'application/octet-stream' });
    const { added, refused } = await readFiles([big], { images: true, current: [], pathOf: () => 'C:\work\dump.bin' });
    expect(refused).toBeNull();
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: 'file', name: 'dump.bin', path: 'C:\work\dump.bin' });
  });

  it('ignores the same file dropped twice, in one batch or across drops', async () => {
    const pathOf = (f: File) => `/repo/${f.name}`;
    const a = new File(['x'], 'a.bin');
    const first = await readFiles([a, a], { images: true, current: [], pathOf });
    expect(first.added).toHaveLength(1);
    const again = await readFiles([new File(['x'], 'a.bin')], { images: true, current: first.added, pathOf });
    expect(again.added).toHaveLength(0);
    expect(again.refused).toBeNull();
  });

  it('refuses an unsupported file in the browser with a short reason', async () => {
    const zip = new File([new Uint8Array([80, 75, 3, 4])], 'archive.zip', { type: 'application/zip' });
    const { added, refused } = await readFiles([zip], { images: true, current: [] });
    expect(added).toHaveLength(0);
    expect(refused).toBe('archive.zip is not an image or a text file');
  });

  it('knows a file by its path when it has one, else by name and size', () => {
    expect(sameFileKey({ name: 'a.ts', size: 3, path: 'C:/X/a.ts' })).toBe(sameFileKey({ name: 'other', path: 'c:/x/A.TS' }));
    expect(sameFileKey({ name: 'a.ts', size: 3 })).not.toBe(sameFileKey({ name: 'a.ts', size: 4 }));
  });
});
