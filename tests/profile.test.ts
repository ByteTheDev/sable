/**
 * The user's profile (`<home>/profile.md`): merging the facts agents add (dedupe, dates, a cap,
 * never secrets), the compact form agents get, the first profile, the service and both agents'
 * tool. No agent runs here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings, type Project, type ToolItem, type UserProfile } from '@shared/protocol';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import { describeTool } from '../server/providers/claude-tools';
import { draftItem } from '../server/providers/codex-map';
import { PROFILE_TOOL, PROFILE_TOOL_ID, describeProfileCall } from '../server/providers/profile-tool';
import { WIDGET_SERVER } from '../server/providers/widget-tool';
import {
  MAX_ENTRIES,
  ProfileService,
  compactProfile,
  designTaste,
  forget,
  formatProfile,
  parseProfile,
  remember,
  secretReason,
  seedProfile,
} from '../server/services/profile';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'sable-profile-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const OWN = '# Profile\n\n## Language\n\n- Writes in German and English.\n';

describe('profile file', () => {
  it('keeps the user part and the dated additions apart, and writes them back the same', () => {
    const text = formatProfile(OWN, [
      { id: 'a', text: 'Prefers short answers', date: '2026-11-19' },
      { id: 'b', text: 'Uses pnpm', date: '2026-11-18' },
    ]);
    expect(text).toContain('## Learned\n\n- Prefers short answers (2026-11-19)\n- Uses pnpm (2026-11-18)\n');
    const p = parseProfile(text);
    expect(p.own).toBe(OWN.trimEnd());
    expect(p.entries.map((e) => [e.text, e.date])).toEqual([
      ['Prefers short answers', '2026-11-19'],
      ['Uses pnpm', '2026-11-18'],
    ]);
    expect(formatProfile(p.own, p.entries)).toBe(text);
  });

  it('a section after Learned and stray lines in it stay the user’s', () => {
    const p = parseProfile('# P\n\n## Learned\n\n- Uses pnpm (2026-11-18)\nmy own note\n\n## Later\n\n- mine\n');
    expect(p.entries).toHaveLength(1);
    expect(p.own).toContain('my own note');
    expect(p.own).toContain('## Later');
  });
});

describe('remember', () => {
  it('adds a fact on top, dated', () => {
    const r = remember(OWN, '  - Prefers answers in German  ', '2026-11-19');
    expect(r.ok && r.status).toBe('added');
    if (!r.ok) return;
    expect(parseProfile(r.profile).entries[0]).toMatchObject({ text: 'Prefers answers in German', date: '2026-11-19' });
  });

  it('a fact said again is dated anew and moves up; a close rewording replaces the older one', () => {
    let text = formatProfile(OWN, [
      { id: '1', text: 'Uses pnpm, never npm', date: '2026-11-10' },
      { id: '2', text: 'Likes dark interfaces with quiet controls', date: '2026-11-12' },
    ]);
    const again = remember(text, 'uses pnpm, never npm.', '2026-11-19');
    expect(again.ok && again.status).toBe('known');
    if (!again.ok) return;
    text = again.profile;
    expect(parseProfile(text).entries.map((e) => [e.text, e.date])).toEqual([
      ['uses pnpm, never npm.', '2026-11-19'],
      ['Likes dark interfaces with quiet controls', '2026-11-12'],
    ]);
    const reworded = remember(text, 'Likes dark interfaces with very quiet controls', '2026-11-19');
    expect(reworded.ok && reworded.status).toBe('updated');
    if (!reworded.ok) return;
    expect(parseProfile(reworded.profile).entries).toHaveLength(2);
    expect(parseProfile(reworded.profile).entries[0].text).toBe('Likes dark interfaces with very quiet controls');
  });

  it('what the user wrote already is not added again', () => {
    const r = remember(OWN, 'Writes in German and English', '2026-11-19');
    expect(r.ok && r.status).toBe('known');
  });

  it('refuses secrets, keys, email addresses, card numbers; too long or empty', () => {
    for (const bad of [
      'His email is leon@example.com',
      'The API key is sk-ant-api03-abcdefghijklmnop',
      'password: hunter2',
      'Sein Passwort ist sommer2026',
      'Uses token ghp_1234567890abcdefghijklmnopqrstuv',
      'Deploy key AbC123dEf456GhI789jKl012MnO345',
      'Card 4111 1111 1111 1111',
    ]) {
      expect(secretReason(bad), bad).toBeTruthy();
      expect(remember(OWN, bad).ok, bad).toBe(false);
    }
    expect(remember(OWN, 'x'.repeat(300)).ok).toBe(false);
    expect(remember(OWN, '  ').ok).toBe(false);
    // Plain facts about keys and tokens are fine.
    for (const fine of ['Prefers token-efficient answers', 'Works on D:\\projects\\app', 'Uses a Windows 11 laptop with 32 GB of RAM', 'Keeps API keys in a password manager']) expect(secretReason(fine), fine).toBeUndefined();
  });

  it('keeps at most MAX_ENTRIES additions, dropping the oldest', () => {
    let text = OWN;
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      const r = remember(text, `Fact number ${i} about project ${'abcdefghij'[i % 10]}${i}`, '2026-11-19');
      if (r.ok) text = r.profile;
    }
    const entries = parseProfile(text).entries;
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries[0].text).toContain(`Fact number ${MAX_ENTRIES + 4}`);
    expect(entries.some((e) => e.text.startsWith('Fact number 0 '))).toBe(false);
  });

  it('forget removes one addition', () => {
    const r = remember(OWN, 'Prefers short answers', '2026-11-19');
    if (!r.ok) throw new Error('not added');
    const id = parseProfile(r.profile).entries[0].id;
    expect(parseProfile(forget(r.profile, id)).entries).toHaveLength(0);
  });
});

describe('the compact form agents get', () => {
  it('puts the user part first, then the additions newest first, within the budget', () => {
    const own = '# Profile\n\n## Empty\n\n## Taste\n\n- ' + 'calm '.repeat(30).trim() + '\n';
    const text = formatProfile(own, [
      { id: '1', text: 'Newest fact', date: '2026-11-19' },
      { id: '2', text: 'Older fact', date: '2026-11-01' },
    ]);
    const c = compactProfile(text);
    expect(c.startsWith('## Taste')).toBe(true);
    expect(c).not.toContain('## Empty');
    expect(c).not.toContain('# Profile');
    expect(c.indexOf('Newest fact')).toBeLessThan(c.indexOf('Older fact'));
    expect(c).not.toContain('2026-11-19');
    const words = (s: string) => (s.match(/\S+/g) ?? []).length;
    const big = formatProfile('# P\n\n' + Array.from({ length: 200 }, (_, i) => `- line ${i} with some words here`).join('\n'), Array.from({ length: 50 }, (_, i) => ({ id: String(i), text: `Learned thing ${i} with words`, date: '2026-11-19' })));
    const cb = compactProfile(big, 600);
    expect(words(cb)).toBeLessThanOrEqual(620);
    expect(cb).toContain('Learned thing 0 ');
  });
});

describe('the first profile', () => {
  const projects: Project[] = [
    { path: 'D:\\work\\sable', name: 'sable', lastOpened: 3 },
    { path: 'D:\\Sable chats\\2026-11-19 hello', name: '2026-11-19 hello', lastOpened: 4 },
    { path: 'D:\\work\\site', name: 'site', lastOpened: 2 },
    { path: 'D:\\old', name: 'old', lastOpened: 1, hidden: true },
  ];

  it('the language, the taste a project describes, the folders in the sidebar (not chats, not hidden)', () => {
    const files: Record<string, string> = {
      [path.join('D:\\work\\sable', 'CLAUDE.md')]: '# X\n\n## Design language (read this twice)\n\nThe brief: modern, simple, clean; dark, calm panels.\n\n- Monochrome: ink surfaces.\n',
    };
    const seed = seedProfile({ locale: 'de-DE', projects, readFile: (p) => files[p], exists: () => true });
    expect(seed).toContain('- Writes in German and English. Answer in the language of each message.');
    expect(seed).toContain("- From sable's instructions: The brief: modern, simple, clean; dark, calm panels.");
    expect(seed).toContain('- sable (D:\\work\\sable)\n- site (D:\\work\\site)');
    expect(seed).not.toContain('hello');
    expect(seed).not.toContain('old');
    expect(seedProfile({ locale: 'en-US', projects: [] })).toContain('- Answer in the language of each message.');
    // Folders that are gone are left out.
    expect(seedProfile({ locale: 'en-US', projects, exists: (p) => p.endsWith('site') })).not.toContain('sable (');
  });

  it('design taste: the first prose of a design section, cut near 90 words', () => {
    expect(designTaste('# A\n\n## Build\n\nnpm test\n')).toBeUndefined();
    const long = designTaste(`## Visual style\n\n${'Word. '.repeat(200)}`)!;
    expect(long.split(' ').length).toBeLessThanOrEqual(91);
  });
});

describe('the profile service', () => {
  const service = (dir: string, settings: Partial<AppSettings> = {}, events: UserProfile[] = []) =>
    new ProfileService(dir, { settings: () => ({ ...DEFAULT_SETTINGS, ...settings }), projects: () => [{ path: 'D:\\work\\sable', name: 'sable', lastOpened: 1 }], emit: (p) => events.push(p), locale: () => 'de-DE' });

  it('writes the first profile once, never over one that exists (even an empty one)', () => {
    const dir = tmp();
    const s = service(dir);
    expect(s.text()).toContain('- Writes in German and English.');
    writeFileSync(path.join(dir, 'profile.md'), '');
    expect(service(dir).text()).toBe('');
  });

  it('an edit keeps the agents’ additions; remember announces the change; forget removes', () => {
    const dir = tmp();
    const events: UserProfile[] = [];
    const s = service(dir, {}, events);
    expect(s.remember('Prefers short answers').ok).toBe(true);
    expect(events.at(-1)?.entries[0].text).toBe('Prefers short answers');
    const v = s.write('# Me\n\nI like calm tools.');
    expect(v.text).toBe('# Me\n\nI like calm tools.');
    expect(v.entries).toHaveLength(1);
    expect(readFileSync(path.join(dir, 'profile.md'), 'utf8')).toContain('- Prefers short answers (');
    expect(s.prompt(true)).toContain('I like calm tools.');
    expect(s.prompt(true)).toContain('- Prefers short answers');
    expect(s.forget(v.entries[0].id).entries).toHaveLength(0);
  });

  it('off: no prompt, no remembering, and no file written', () => {
    const dir = tmp();
    const s = service(dir, { userProfile: false });
    expect(s.prompt(true)).toBe('');
    expect(s.remember('Prefers short answers').ok).toBe(false);
    expect(existsSync(path.join(dir, 'profile.md'))).toBe(false);
  });
});

describe('agents get the profile and the tool', () => {
  const setup = (settings: Partial<AppSettings> = {}) => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const svc = new ProfileService(dir, { settings: () => ({ ...DEFAULT_SETTINGS, ...settings }), projects: () => [], locale: () => 'en-US' });
    svc.write('## How I like answers\n\n- Result first.');
    const ctx = { emit: () => {}, log: () => {}, settings: () => ({ ...DEFAULT_SETTINGS, ...settings }), profile: () => svc };
    return { svc, ctx };
  };
  const meta = { cwd: process.cwd(), model: '', mode: 'default' };

  it('Claude: in the appended prompt, and remember_about_user allowed on Sable’s server', () => {
    const { ctx } = setup();
    const p = new ClaudeProvider(ctx);
    const opts = p.agentOptions({ ...meta, options: { browserTab: false } }, {});
    const sp = opts.systemPrompt as { append?: string };
    expect(sp.append).toContain('<user_profile>');
    expect(sp.append).toContain('- Result first.');
    expect(sp.append).toContain('remember_about_user');
    expect(opts.allowedTools).toContain(PROFILE_TOOL_ID);
    expect(opts.mcpServers?.[WIDGET_SERVER]).toBeTruthy();
    expect(PROFILE_TOOL_ID).toBe('mcp__sable__remember_about_user');
  });

  it('Claude: off means neither', () => {
    const { ctx } = setup({ userProfile: false, generativeUi: false });
    const opts = new ClaudeProvider(ctx).agentOptions({ ...meta, options: { browserTab: false } }, {});
    expect(JSON.stringify(opts.systemPrompt)).not.toContain('user_profile');
    expect(opts.allowedTools ?? []).not.toContain(PROFILE_TOOL_ID);
    expect(opts.mcpServers?.[WIDGET_SERVER]).toBeUndefined();
  });

  it('Codex: a dynamic tool and the instructions; the call merges the fact', async () => {
    const { ctx, svc } = setup();
    const p = new CodexProvider(ctx);
    expect(p.dynamicTools()?.some((t) => t.name === PROFILE_TOOL)).toBe(true);
    (p as unknown as { client: () => Promise<unknown> }).client = async () => ({ request: async () => ({ config: {} }) });
    expect(await p.developerInstructions(process.cwd())).toContain('<user_profile>');
    expect(p.rememberAboutUser({ fact: 'Runs Windows 11' })).toEqual({ ok: true, text: 'Remembered.' });
    expect(svc.view().entries[0].text).toBe('Runs Windows 11');
    expect(p.rememberAboutUser({ fact: 'mail me at a@b.co' }).ok).toBe(false);
    expect(new CodexProvider(setup({ userProfile: false }).ctx).dynamicTools()?.some((t) => t.name === PROFILE_TOOL) ?? false).toBe(false);
  });

  it('the timeline shows a call as one line with the fact', () => {
    expect(describeTool(PROFILE_TOOL_ID, { fact: 'Prefers short answers' })).toMatchObject({ kind: 'other', title: 'Remember: Prefers short answers' });
    const codex = draftItem({ type: 'dynamicToolCall', id: 'c1', namespace: null, tool: PROFILE_TOOL, arguments: { fact: 'Runs Windows 11' }, status: 'completed', contentItems: [{ type: 'inputText', text: 'Remembered.' }], success: true } as never) as ToolItem;
    expect(codex).toMatchObject({ kind: 'other', title: 'Remember: Runs Windows 11', status: 'done', result: { text: 'Remembered.' } });
    expect(describeProfileCall({}).title).toBe('Remember about you');
  });
});
