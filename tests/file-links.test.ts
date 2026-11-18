/** Files named in answers: which words count, how they resolve, and how a shared file is served. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileCandidates } from '@/lib/file-words';
import { FileShare, resolveFiles } from '../server/services/files';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project() {
  const root = mkdtempSync(path.join(tmpdir(), 'sable-files-'));
  dirs.push(root);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'out'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'app.ts'), 'export {}');
  writeFileSync(path.join(root, 'out', 'Rangefinder-Cinematic.mp4'), Buffer.alloc(4096, 1));
  writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>');
  return root;
}

describe('file words', () => {
  it('finds file-like words and leaves URLs, versions and common words alone', () => {
    const text = 'Rendered `out/Rangefinder-Cinematic.mp4` from src/app.ts, e.g. with node.js 22.1.0. See https://example.com/a.html and example.com.\n```\nnot.this\n```';
    expect(fileCandidates(text)).toEqual(['out/Rangefinder-Cinematic.mp4', 'src/app.ts']);
  });
});

describe('resolveFiles', () => {
  it('resolves paths from the folder and bare names found inside it', async () => {
    const root = project();
    const found = await resolveFiles(root, ['src/app.ts', 'Rangefinder-Cinematic.mp4', 'missing.ts', 'https://x.dev/a.js']);
    expect(found).toEqual({ 'src/app.ts': path.join(root, 'src', 'app.ts'), 'Rangefinder-Cinematic.mp4': path.join(root, 'out', 'Rangefinder-Cinematic.mp4') });
  });
});

describe('FileShare', () => {
  it('serves a shared file and its folder, with ranges, and nothing outside', async () => {
    const root = project();
    const share = new FileShare();
    try {
      const url = await share.share(path.join(root, 'out', 'Rangefinder-Cinematic.mp4'), root);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/out\/Rangefinder-Cinematic\.mp4$/);
      const full = await fetch(url);
      expect(full.headers.get('content-type')).toBe('video/mp4');
      expect((await full.arrayBuffer()).byteLength).toBe(4096);
      const part = await fetch(url, { headers: { range: 'bytes=100-199' } });
      expect(part.status).toBe(206);
      expect((await part.arrayBuffer()).byteLength).toBe(100);
      // A sibling in the shared folder loads (a page's own assets); a way out does not.
      const base = url.slice(0, url.indexOf('/out/'));
      expect((await fetch(`${base}/index.html`)).status).toBe(200);
      expect((await fetch(`${base}/..%2F..%2Fwindows%2Fwin.ini`)).status).toBe(404);
      expect((await fetch(url.replace(/[0-9a-f]{32}/, '0'.repeat(32)))).status).toBe(404);
    } finally {
      share.close();
    }
  });
});
