import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { App } from '../app';
import { fsSearch } from './fs';

/**
 * Files named in the conversation, made clickable:
 * - `fs.resolve` finds which of an answer's file-like words are real files (relative to the
 *   session's folder, or by name inside it);
 * - `fs.share` hands the Browser tab a URL for one (pages, images, video, PDFs);
 * - `fs.open` opens one with the system's default app, or shows it in the file manager.
 *
 * Shared files are served by a server of their own on another port, never by the app's server:
 * a page from the user's project must not be same-origin with Sable (the bridge, which reads files
 * and runs commands, accepts same-origin pages). Each share is a random token for one folder, so a
 * page's own relative assets load and nothing outside that folder can be reached.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

const MAX_NAMES = 60;
const MAX_SHARES = 200;

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const inside = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

export class FileShare {
  private server?: Server;
  private port?: Promise<number>;
  private roots = new Map<string, string>();
  private byRoot = new Map<string, string>();

  /** A URL for `file` in the Browser tab: its folder (or `root`, when the file is inside it) shared under one token. */
  async share(file: string, root?: string): Promise<string> {
    const abs = path.resolve(file);
    if (!isFile(abs)) throw new Error(`Not a file: ${abs}`);
    const base = root && inside(path.resolve(root), abs) ? path.resolve(root) : path.dirname(abs);
    let token = this.byRoot.get(base.toLowerCase());
    if (!token) {
      token = randomBytes(16).toString('hex');
      if (this.roots.size >= MAX_SHARES) {
        const [oldest] = this.roots.keys();
        this.byRoot.delete(this.roots.get(oldest)!.toLowerCase());
        this.roots.delete(oldest);
      }
      this.roots.set(token, base);
      this.byRoot.set(base.toLowerCase(), token);
    }
    const port = await this.listen();
    const rel = path.relative(base, abs).split(path.sep).map(encodeURIComponent).join('/');
    return `http://127.0.0.1:${port}/${token}/${rel}`;
  }

  private listen(): Promise<number> {
    this.port ??= new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => this.serve(req.method ?? 'GET', req.url ?? '/', req.headers.range, res));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
      this.server = server;
    });
    return this.port;
  }

  private serve(method: string, url: string, range: string | undefined, res: import('node:http').ServerResponse) {
    if (method !== 'GET' && method !== 'HEAD') return void res.writeHead(405, { allow: 'GET, HEAD' }).end();
    let parts: string[];
    try {
      parts = new URL(url, 'http://localhost').pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return void res.writeHead(400).end();
    }
    const root = this.roots.get(parts[0] ?? '');
    if (!root) return void res.writeHead(404).end();
    const file = path.resolve(root, ...parts.slice(1));
    if (!inside(root, file) || !isFile(file)) return void res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    const size = statSync(file).size;
    const headers: Record<string, string | number> = {
      'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    };
    // Video and audio seek with ranges.
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      if (start > end || start >= size) return void res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      if (method === 'HEAD') return void res.end();
      return void createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': size });
    if (method === 'HEAD') return void res.end();
    createReadStream(file).pipe(res);
  }

  close() {
    this.server?.close();
    this.server = undefined;
    this.port = undefined;
    this.roots.clear();
    this.byRoot.clear();
  }
}

/** Which of `names` are files: as a path from `cwd`, else by name inside `cwd` (one clear match only). */
export async function resolveFiles(cwd: string, names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const root = path.resolve(cwd);
  for (const raw of names.slice(0, MAX_NAMES)) {
    const name = raw.trim().replace(/^["'`(]+|["'`),.:;]+$/g, '');
    if (!name || name.length > 260 || /^[a-z][a-z0-9+.-]*:\/\//i.test(name)) continue;
    const direct = path.isAbsolute(name) ? path.resolve(name) : path.resolve(root, name);
    if (isFile(direct)) {
      out[raw] = direct;
      continue;
    }
    // A bare name ("Rangefinder.mp4") or a path from somewhere inside the folder: find it there.
    const want = name.replace(/\\/g, '/').toLowerCase();
    try {
      const hits = (await fsSearch(root, name, 8)).filter((h) => !h.dir);
      const exact = hits.filter((h) => h.rel.toLowerCase() === want || h.rel.toLowerCase().endsWith(`/${want}`));
      if (exact.length === 1) {
        out[raw] = exact[0].path;
        continue;
      }
      if (exact.length > 1) continue;
    } catch {
      /* not a folder we can search */
    }
    // The file index leaves build output out (dist, out, build): where rendered files often land.
    const found = await findInOutput(root, want);
    if (found) out[raw] = found;
  }
  return out;
}

const OUTPUT_DIRS = ['out', 'dist', 'build', 'output', 'outputs', 'renders', 'render', 'export', 'exports', 'public'];

/** A file named `want` (a name or a tail of a path) in the folder's usual output folders, two levels deep at most. */
async function findInOutput(root: string, want: string): Promise<string | undefined> {
  const { readdir } = await import('node:fs/promises');
  const hits: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.slice(0, 2000)) {
      const p = path.join(dir, e.name);
      const rel = e.isFile() ? path.relative(root, p).replace(/\\/g, '/').toLowerCase() : '';
      if (rel && (rel === want || rel.endsWith(`/${want}`))) hits.push(p);
      else if (e.isDirectory() && depth < 2 && e.name !== 'node_modules' && !e.name.startsWith('.')) await walk(p, depth + 1);
      if (hits.length > 1) return;
    }
  };
  for (const d of OUTPUT_DIRS) {
    await walk(path.join(root, d), 0);
    if (hits.length > 1) return undefined;
  }
  return hits.length === 1 ? hits[0] : undefined;
}

/** Opens a file with the system's default app, or shows it selected in the file manager. */
export async function openFile(file: string, reveal: boolean): Promise<void> {
  const abs = path.resolve(file);
  if (!isFile(abs)) throw new Error(`Not a file: ${abs}`);
  // Inside the desktop app the shell does it properly (and reports a missing handler).
  if (process.versions.electron) {
    const { shell } = await import('electron');
    if (reveal) return void shell.showItemInFolder(abs);
    const err = await shell.openPath(abs);
    if (err) throw new Error(err);
    return;
  }
  const [cmd, args] =
    process.platform === 'win32'
      ? ['explorer.exe', reveal ? [`/select,"${abs}"`] : [abs]]
      : process.platform === 'darwin'
        ? ['open', reveal ? ['-R', abs] : [abs]]
        : ['xdg-open', [reveal ? path.dirname(abs) : abs]];
  spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' && reveal }).unref();
}

export function registerFiles(app: App) {
  const share = new FileShare();
  app.register('fs.resolve', ({ cwd, names }) => resolveFiles(cwd, Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []));
  app.register('fs.share', async ({ path: p, root }) => ({ url: await share.share(p, root) }));
  app.register('fs.open', async ({ path: p, reveal }) => {
    await openFile(p, !!reveal);
    return { ok: true };
  });
  app.onDispose(() => share.close());
}
