/** Small formatting helpers shared across the UI. */

export function baseName(p?: string | null): string {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

export function dirName(p?: string | null): string {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  if (i < 0) return '';
  return i === 0 ? '/' : norm.slice(0, i);
}

/** Path relative to a root when inside it, otherwise the path with the home folder shortened to "~". */
export function relPath(p: string, root?: string | null, home?: string | null): string {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const n = norm(p);
  if (root) {
    const r = norm(root);
    if (n.toLowerCase() === r.toLowerCase()) return '.';
    if (n.toLowerCase().startsWith(r.toLowerCase() + '/')) return n.slice(r.length + 1);
  }
  if (home) {
    const h = norm(home);
    if (n.toLowerCase().startsWith(h.toLowerCase() + '/')) return '~/' + n.slice(h.length + 1);
  }
  return n;
}

export function tildePath(p: string, home?: string | null): string {
  return relPath(p, null, home);
}

export function formatTokens(n?: number | null): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export function formatCost(usd?: number | null): string {
  if (!usd) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(usd < 10 ? 2 : 1)}`;
}

export function formatDuration(ms?: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatBytes(n?: number | null): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 35) return `${Math.round(d / 7)}w`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "Today", "Yesterday", "This week", "Earlier" buckets for lists. */
export function dayBucket(ts: number, now = Date.now()): string {
  const day = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const diff = Math.round((day(now) - day(ts)) / 86_400_000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'This week';
  if (diff < 31) return 'This month';
  return 'Earlier';
}

export function resetIn(ts?: number, now = Date.now()): string {
  if (!ts) return '';
  const ms = ts - now;
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  xml: 'xml',
  svg: 'xml',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'docker',
  lua: 'lua',
};

export function langFromPath(path?: string | null): string {
  if (!path) return 'text';
  const name = baseName(path).toLowerCase();
  if (name === 'dockerfile') return 'docker';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return EXT_LANG[ext] ?? 'text';
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Renders a shortcut like "mod+k" as ["Ctrl", "K"] or ["⌘", "K"]. */
export function shortcutKeys(combo: string): string[] {
  return combo.split('+').map((k) => {
    switch (k.toLowerCase()) {
      case 'mod':
        return isMac ? '⌘' : 'Ctrl';
      case 'shift':
        return isMac ? '⇧' : 'Shift';
      case 'alt':
        return isMac ? '⌥' : 'Alt';
      case 'enter':
        return '↵';
      case 'esc':
        return 'Esc';
      case 'tab':
        return 'Tab';
      case 'up':
        return '↑';
      case 'down':
        return '↓';
      default:
        return k.length === 1 ? k.toUpperCase() : k;
    }
  });
}
