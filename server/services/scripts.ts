import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { PackageManager, ProjectScript, ProjectScripts } from '../../shared/protocol';
import type { App } from '../app';

/**
 * A folder's scripts for the Terminal tab's Run control and the palette: package.json scripts (run
 * with the package manager its lockfile names), the plain targets of a Makefile, and the entry
 * points pyproject.toml declares. Read only when one of their files changed since the last ask (a
 * few stats), so the window can ask whenever it shows the list.
 */

/** Lockfiles in the order they decide, as the brief has it; npm's own files stop the walk up. */
const LOCKS: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];
const MANAGERS = new Set<PackageManager>(['npm', 'pnpm', 'yarn', 'bun']);
const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];
const PY_LOCKS: [string, string][] = [
  ['uv.lock', 'uv'],
  ['poetry.lock', 'poetry'],
  ['pdm.lock', 'pdm'],
];
/** Files larger than this are not read (a generated Makefile, a vendored manifest). */
const MAX_BYTES = 512 * 1024;
const MAX_SCRIPTS = 60;
/** How far up a workspace root is looked for (a package inside a monorepo has its lockfile there). */
const MAX_UP = 6;

/** npm's install, publish and version hooks: they run by themselves, never from a Run menu. */
const LIFECYCLE = new Set([
  'preinstall',
  'install',
  'postinstall',
  'preuninstall',
  'uninstall',
  'postuninstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'prepublishOnly',
  'prepack',
  'postpack',
  'publish',
  'postpublish',
  'preversion',
  'version',
  'postversion',
  'dependencies',
]);

/**
 * The package manager from the lockfiles found in one folder (first match in LOCKS order), else
 * the `packageManager` field of package.json ("pnpm@9.1.0"), else npm.
 */
export function pickManager(lockfiles: readonly string[], packageManagerField?: unknown): PackageManager {
  for (const [file, pm] of LOCKS) if (lockfiles.includes(file)) return pm;
  if (typeof packageManagerField === 'string') {
    const name = packageManagerField.trim().split('@')[0] as PackageManager;
    if (MANAGERS.has(name)) return name;
  }
  return 'npm';
}

/** The nearest folder at or above `cwd` with a lockfile, within the same workspace (each step up needs a package.json). */
export function findLockfiles(cwd: string): { dir: string; files: string[] } | null {
  let dir = cwd;
  for (let i = 0; i <= MAX_UP; i++) {
    const files = LOCKS.map(([f]) => f).filter((f) => existsSync(path.join(dir, f)));
    if (files.length) return { dir, files };
    // A repository's root, or a folder outside a workspace, ends the walk.
    if (existsSync(path.join(dir, '.git'))) return null;
    const parent = path.dirname(dir);
    if (parent === dir || !existsSync(path.join(parent, 'package.json'))) return null;
    dir = parent;
  }
  return null;
}

/** A script name as one shell word: bare when plain, quoted when it has spaces, left out when quoting would not be safe. */
function shellWord(name: string): string | null {
  if (/^[\w.:@/+-]+$/.test(name)) return name;
  if (/["'`$\\\r\n]/.test(name)) return null;
  return `"${name}"`;
}

/** package.json's scripts in their file order, without npm's lifecycle hooks and a script's own pre/post steps. */
export function packageScripts(pkg: unknown, manager: PackageManager): ProjectScript[] {
  const scripts = (pkg as { scripts?: unknown } | null)?.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
  const entries = Object.entries(scripts as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[0].trim());
  const names = new Set(entries.map(([n]) => n));
  const out: ProjectScript[] = [];
  for (const [name, command] of entries) {
    if (LIFECYCLE.has(name)) continue;
    const hook = /^(pre|post)(.+)$/.exec(name);
    if (hook && names.has(hook[2])) continue;
    const word = shellWord(name);
    if (!word) continue;
    out.push({ name, command: command.trim(), run: `${manager} run ${word}`, source: 'package' });
    if (out.length >= MAX_SCRIPTS) break;
  }
  return out;
}

/**
 * A Makefile's plain targets (written out at the start of a line, not special, pattern or variable
 * targets), in file order, each with its recipe's first line. Null when it has none (not simple).
 */
export function makeTargets(text: string): ProjectScript[] | null {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\\\n/g, ' ').split('\n');
  const out: ProjectScript[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('\t') || line.startsWith('#')) continue;
    // "name [name…]: prerequisites"; not ":=" or "::=" (assignments) or "::" (double-colon rules).
    const m = /^([A-Za-z0-9_][A-Za-z0-9_.\-/]*(?:[ \t]+[A-Za-z0-9_][A-Za-z0-9_.\-/]*)*)[ \t]*:(?![:=])/.exec(line);
    if (!m) continue;
    let recipe = '';
    for (let j = i + 1; j < lines.length; j++) {
      const r = lines[j];
      if (!r.startsWith('\t')) {
        if (!r.trim() || r.trimStart().startsWith('#')) continue;
        break;
      }
      const cmd = r.trim().replace(/^[@+-]+/, '').trim();
      if (cmd && !cmd.startsWith('#')) {
        recipe = cmd;
        break;
      }
    }
    for (const name of m[1].split(/[ \t]+/)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, command: recipe || `make ${name}`, run: `make ${name}`, source: 'make' });
      if (out.length >= MAX_SCRIPTS) return out;
    }
  }
  return out.length ? out : null;
}

/** The plain `key = "value"` entries of one TOML table (a value that is an inline table gives its `callable` or `reference`). */
export function tomlTable(text: string, table: string): [string, string][] | null {
  let current = '';
  let found = false;
  const out: [string, string][] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const head = /^\[([^[\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (head) {
      current = head[1].replace(/["'\s]/g, '');
      if (current === table) found = true;
      continue;
    }
    if (line.startsWith('[')) {
      current = '';
      continue;
    }
    if (current !== table) continue;
    const kv = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] ?? kv[2] ?? kv[3];
    const value = kv[4].trim();
    const str = /^"([^"]*)"|^'([^']*)'/.exec(value);
    if (str) out.push([key, str[1] ?? str[2]]);
    else {
      const ref = /\b(?:callable|reference)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(value);
      if (value.startsWith('{') && ref) out.push([key, ref[1] ?? ref[2]]);
    }
  }
  return found ? out : null;
}

/** Whether a program is on the PATH (asked again after a minute: someone may have installed it). */
const pathCache = new Map<string, { at: number; on: boolean }>();
export function onPath(program: string): boolean {
  const hit = pathCache.get(program);
  if (hit && Date.now() - hit.at < 60_000) return hit.on;
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  let on = false;
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (statSync(path.join(dir, program + ext)).isFile()) {
          on = true;
          break;
        }
      } catch {
        /* not here */
      }
    }
    if (on) break;
  }
  pathCache.set(program, { at: Date.now(), on });
  return on;
}

function readSmall(file: string): string | null {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
}

/** The files a folder's scripts come from, by size and time: when this is the same, so is the answer. */
function signature(cwd: string, lockDir: string | null): string {
  const files = ['package.json', ...MAKEFILES, 'pyproject.toml', ...PY_LOCKS.map(([f]) => f)].map((f) => path.join(cwd, f));
  if (lockDir) for (const [f] of LOCKS) files.push(path.join(lockDir, f));
  const parts = files.map((f) => {
    try {
      const st = statSync(f);
      return `${st.size}:${Math.round(st.mtimeMs)}`;
    } catch {
      return '-';
    }
  });
  return `${lockDir ?? ''}|${parts.join(',')}`;
}

export interface DetectOptions {
  /** Whether a program can be run (tests stand in for the PATH). */
  has?: (program: string) => boolean;
}

/** Reads a folder's scripts. Never throws for a file it cannot read: that file is left out and named in `skipped`. */
export function detectScripts(cwd: string, opts: DetectOptions = {}): ProjectScripts {
  const has = opts.has ?? onPath;
  const scripts: ProjectScript[] = [];
  const skipped: string[] = [];
  const lock = findLockfiles(cwd);
  let manager: PackageManager | null = null;

  const pkgText = readSmall(path.join(cwd, 'package.json'));
  if (pkgText !== null) {
    let pkg: unknown = null;
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      skipped.push('package.json: not valid JSON');
    }
    manager = pickManager(lock?.files ?? [], (pkg as { packageManager?: unknown } | null)?.packageManager);
    if (pkg) scripts.push(...packageScripts(pkg, manager));
  } else if (existsSync(path.join(cwd, 'package.json'))) skipped.push('package.json: too large to read');

  // By the folder's own listing, so a case-insensitive disk still gives the file's real name.
  let listing: string[] = [];
  try {
    listing = readdirSync(cwd);
  } catch {
    /* unreadable: no Makefile */
  }
  const name = listing.find((n) => n === MAKEFILES[0]) ?? listing.find((n) => n.toLowerCase() === 'makefile');
  if (name) {
    const makefile = path.join(cwd, name);
    const text = readSmall(makefile);
    const targets = text === null ? null : makeTargets(text);
    if (text === null) skipped.push(`${name}: too large to read`);
    else if (!targets) skipped.push(`${name}: no plain targets`);
    else if (!has('make')) skipped.push(`${name}: make is not installed`);
    else scripts.push(...targets);
  }

  const pyText = readSmall(path.join(cwd, 'pyproject.toml'));
  if (pyText !== null) {
    const poetry = tomlTable(pyText, 'tool.poetry.scripts');
    const project = tomlTable(pyText, 'project.scripts');
    const lockRunner = PY_LOCKS.find(([f]) => existsSync(path.join(cwd, f)))?.[1];
    const entries: { name: string; ref: string; runner: string }[] = [];
    if (project) {
      // Entry points run inside the project's environment: the tool whose lockfile is there makes it.
      const runner = lockRunner ?? (tomlTable(pyText, 'tool.poetry') ? 'poetry' : undefined);
      if (!runner) skipped.push('pyproject.toml: its scripts need uv, Poetry or PDM (no lockfile)');
      else for (const [name, ref] of project) entries.push({ name, ref, runner });
    }
    if (poetry) for (const [name, ref] of poetry) if (!entries.some((e) => e.name === name)) entries.push({ name, ref, runner: 'poetry' });
    if ((project || poetry) && !entries.length && !skipped.some((s) => s.startsWith('pyproject.toml'))) skipped.push('pyproject.toml: no plain script entries');
    const missing = new Set<string>();
    for (const e of entries) {
      const word = shellWord(e.name);
      if (!word) continue;
      if (!has(e.runner)) {
        missing.add(e.runner);
        continue;
      }
      scripts.push({ name: e.name, command: e.ref, run: `${e.runner} run ${word}`, source: 'python' });
      if (scripts.length >= MAX_SCRIPTS * 2) break;
    }
    for (const r of missing) skipped.push(`pyproject.toml: ${r} is not installed`);
  }

  return { cwd, manager, scripts, skipped, sig: signature(cwd, lock?.dir ?? null) };
}

const CACHE_MAX = 64;

export function registerScripts(app: App) {
  const cache = new Map<string, ProjectScripts>();

  app.register('project.scripts', ({ cwd }) => {
    const dir = path.resolve(cwd || '.');
    try {
      if (!statSync(dir).isDirectory()) throw new Error();
    } catch {
      throw new Error(`Folder not found: ${dir}`);
    }
    const prev = cache.get(dir);
    // Unchanged files (and lockfile folder): the last answer stands, without reading anything.
    if (prev && prev.sig === signature(dir, findLockfiles(dir)?.dir ?? null)) return prev;
    const next = detectScripts(dir);
    cache.delete(dir);
    cache.set(dir, next);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    return next;
  });
}
