import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { App } from '../app';
import type { AppSettings, Project, ProfileEntry, UserProfile } from '../../shared/protocol';

/**
 * The user's profile: `<home>/profile.md`, markdown, the user's own. Their part is free text; under
 * a "Learned" heading Sable keeps the short facts agents added with `remember_about_user`, one dated
 * line each, newest first. A compact form of both goes into each agent's prompt (`promptProfile`).
 * Written once from what is known and harmless when there is none yet (`seedProfile`); never from
 * sign-in files, and never with anything that looks like a secret.
 */

export const PROFILE_FILE = 'profile.md';
/** The section Sable keeps: the agents' additions. */
const LEARNED = 'Learned';
const LEARNED_RE = /^##\s+learned\s*$/i;
/** One addition: "- Prefers short answers (2026-11-19)". */
const ENTRY_RE = /^[-*]\s+(.+?)\s+\((\d{4}-\d{2}-\d{2})\)\s*$/;
/** Additions kept; the oldest go first. */
export const MAX_ENTRIES = 60;
/** The longest fact an agent may add (characters). */
export const MAX_FACT = 240;
/** About how many words of the profile go into an agent's prompt. */
export const PROMPT_WORDS = 600;
/** The largest profile Sable writes (characters). */
const MAX_TEXT = 40_000;

/** Absent means on. */
export const profileEnabled = (s: Pick<AppSettings, 'userProfile'> | undefined) => s?.userProfile !== false;

export interface ParsedProfile {
  /** The user's own part: everything but the Learned section. */
  own: string;
  /** The agents' additions, in file order (newest first). */
  entries: ProfileEntry[];
}

const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export const entryId = (text: string) => createHash('sha1').update(norm(text)).digest('hex').slice(0, 10);

/** Splits a profile into the user's part and the Learned entries (lines there that are not entries stay the user's). */
export function parseProfile(text: string): ParsedProfile {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => LEARNED_RE.test(l.trim()));
  if (start < 0) return { own: text.replace(/\r\n/g, '\n').trimEnd(), entries: [] };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++)
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  const entries: ProfileEntry[] = [];
  const stray: string[] = [];
  for (const l of lines.slice(start + 1, end)) {
    const m = ENTRY_RE.exec(l.trim());
    if (m) entries.push({ id: entryId(m[1]), text: m[1], date: m[2] });
    else if (l.trim()) stray.push(l);
  }
  const own = [...lines.slice(0, start), ...stray, ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  return { own, entries };
}

/** The file from the user's part and the additions. */
export function formatProfile(own: string, entries: ProfileEntry[]): string {
  const head = own.replace(/\r\n/g, '\n').trimEnd();
  const learned = entries.length ? `## ${LEARNED}\n\n${entries.map((e) => `- ${e.text} (${e.date})`).join('\n')}\n` : '';
  return [head, learned].filter(Boolean).join('\n\n').trimEnd() + '\n';
}

/** A local date as YYYY-MM-DD. */
export function localDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Why a fact may not go into the profile, or undefined when it may: an email address, something
 * shaped like a key or token, a password or other secret with its value, a card or account number.
 */
export function secretReason(fact: string): string | undefined {
  if (/[\w.+-]+@[\w-]+(\.[\w-]+)+/.test(fact)) return 'it contains an email address';
  if (/(?:password|passwort|passphrase|kennwort|\bpin\b|api[\s_-]?key|secret|token|credential|private[\s_-]?key|ssh[\s_-]?key|bearer|cookie|session[\s_-]?id)\w*\s*(?:is|ist|=|:|was|lautet)\s*\S/i.test(fact)) return 'it looks like a secret';
  if (/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abposr]|AKIA|AIza|glpat|hf|eyJ)[-_A-Za-z0-9]{8,}/.test(fact)) return 'it looks like a key or token';
  // A long run of letters and digits mixed (base64, hex): a key, a hash, a token.
  for (const w of fact.split(/[\s,;()"'`]+/))
    if (w.length >= 24 && /[0-9]/.test(w) && /[A-Za-z]/.test(w) && !/[\\/.]/.test(w) && /^[-_A-Za-z0-9+=]+$/.test(w)) return 'it looks like a key or token';
  if (/\b(?:\d[ -]?){13,19}\b/.test(fact)) return 'it looks like a card or account number';
  if (/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/.test(fact)) return 'it looks like an account number';
  return undefined;
}

/** A fact as one tidy line: no bullet, quotes or line breaks, one space between words. */
export function cleanFact(raw: string): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-*•]\s*/, '')
    .replace(/^["'“„](.*)["'”]$/, '$1')
    .trim();
}

/** The words that tell facts apart: longer words, and any with a digit ("Node 22" is not "Node 20"). */
const words = (t: string) => new Set(norm(t).split(' ').filter((w) => w.length > 2 || /[0-9]/.test(w)));

/** Two facts that say about the same thing (same words, or one inside the other). */
export function sameFact(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  const [short, long] = na.length < nb.length ? [na, nb] : [nb, na];
  if (short.split(' ').length >= 3 && long.includes(short)) return true;
  const wa = words(a);
  const wb = words(b);
  if (wa.size < 3 || wb.size < 3) return false;
  let both = 0;
  for (const w of wa) if (wb.has(w)) both++;
  return both / (wa.size + wb.size - both) >= 0.75;
}

export type RememberResult = { ok: true; status: 'added' | 'updated' | 'known'; text: string; profile: string } | { ok: false; text: string };

/**
 * Merges one fact into a profile: refused when it looks like a secret or is too long; already
 * known (in the user's part, or as an addition: dated today and moved to the top); replacing an
 * addition that says about the same (the newer wording wins); else added on top. At most
 * `MAX_ENTRIES` additions, the oldest dropped.
 */
export function remember(text: string, raw: string, today = localDay()): RememberResult {
  const fact = cleanFact(raw);
  if (fact.length < 3) return { ok: false, text: 'Nothing to remember: `fact` was empty.' };
  if (fact.length > MAX_FACT) return { ok: false, text: `Too long (${fact.length} characters, at most ${MAX_FACT}). Say it in one short sentence.` };
  const why = secretReason(fact);
  if (why) return { ok: false, text: `Not remembered: ${why}. The profile never keeps secrets, keys, passwords or email addresses.` };
  const { own, entries } = parseProfile(text);
  const nf = norm(fact);
  if (nf.split(' ').length >= 3 && norm(own).includes(nf)) return { ok: true, status: 'known', text: 'Already in the profile.', profile: text };
  const i = entries.findIndex((e) => sameFact(e.text, fact));
  const entry: ProfileEntry = { id: entryId(fact), text: fact, date: today };
  let status: 'added' | 'updated' | 'known' = 'added';
  const rest = [...entries];
  if (i >= 0) {
    status = norm(entries[i].text) === nf ? 'known' : 'updated';
    rest.splice(i, 1);
  }
  const next = formatProfile(own, [entry, ...rest].slice(0, MAX_ENTRIES));
  if (next.length > MAX_TEXT) return { ok: false, text: 'The profile is full. The user can make room in Settings › Profile.' };
  return { ok: true, status, text: status === 'added' ? 'Remembered.' : status === 'updated' ? 'Updated the earlier note.' : 'Already in the profile.', profile: next };
}

/** Removes one addition. */
export function forget(text: string, id: string): string {
  const { own, entries } = parseProfile(text);
  return formatProfile(own, entries.filter((e) => e.id !== id));
}

const wordCount = (t: string) => (t.match(/\S+/g) ?? []).length;

/**
 * The profile as it goes into a prompt: the user's own part first (their words matter most),
 * then the additions newest first, within about `budget` words. Headings that end up with
 * nothing under them, HTML comments and blank runs are dropped. Empty when there is nothing.
 */
export function compactProfile(text: string, budget = PROMPT_WORDS): string {
  const { own, entries } = parseProfile(text);
  const ownLines = own
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^#\s/.test(l));
  // Drop headings with nothing under them.
  const kept = ownLines.filter((l, i) => !/^#{2,6}\s/.test(l) || (ownLines[i + 1] !== undefined && !/^#{1,6}\s/.test(ownLines[i + 1])));
  const learned = entries.map((e) => `- ${e.text}`);
  const learnedWords = learned.reduce((n, l) => n + wordCount(l), 0);
  // The user's part may take what the additions leave, and at least six tenths.
  const ownBudget = Math.max(Math.floor(budget * 0.6), budget - learnedWords);
  const out: string[] = [];
  let used = 0;
  for (const l of kept) {
    const n = wordCount(l);
    if (used + n > ownBudget) {
      const room = ownBudget - used;
      if (room >= 8 && !/^#{1,6}\s/.test(l)) out.push(l.split(/\s+/).slice(0, room).join(' ') + ' …');
      break;
    }
    out.push(l);
    used += n;
  }
  if (learned.length) {
    const take: string[] = [];
    for (const l of learned) {
      const n = wordCount(l);
      if (used + n > budget) break;
      take.push(l);
      used += n;
    }
    if (take.length) out.push('## Learned', ...take);
  }
  // A heading left last with nothing under it goes.
  while (out.length && /^#{1,6}\s/.test(out[out.length - 1])) out.pop();
  return out.join('\n').trim();
}

/** What an agent is told around the profile (and about the tool, when it has it). */
export function profilePrompt(compact: string, tool: boolean): string {
  const lines = [];
  if (compact)
    lines.push(
      'About the user, from their profile in Sable (their own notes and facts agents learned before). Let it shape how you work and answer; do not mention or quote it unless they ask.',
      '<user_profile>',
      compact,
      '</user_profile>',
    );
  if (tool)
    lines.push(
      'When you learn something lasting about the user (a preference, the language they write in, how they like answers, their projects, their machine), call remember_about_user with one short fact. Not for details of the current task, never for secrets.',
    );
  return lines.join('\n');
}

// ── the first profile ──

/** An English name for a locale's language ("de-DE" → "German"). */
function languageName(locale: string): string | undefined {
  const code = locale.split(/[-_]/)[0]?.toLowerCase();
  if (!code) return undefined;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Folders a chat without a folder made (dated names, or inside "Sable chats"): not projects. */
const isChatFolder = (p: Project) => /^\d{4}-\d{2}-\d{2}\b/.test(p.name) || /[\\/]sable chats[\\/]/i.test(p.path);

/** Prose of a "design" / "taste" / "style" section of a project's instructions file: its first paragraphs, about 90 words. */
export function designTaste(markdown: string, maxWords = 90): string | undefined {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => /^#{1,3}\s+.*\b(design|taste|look and feel|visual style|ui style)\b/i.test(l));
  if (at < 0) return undefined;
  const level = /^#+/.exec(lines[at])![0].length;
  const paras: string[] = [];
  let cur: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const h = /^#+/.exec(l);
    if (h && h[0].length <= level) break;
    if (!l.trim() || /^\s*([-*+]|\d+\.)\s/.test(l) || h || /^\s*```/.test(l)) {
      if (cur.length) paras.push(cur.join(' '));
      cur = [];
      if (/^\s*([-*+]|\d+\.)\s/.test(l) && paras.length) break;
      continue;
    }
    cur.push(l.trim());
  }
  if (cur.length) paras.push(cur.join(' '));
  const prose = paras
    .join(' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*?([^*]+)\*\*?/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!prose) return undefined;
  const all = prose.split(' ');
  if (all.length <= maxWords) return prose;
  const cut = all.slice(0, maxWords).join(' ');
  const end = cut.lastIndexOf('. ');
  return end > cut.length * 0.5 ? cut.slice(0, end + 1) : `${cut} …`;
}

/**
 * The profile Sable writes when there is none: the language the system runs in (with English, the
 * language of code), the design taste a project's instructions describe, the folders in the sidebar.
 * Nothing from sign-ins, nothing secret; the user edits or deletes any of it.
 */
export function seedProfile(opts: { locale?: string; projects: Project[]; readFile?: (p: string) => string | undefined; exists?: (p: string) => boolean }): string {
  const out: string[] = ['# Profile', ''];
  const lang = opts.locale ? languageName(opts.locale) : undefined;
  out.push('## Language', '');
  out.push(lang && lang !== 'English' ? `- Writes in ${lang} and English. Answer in the language of each message.` : '- Answer in the language of each message.');
  const projects = opts.projects
    .filter((p) => !p.hidden && !isChatFolder(p) && (opts.exists ?? existsSync)(p.path))
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .slice(0, 8);
  const read = opts.readFile;
  if (read)
    for (const p of projects) {
      const md = read(path.join(p.path, 'CLAUDE.md')) ?? read(path.join(p.path, 'AGENTS.md'));
      const taste = md ? designTaste(md) : undefined;
      if (taste) {
        out.push('', '## Taste', '', `- From ${p.name}'s instructions: ${taste}`);
        break;
      }
    }
  if (projects.length) out.push('', '## Projects', '', ...projects.map((p) => `- ${p.name} (${p.path})`));
  return out.join('\n') + '\n';
}

// ── the service ──

/** What a provider asks of the profile while it starts an agent process and when the tool is called. */
export interface ProfileAccess {
  /** Whether agents get the profile and the tool (Settings). */
  enabled(): boolean;
  /** The text for the agent's prompt (empty when off or empty). */
  prompt(tool: boolean): string;
  /** A fact from `remember_about_user`. */
  remember(fact: unknown): { ok: boolean; text: string };
}

export class ProfileService implements ProfileAccess {
  readonly file: string;
  private cache?: { mtime: number; text: string };

  constructor(
    dir: string,
    private opts: { settings: () => AppSettings | undefined; projects: () => Project[]; emit?: (p: UserProfile) => void; locale?: () => string | undefined },
  ) {
    this.file = path.join(dir, PROFILE_FILE);
  }

  enabled() {
    return profileEnabled(this.opts.settings());
  }

  /** The file's text, written from what is known first when there is none. */
  text(): string {
    if (!existsSync(this.file)) {
      const seed = seedProfile({ locale: this.opts.locale?.() ?? Intl.DateTimeFormat().resolvedOptions().locale, projects: this.opts.projects(), readFile: readSmall });
      this.save(seed, false);
      return seed;
    }
    try {
      const mtime = statSync(this.file).mtimeMs;
      if (this.cache?.mtime === mtime) return this.cache.text;
      const text = readFileSync(this.file, 'utf8');
      this.cache = { mtime, text };
      return text;
    } catch {
      return '';
    }
  }

  view(text = this.text()): UserProfile {
    const { own, entries } = parseProfile(text);
    return { text: own, path: this.file, entries, promptWords: wordCount(compactProfile(text)) };
  }

  prompt(tool: boolean): string {
    if (!this.enabled()) return '';
    return profilePrompt(compactProfile(this.text()), tool);
  }

  remember(fact: unknown): { ok: boolean; text: string } {
    if (!this.enabled()) return { ok: false, text: 'The user turned the profile off.' };
    if (typeof fact !== 'string') return { ok: false, text: 'Say the fact in `fact`.' };
    const r = remember(this.text(), fact);
    if (r.ok && r.profile !== this.text()) this.save(r.profile);
    return { ok: r.ok, text: r.text };
  }

  /** The user's own part, as edited in Settings; the additions stay. */
  write(own: string): UserProfile {
    const text = formatProfile(String(own ?? '').slice(0, MAX_TEXT), parseProfile(this.text()).entries);
    this.save(text);
    return this.view(text);
  }

  forget(id: string): UserProfile {
    const text = forget(this.text(), id);
    this.save(text);
    return this.view(text);
  }

  private save(text: string, announce = true) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, this.file);
    this.cache = undefined;
    if (announce) this.opts.emit?.(this.view(text));
  }
}

/** A small text file, or undefined (missing, unreadable, or larger than 256 KB). */
function readSmall(file: string): string | undefined {
  try {
    if (statSync(file).size > 256_000) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

const services = new WeakMap<App, ProfileService>();

/** The app's profile (one per app; providers reach it through their context). */
export function profileOf(app: App): ProfileService {
  let s = services.get(app);
  if (!s) {
    s = new ProfileService(app.store.dir, {
      settings: () => app.store.state.settings,
      projects: () => app.store.state.projects,
      emit: (profile) => app.emit({ type: 'profile.updated', profile }),
    });
    services.set(app, s);
  }
  return s;
}

export function registerProfile(app: App) {
  const profile = () => profileOf(app);
  app.register('profile.read', () => profile().view());
  app.register('profile.write', ({ text }) => {
    if (typeof text !== 'string') throw new Error('Missing text');
    return profile().write(text);
  });
  app.register('profile.forget', ({ id }) => {
    if (typeof id !== 'string' || !id) throw new Error('Missing id');
    return profile().forget(id);
  });
}
