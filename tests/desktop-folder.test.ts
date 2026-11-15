import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { pickFolder, startFolder, type FolderDialogOptions } from '../electron/folder';

const dir = mkdtempSync(path.join(tmpdir(), 'sable-folder-'));
const file = path.join(dir, 'note.txt');
writeFileSync(file, 'x');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('native folder dialog', () => {
  it('starts in the suggested folder only when it is an existing absolute folder', () => {
    expect(startFolder(dir)).toBe(path.resolve(dir));
    expect(startFolder(file)).toBeUndefined();
    expect(startFolder('relative/path')).toBeUndefined();
    expect(startFolder(path.join(dir, 'missing'))).toBeUndefined();
    expect(startFolder(42)).toBeUndefined();
    expect(startFolder(`${dir}\0evil`)).toBeUndefined();
  });

  it('asks for a folder and returns the choice', async () => {
    const show = vi.fn(async (_o: FolderDialogOptions) => ({ canceled: false, filePaths: [dir] }));
    await expect(pickFolder(show, dir)).resolves.toBe(path.resolve(dir));
    const opts = show.mock.calls[0][0];
    expect(opts.properties).toContain('openDirectory');
    expect(opts.defaultPath).toBe(path.resolve(dir));
  });

  it('returns null when cancelled or when the answer is not a folder', async () => {
    await expect(pickFolder(async () => ({ canceled: true, filePaths: [] }), dir)).resolves.toBeNull();
    await expect(pickFolder(async () => ({ canceled: false, filePaths: [file] }), dir)).resolves.toBeNull();
    await expect(pickFolder(async () => ({ canceled: false, filePaths: [] }), 'nope')).resolves.toBeNull();
  });
});
