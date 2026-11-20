/**
 * Chat titles by a small model (server/core/titles.ts): the prompt, the cleaning of what comes back,
 * when a chat is named (once, after its first turn, never over a title the person set), and the
 * one-shot query Claude Code is asked with. Fake models only: nothing here calls a real one.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type SessionMeta, type TimelineItem } from '@shared/protocol';
import { App } from '../server/app';
import { cleanTitle, titleAsk, titlePrompt, TITLE_SYSTEM, wantsTitle, type TitlePrompt } from '../server/core/titles';
import { ClaudeProvider, titleOptions } from '../server/providers/claude';
import { DemoProvider, demoTitle } from '../server/providers/demo';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function until(pred: () => boolean, what: string, ms = 6000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

let n = 0;
const item = (x: Partial<TimelineItem> & { type: TimelineItem['type'] }) => ({ id: `i${++n}`, ts: n, ...x }) as TimelineItem;

describe('the prompt', () => {
  it('holds the instructions, the first message and the start of the answer', () => {
    const p = titlePrompt({ message: 'Wer ist Halvard? Lies ihre Seite.', answer: 'Halvard ist ein kleines Studio in Porto.' }, 'C:/work');
    expect(p.system).toBe(TITLE_SYSTEM);
    expect(p.system).toMatch(/3 to 6 words, sentence case, no quotes, no trailing period/);
    expect(p.system).toMatch(/language of the person's message/);
    expect(p.user).toContain('<message>\nWer ist Halvard? Lies ihre Seite.\n</message>');
    expect(p.user).toContain('<answer>\nHalvard ist ein kleines Studio in Porto.\n</answer>');
    expect(p.cwd).toBe('C:/work');
  });

  it('cuts a long message and leaves out an answer that is not there', () => {
    const p = titlePrompt({ message: 'x'.repeat(5000), answer: '' }, '.');
    expect(p.user.length).toBeLessThan(2200);
    expect(p.user).not.toContain('<answer>');
  });

  it('takes the person\'s first message (not Claude Code\'s own, not a sub-agent\'s) and the answer up to the next message', () => {
    const items = [
      item({ type: 'user', text: '<task-notification><status>completed</status><summary>Background command "x" completed</summary></task-notification>', state: 'sent' }),
      item({ type: 'user', text: 'Refactor the auth middleware', state: 'sent' }),
      item({ type: 'text', text: 'Inner words', parentId: 'tool1', streaming: false }),
      item({ type: 'text', text: 'Moved the expiry check into its own module.', streaming: false }),
      item({ type: 'text', text: 'Tests pass.', streaming: false }),
      item({ type: 'user', text: 'thanks', state: 'sent' }),
      item({ type: 'text', text: 'Any time.', streaming: false }),
    ];
    expect(titleAsk(items)).toEqual({ message: 'Refactor the auth middleware', answer: 'Moved the expiry check into its own module.\n\nTests pass.' });
    expect(titleAsk([item({ type: 'text', text: 'hello', streaming: false })])).toBeNull();
  });
});

describe('what comes back', () => {
  it('becomes a clean title', () => {
    expect(cleanTitle('Halvard studio overview')).toBe('Halvard studio overview');
    expect(cleanTitle('"Refactor auth middleware."')).toBe('Refactor auth middleware');
    expect(cleanTitle('Title: Plan a weekend in Porto')).toBe('Plan a weekend in Porto');
    expect(cleanTitle('**Title:** Fix the flaky login test')).toBe('Fix the flaky login test');
    expect(cleanTitle('# Session expiry cleanup\n\nThis title names…')).toBe('Session expiry cleanup');
    expect(cleanTitle('  „Wer ist Halvard“  ')).toBe('Wer ist Halvard');
    expect(cleanTitle('fix the build on windows')).toBe('Fix the build on windows');
    expect(cleanTitle('Why does the build fail?')).toBe('Why does the build fail?');
    expect(cleanTitle('ログイン画面の修正。')).toBe('ログイン画面の修正');
    expect(cleanTitle('`dev server` port clash...')).toBe('Dev server` port clash');
  });

  it('is dropped when it is no title', () => {
    expect(cleanTitle('')).toBeNull();
    expect(cleanTitle(null)).toBeNull();
    expect(cleanTitle('   \n  ')).toBeNull();
    expect(cleanTitle("I can't help with naming this chat")).toBeNull();
    expect(cleanTitle('Sorry, I need more context')).toBeNull();
    expect(cleanTitle('This chat is about refactoring the authentication middleware so that session expiry lives in one place')).toBeNull();
  });
});

describe('when a chat is named', () => {
  const meta = (x: Partial<SessionMeta> = {}) => ({ id: 's', provider: 'claude', cwd: '.', title: 'Refactor the auth', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 1 }, ...x }) as SessionMeta;
  const one = [item({ type: 'user', text: 'hi', state: 'sent' }), item({ type: 'turn', durationMs: 1 })];
  const two = [...one, item({ type: 'user', text: 'more', state: 'sent' }), item({ type: 'turn', durationMs: 1 })];
  const failedFirst = [item({ type: 'user', text: 'hi', state: 'sent' }), item({ type: 'turn', durationMs: 1, error: 'boom' }), item({ type: 'turn', durationMs: 1 })];

  it('after its first turn that settled, once', () => {
    expect(wantsTitle(meta(), one, {})).toBe(true);
    expect(wantsTitle(meta(), two, {})).toBe(false);
    expect(wantsTitle(meta(), failedFirst, {})).toBe(true);
    expect(wantsTitle(meta({ titleAsked: true }), one, {})).toBe(false);
  });

  it('never over a title the person set, never with the setting off, never a race\'s chats', () => {
    expect(wantsTitle(meta({ titleSource: 'user' }), one, {})).toBe(false);
    expect(wantsTitle(meta(), one, { chatTitles: false })).toBe(false);
    expect(wantsTitle(meta({ race: { id: 'r', side: 'a' } as unknown as SessionMeta['race'] }), one, {})).toBe(false);
  });
});

// ─────────────────────── in the bridge, with a fake small model ───────────────────────

interface Fake {
  asked: TitlePrompt[];
  answer: (p: TitlePrompt) => Promise<string | null>;
}

async function bridge(opts: { answer?: Fake['answer']; settings?: Partial<typeof DEFAULT_SETTINGS> } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-titles-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const fake: Fake = { asked: [], answer: opts.answer ?? (async () => 'Session module cleanup') };
  const app = new App({
    home,
    providers: [
      (ctx) => {
        const p = new DemoProvider(ctx, { speed: 0 });
        p.quickTitle = async (prompt) => {
          fake.asked.push(prompt);
          return fake.answer(prompt);
        };
        return p;
      },
    ],
    quiet: true,
  });
  cleanups.push(() => app.dispose());
  if (opts.settings) await app.call('app.setSettings', { patch: opts.settings });
  const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'proj'), mode: 'default' });
  const id = snap.session.id;
  const rt = app.runtime(id);
  const send = async (text: string) => {
    await app.call('session.send', { sessionId: id, text });
    await until(() => !rt.turnActive && rt.meta.status !== 'running', 'turn end');
  };
  return { app, id, rt, fake, send };
}

describe('a chat named in the bridge', () => {
  it('gets the small model\'s title after its first turn, from its first message, and only once', async () => {
    const h = await bridge();
    await h.send('hi there, nice day');
    await until(() => h.rt.meta.title === 'Session module cleanup', 'title');
    expect(h.fake.asked).toHaveLength(1);
    expect(h.fake.asked[0].user).toContain('hi there, nice day');
    expect(h.rt.meta).toMatchObject({ titleSource: 'auto', titleAsked: true });
    await h.send('hi again');
    await tick(50);
    expect(h.fake.asked).toHaveLength(1);
  });

  it('keeps a title the person set before the first turn ended: the model is not asked', async () => {
    const h = await bridge();
    await h.app.call('session.rename', { sessionId: h.id, title: 'My own name' });
    await h.send('hi');
    await tick(50);
    expect(h.fake.asked).toHaveLength(0);
    expect(h.rt.meta.title).toBe('My own name');
  });

  it('keeps a title the person set while the model was being asked', async () => {
    let release!: (t: string) => void;
    const h = await bridge({ answer: () => new Promise((r) => (release = r)) });
    await h.send('hi');
    await until(() => h.fake.asked.length === 1, 'asked');
    await h.app.call('session.rename', { sessionId: h.id, title: 'Renamed meanwhile' });
    release('Model title');
    await tick(50);
    expect(h.rt.meta).toMatchObject({ title: 'Renamed meanwhile', titleSource: 'user' });
  });

  it('keeps its title when the model fails or says nothing usable, and does not ask again', async () => {
    const h = await bridge({ answer: async () => Promise.reject(new Error('offline')) });
    await h.send('hi');
    await until(() => h.fake.asked.length === 1, 'asked');
    await tick(50);
    expect(h.rt.meta.title).toBe('hi');
    await h.send('hi there');
    await tick(50);
    expect(h.fake.asked).toHaveLength(1);

    const g = await bridge({ answer: async () => "I can't name this" });
    await g.send('hi');
    await until(() => g.fake.asked.length === 1, 'asked');
    await tick(50);
    expect(g.rt.meta.title).toBe('hi');
  });

  it('is not named with the setting off', async () => {
    const h = await bridge({ settings: { chatTitles: false } });
    await h.send('hi');
    await tick(50);
    expect(h.fake.asked).toHaveLength(0);
    expect(h.rt.meta.titleAsked).toBeUndefined();
  });

  it('asks one title at a time: the turn never waits on it', async () => {
    const releases: ((t: string) => void)[] = [];
    const h = await bridge({ answer: () => new Promise((r) => releases.push(r)) });
    const snap = await h.app.call('session.create', { provider: 'demo', cwd: h.rt.meta.cwd, mode: 'default' });
    const other = h.app.runtime(snap.session.id);
    await h.send('hi');
    await h.app.call('session.send', { sessionId: other.id, text: 'hello' });
    await until(() => !other.turnActive && other.meta.titleAsked === true, 'second turn');
    // Both turns are over while the first title is still being asked; the second waits its turn.
    expect(h.fake.asked).toHaveLength(1);
    releases[0]('First title');
    await until(() => h.fake.asked.length === 2, 'second asked');
    releases[1]('Second title');
    await until(() => other.meta.title === 'Second title', 'second title');
    expect(h.rt.meta.title).toBe('First title');
  });
});

describe('the Demo\'s pretend small model', () => {
  it('names a chat from the message\'s own words', () => {
    expect(demoTitle(titlePrompt({ message: 'hi, can you refactor the session module please', answer: '' }, '.').user)).toBe('Refactor the session module please');
    expect(demoTitle(titlePrompt({ message: 'Plan a weekend trip to Porto in May.', answer: '' }, '.').user)).toBe('Plan a weekend trip to');
  });
});

describe("Claude Code's one-shot title query", () => {
  it('is Haiku with no tools, settings, MCP servers or thinking, one turn, a small output cap, nothing kept, on the account\'s own config', () => {
    const p = new ClaudeProvider({ emit: () => {}, log: () => {}, account: { id: 'work', dir: path.join(tmpdir(), 'claude-work') } });
    const o = titleOptions(titlePrompt({ message: 'hi', answer: '' }, process.cwd()), p.env(), new AbortController());
    expect(o).toMatchObject({ model: 'haiku', tools: [], allowedTools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true, thinking: { type: 'disabled' }, maxTurns: 1, persistSession: false, cwd: process.cwd() });
    expect(o.systemPrompt).toBe(TITLE_SYSTEM);
    expect(o.env?.CLAUDE_CONFIG_DIR).toBe(path.join(tmpdir(), 'claude-work'));
    expect(Number(o.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS)).toBeLessThanOrEqual(128);
    // Any tool call is refused.
    return expect(o.canUseTool!('Bash', {}, {} as never)).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('runs in the chat\'s folder, or the home folder when that is gone', () => {
    const o = titleOptions(titlePrompt({ message: 'hi', answer: '' }, path.join(tmpdir(), 'no-such-folder-x9')), {}, new AbortController());
    expect(o.cwd).not.toContain('no-such-folder-x9');
  });
});

describe('which model names a chat', () => {
  it("a Claude chat: Claude Code's Haiku on the chat's own account; a Codex chat: Claude's when Claude Code is signed in, else none", async () => {
    const { CodexProvider } = await import('../server/providers/codex');
    const home = mkdtempSync(path.join(tmpdir(), 'sable-titles-route-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const asked: string[] = [];
    const quiet = (p: object) => {
      const any = p as Record<string, unknown>;
      any.info = async () => ({ id: 'x', name: 'x', installed: true, auth: { loggedIn: true } });
      any.caps = async () => ({ models: [], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: {} });
      any.limits = async () => [];
      return p;
    };
    const app = new App({
      home,
      quiet: true,
      providers: [
        (ctx) => {
          const p = quiet(new ClaudeProvider(ctx)) as ClaudeProvider;
          p.quickTitle = async () => (asked.push(`claude:${ctx.account?.id ?? 'default'}`), 'From Haiku');
          return p;
        },
        (ctx) => quiet(new CodexProvider(ctx)) as InstanceType<typeof CodexProvider>,
      ],
    });
    cleanups.push(() => app.dispose());
    const a = app as unknown as { titleModel(rt: unknown): ((p: TitlePrompt, s: AbortSignal) => Promise<string | null>) | undefined; cache: { set(k: string, v: unknown): void; get(k: string): unknown } };
    const prompt = titlePrompt({ message: 'hi', answer: '' }, home);
    const signal = new AbortController().signal;
    const claudeChat = { meta: { provider: 'claude' } };
    const codexChat = { meta: { provider: 'codex' } };

    expect(await a.titleModel(claudeChat)!(prompt, signal)).toBe('From Haiku');
    expect(asked).toEqual(['claude:default']);
    // Codex has no small model of its own here: Claude's, only while Claude Code is signed in.
    a.cache.set('info:claude', { id: 'claude', name: 'Claude Code', installed: true, auth: { loggedIn: false } });
    expect(a.titleModel(codexChat)).toBeUndefined();
    a.cache.set('info:claude', { id: 'claude', name: 'Claude Code', installed: true, auth: { loggedIn: true } });
    expect(await a.titleModel(codexChat)!(prompt, signal)).toBe('From Haiku');
  });
});
