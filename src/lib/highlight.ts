/**
 * Syntax highlighting, the light half: language names, a result cache and an idle-time
 * queue. The grammar engine (lib/shiki.ts) is imported on first use. Callers render
 * plain text until tokens arrive; both renderings share metrics, so nothing moves.
 */
import { useEffect, useReducer } from 'react';

export interface HlToken {
  content: string;
  /** A CSS colour (a `var(--syn-*)` reference); undefined means the default foreground. */
  color?: string;
  /** Bit flags: 1 italic, 2 bold, 4 underline. */
  style?: number;
}
export type HlLines = HlToken[][];

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  shellscript: 'bash',
  console: 'bash',
  shellsession: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  ps: 'powershell',
  py: 'python',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  rs: 'rust',
  rb: 'ruby',
  kt: 'kotlin',
  golang: 'go',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  h: 'c',
  cs: 'csharp',
  'c#': 'csharp',
  dockerfile: 'docker',
  json5: 'jsonc',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  svg: 'xml',
  patch: 'diff',
  makefile: 'make',
  gql: 'graphql',
  env: 'ini',
  dotenv: 'ini',
  conf: 'ini',
  plaintext: 'text',
  plain: 'text',
  txt: 'text',
  log: 'text',
  output: 'text',
  '': 'text',
};

const LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  jsx: 'JSX',
  json: 'JSON',
  jsonc: 'JSON',
  bash: 'Shell',
  powershell: 'PowerShell',
  python: 'Python',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
  xml: 'XML',
  markdown: 'Markdown',
  yaml: 'YAML',
  toml: 'TOML',
  ini: 'INI',
  sql: 'SQL',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  ruby: 'Ruby',
  php: 'PHP',
  lua: 'Lua',
  diff: 'Diff',
  docker: 'Dockerfile',
  http: 'HTTP',
  graphql: 'GraphQL',
  make: 'Makefile',
  text: 'Plain text',
};

/** Grammar ids this app can colour. Kept in sync with LOADERS in lib/shiki.ts. */
const SUPPORTED = new Set(Object.keys(LABELS).filter((l) => l !== 'text'));

export function normalizeLang(lang?: string | null): string {
  const id = (lang ?? '').trim().toLowerCase().split(/[\s,{:]/)[0];
  return ALIASES[id] ?? id;
}

/** "ts" → "TypeScript". Unknown ids are shown in sentence case. */
export function langLabel(lang?: string | null): string {
  const id = normalizeLang(lang);
  return LABELS[id] ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Plain text');
}

const MAX_CHARS = 80_000;
const MAX_LINES = 2_000;

export function canHighlight(code: string, lang?: string | null): boolean {
  return SUPPORTED.has(normalizeLang(lang)) && code.length > 0 && code.length <= MAX_CHARS;
}

// ── cache (LRU by insertion order) ──

const cache = new Map<string, HlLines>();
let cacheChars = 0;
const CACHE_CHARS = 4_000_000;

const keyOf = (code: string, lang: string) => `${lang}\u0000${code}`;

function remember(key: string, lines: HlLines) {
  cache.set(key, lines);
  cacheChars += key.length;
  while (cacheChars > CACHE_CHARS && cache.size > 1) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
    cacheChars -= oldest.length;
  }
}

// ── idle queue ──

interface Job {
  key: string;
  code: string;
  lang: string;
  listeners: Set<() => void>;
}

const jobs = new Map<string, Job>();
const failed = new Set<string>();
let pumping = false;

const idle: (fn: () => void) => void =
  typeof requestIdleCallback === 'function' ? (fn) => requestIdleCallback(fn, { timeout: 400 }) : (fn) => setTimeout(fn, 16);

/** The highlighting worker; null once it failed (or where workers do not exist), then the main thread does it. */
let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, { resolve: (lines: HlLines | null) => void; reject: () => void }>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = typeof Worker === 'function' ? new Worker(new URL('./shiki.worker.ts', import.meta.url), { type: 'module' }) : null;
  } catch {
    worker = null;
  }
  if (worker) {
    worker.onmessage = (e: MessageEvent<{ id: number; lines: HlLines | null }>) => {
      waiting.get(e.data.id)?.resolve(e.data.lines);
      waiting.delete(e.data.id);
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      for (const w of waiting.values()) w.reject();
      waiting.clear();
    };
  }
  return worker;
}

/** Tokens from the worker, or from the main thread when there is no worker. */
async function tokenizeOffThread(code: string, lang: string): Promise<HlLines | null> {
  const w = getWorker();
  if (w) {
    try {
      return await new Promise<HlLines | null>((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        w.postMessage({ id, code, lang });
      });
    } catch {
      /* the worker died: fall through to the main thread */
    }
  }
  const { tokenize } = await import('./shiki');
  return tokenize(code, lang);
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    const tokenize = tokenizeOffThread;
    while (jobs.size) {
      await new Promise<void>((resolve) => idle(resolve));
      const job = jobs.values().next().value as Job | undefined;
      if (!job) break;
      jobs.delete(job.key);
      if (!job.listeners.size) continue;
      const lines = job.code.split('\n').length <= MAX_LINES ? await tokenize(job.code, job.lang) : null;
      if (lines) remember(job.key, lines);
      else failed.add(job.key);
      for (const l of job.listeners) l();
    }
  } finally {
    pumping = false;
  }
}

/** Queues a highlight; `done` fires once the result is in the cache. Returns a cancel function. */
function request(code: string, lang: string, done: () => void): () => void {
  const key = keyOf(code, lang);
  let job = jobs.get(key);
  if (!job) {
    job = { key, code, lang, listeners: new Set() };
    jobs.set(key, job);
  }
  job.listeners.add(done);
  void pump();
  return () => {
    job.listeners.delete(done);
  };
}

/**
 * Tokens for `code`, or null while they are not ready (or never will be). Pass
 * `enabled: false` while the text is still streaming or the block is far off screen.
 */
export function useHighlight(code: string, lang: string | null | undefined, enabled = true): HlLines | null {
  const id = normalizeLang(lang);
  const ok = enabled && canHighlight(code, id);
  const key = ok ? keyOf(code, id) : '';
  const cached = ok ? cache.get(key) : undefined;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!ok || cached || failed.has(key)) return;
    return request(code, id, bump);
  }, [ok, cached, key, code, id]);
  return cached ?? null;
}
