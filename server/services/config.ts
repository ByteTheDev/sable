import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentConfigFile, ConfigHook, ConfigPermissions, ProviderId } from '../../shared/protocol';
import type { App } from '../app';

/**
 * Read-only view of the agents' own settings files: permission rules and hooks for
 * Claude Code, the config file for Codex. Nothing that looks like a secret leaves this
 * module: Claude files are reduced to known fields, TOML values under secret-looking
 * keys are masked, and commands have token-like arguments masked.
 */

const MAX_TOML = 64 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
const HIDDEN = '[hidden]';

/** Keys whose values are never shown. */
const SECRET_KEY = /key|token|secret|password|passwd|credential|authorization|cookie/i;
/** Tables / keys whose whole content is never shown. */
const SECRET_TABLE = new Set(['env', 'headers', 'http_headers', 'env_http_headers', 'apikeyhelper']);

const isSecretName = (name: string) => SECRET_KEY.test(name) || SECRET_TABLE.has(name.toLowerCase());

/** Masks token-like values in a shell command or rule. */
export function maskCommand(s: string): string {
  return s
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:key|token|secret|password)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, `$1=${HIDDEN}`)
    .replace(/\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{6,}/gi, `$1$2${HIDDEN}`)
    .replace(/(--?[A-Za-z-]*(?:key|token|secret|password)[A-Za-z-]*)([= ])("[^"]*"|'[^']*'|[^\s"']+)/gi, `$1$2${HIDDEN}`);
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(maskCommand) : []);

function readPermissions(v: unknown): ConfigPermissions | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const p = v as Record<string, unknown>;
  return {
    allow: strings(p.allow),
    ask: strings(p.ask),
    deny: strings(p.deny),
    defaultMode: typeof p.defaultMode === 'string' ? p.defaultMode : undefined,
    additionalDirectories: strings(p.additionalDirectories),
  };
}

/** `{ Event: [{ matcher, hooks: [{ type, command }] }] }` → one row per hook. */
function readHooks(v: unknown): ConfigHook[] {
  if (!v || typeof v !== 'object') return [];
  const out: ConfigHook[] = [];
  for (const [event, groups] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const g = group as Record<string, unknown>;
      const matcher = typeof g.matcher === 'string' && g.matcher ? g.matcher : undefined;
      for (const hook of Array.isArray(g.hooks) ? g.hooks : []) {
        if (!hook || typeof hook !== 'object') continue;
        const h = hook as Record<string, unknown>;
        const type = typeof h.type === 'string' ? h.type : 'command';
        const body = [h.command, h.prompt, h.url].find((x): x is string => typeof x === 'string') ?? '';
        out.push({ event, matcher, command: maskCommand(body), type });
      }
    }
  }
  return out;
}

async function readCapped(file: string, max: number): Promise<{ text: string; truncated: boolean } | null> {
  let fh;
  try {
    fh = await open(file, 'r');
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    // Never end on half a character.
    if (st.size > max) text = text.replace(/�$/, '');
    return { text: text.replace(/^﻿/, ''), truncated: st.size > max };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw err;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function readClaudeFile(file: string, scope: AgentConfigFile['scope']): Promise<AgentConfigFile> {
  const base: AgentConfigFile = { path: file, scope, exists: false, format: 'json' };
  let read;
  try {
    read = await readCapped(file, MAX_JSON);
  } catch (err) {
    return { ...base, exists: true, error: `Could not read the file: ${(err as Error).message}` };
  }
  if (!read) return base;
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    return { ...base, exists: true, error: read.truncated ? 'The file is too large to read.' : 'The file is not valid JSON.' };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ...base, exists: true, error: 'The file does not hold a settings object.' };
  const o = json as Record<string, unknown>;
  return { ...base, exists: true, permissions: readPermissions(o.permissions), hooks: readHooks(o.hooks) };
}

// ── TOML masking (line based; the text is shown, not interpreted) ──

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '');
const KEY_PART = String.raw`(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+)`;
const KV = new RegExp(String.raw`^(\s*)(${KEY_PART}(?:\s*\.\s*${KEY_PART})*)\s*=\s*(.*)$`);
const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;
/** `secret = value` pairs inside inline tables. */
const INLINE_SECRET = new RegExp(
  String.raw`((?:^|[{,])\s*)(${KEY_PART})(\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*'|\{[^}]*\}|\[[^\]]*\]|[^,}\s]+)`,
  'g',
);

function splitKey(key: string): string[] {
  return key.match(new RegExp(KEY_PART, 'g'))?.map(unquote) ?? [];
}

function openMultiline(value: string): RegExp | null {
  const v = value.trim();
  if (v.startsWith('"""')) return /"""/.test(v.slice(3)) ? null : /"""/;
  if (v.startsWith("'''")) return /'''/.test(v.slice(3)) ? null : /'''/;
  const opener = v[0];
  if (opener !== '[' && opener !== '{') return null;
  const close = opener === '[' ? ']' : '}';
  let depth = 0;
  for (const ch of v.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '')) {
    if (ch === opener) depth++;
    else if (ch === close) depth--;
  }
  return depth > 0 ? new RegExp(`\\${close}` + String.raw`\s*,?\s*(?:#.*)?$`) : null;
}

export function maskToml(text: string): string {
  const out: string[] = [];
  let table: string[] = [];
  let skipUntil: RegExp | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (skipUntil) {
      if (skipUntil.test(line)) skipUntil = null;
      continue;
    }
    const header = line.match(HEADER);
    if (header && !KV.test(line)) {
      table = splitKey(header[1]);
      out.push(line);
      continue;
    }
    const kv = line.match(KV);
    if (!kv) {
      out.push(line);
      continue;
    }
    const [, indent, key, value] = kv;
    if ([...table, ...splitKey(key)].some(isSecretName)) {
      out.push(`${indent}${key} = "${HIDDEN}"`);
      skipUntil = openMultiline(value);
      continue;
    }
    const masked = value.replace(INLINE_SECRET, (m, lead: string, k: string, eq: string) => (isSecretName(unquote(k)) ? `${lead}${k}${eq}"${HIDDEN}"` : m));
    out.push(masked === value ? line : `${indent}${key} = ${masked}`);
  }
  return out.join('\n');
}

async function readCodexFile(file: string): Promise<AgentConfigFile> {
  const base: AgentConfigFile = { path: file, scope: 'user', exists: false, format: 'toml' };
  try {
    const read = await readCapped(file, MAX_TOML);
    if (!read) return base;
    return { ...base, exists: true, raw: maskToml(read.text), truncated: read.truncated || undefined };
  } catch (err) {
    return { ...base, exists: true, error: `Could not read the file: ${(err as Error).message}` };
  }
}

function demoFiles(home: string, cwd?: string): AgentConfigFile[] {
  const files: AgentConfigFile[] = [
    {
      path: path.join(home, '.demo', 'settings.json'),
      scope: 'user',
      exists: true,
      format: 'json',
      permissions: { allow: ['Read', 'Grep', 'Bash(git status)', 'Bash(pnpm test:*)'], ask: ['Bash(git push:*)'], deny: ['Read(./.env)', 'Bash(rm -rf:*)'], additionalDirectories: [] },
      hooks: [{ event: 'Stop', command: 'notify-send "Demo finished"', type: 'command' }],
    },
  ];
  if (cwd) {
    files.push(
      {
        path: path.join(cwd, '.demo', 'settings.json'),
        scope: 'project',
        exists: true,
        format: 'json',
        permissions: { allow: ['Edit(src/**)', 'Bash(pnpm lint)'], ask: [], deny: ['Edit(.github/**)'], defaultMode: 'acceptEdits', additionalDirectories: ['../shared'] },
        hooks: [
          { event: 'PostToolUse', matcher: 'Edit|Write', command: 'pnpm exec prettier --write "$CLAUDE_FILE_PATHS"', type: 'command' },
          { event: 'PreToolUse', matcher: 'Bash', command: 'node scripts/check-command.mjs', type: 'command' },
        ],
      },
      { path: path.join(cwd, '.demo', 'settings.local.json'), scope: 'local', exists: false, format: 'json' },
    );
  }
  return files;
}

export interface ConfigOptions {
  /** User home (tests override it). When set, CLAUDE_CONFIG_DIR / CODEX_HOME are ignored. */
  home?: string;
}

export async function configRead(provider: ProviderId, cwd: string | undefined, opts: ConfigOptions = {}): Promise<AgentConfigFile[]> {
  const home = opts.home ?? os.homedir();
  const dir = cwd ? path.resolve(cwd) : undefined;
  if (provider === 'demo') return demoFiles(home, dir);
  if (provider === 'codex') {
    const codexHome = (!opts.home && process.env.CODEX_HOME) || path.join(home, '.codex');
    return [await readCodexFile(path.join(codexHome, 'config.toml'))];
  }
  const claudeHome = (!opts.home && process.env.CLAUDE_CONFIG_DIR) || path.join(home, '.claude');
  const files: [string, AgentConfigFile['scope']][] = [[path.join(claudeHome, 'settings.json'), 'user']];
  if (dir) {
    files.push([path.join(dir, '.claude', 'settings.json'), 'project'], [path.join(dir, '.claude', 'settings.local.json'), 'local']);
  }
  return Promise.all(files.map(([file, scope]) => readClaudeFile(file, scope)));
}

export function registerConfig(app: App, opts: ConfigOptions = {}) {
  app.register('config.read', ({ provider, cwd }) => configRead(provider, cwd || undefined, opts));
}
