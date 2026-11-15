import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../server/app';
import { registerServices } from '../server/services';
import { maskCommand, maskToml } from '../server/services/config';

let base = '';
let userHome = '';
let project = '';
let app: App;

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'sable-config-'));
  userHome = path.join(base, 'home');
  project = path.join(base, 'project');
  mkdirSync(path.join(userHome, '.claude'), { recursive: true });
  mkdirSync(path.join(userHome, '.codex'), { recursive: true });
  mkdirSync(path.join(project, '.claude'), { recursive: true });

  writeFileSync(
    path.join(userHome, '.claude', 'settings.json'),
    JSON.stringify({
      apiKeyHelper: '/bin/print-key',
      env: { ANTHROPIC_API_KEY: 'sk-ant-SECRET', OTHER: 'x' },
      model: 'opus',
      permissions: { allow: ['Read', 'Bash(git status)', 42], deny: ['Read(./.env)'], defaultMode: 'acceptEdits', additionalDirectories: ['../lib'], token: 'nope' },
      hooks: {
        PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'prettier --write', timeout: 30, secretToken: 'zzz' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'curl -H "Authorization: Bearer abcdef123456" https://x.test' }] }],
      },
    }),
  );
  writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(git push:*)'] } }));
  writeFileSync(path.join(project, '.claude', 'settings.local.json'), '{ not json');

  app = new App({ home: path.join(base, 'store'), providers: [], quiet: true });
  registerServices(app, { userHome });
});

afterAll(async () => {
  await app?.dispose();
  rmSync(base, { recursive: true, force: true });
});

describe('config.read', () => {
  it('reads claude rules and hooks per scope without secrets', async () => {
    const files = await app.call('config.read', { provider: 'claude', cwd: project });
    expect(files.map((f) => [f.path, f.scope, f.exists])).toEqual([
      [path.join(userHome, '.claude', 'settings.json'), 'user', true],
      [path.join(project, '.claude', 'settings.json'), 'project', true],
      [path.join(project, '.claude', 'settings.local.json'), 'local', true],
    ]);
    const [user, shared, local] = files;
    expect(user.permissions).toEqual({ allow: ['Read', 'Bash(git status)'], ask: [], deny: ['Read(./.env)'], defaultMode: 'acceptEdits', additionalDirectories: ['../lib'] });
    expect(user.hooks).toEqual([
      { event: 'PostToolUse', matcher: 'Edit|Write', command: 'prettier --write', type: 'command' },
      { event: 'Stop', matcher: undefined, command: 'curl -H "Authorization: Bearer [hidden]" https://x.test', type: 'command' },
    ]);
    const json = JSON.stringify(files);
    for (const secret of ['sk-ant-SECRET', 'print-key', 'apiKeyHelper', 'ANTHROPIC_API_KEY', 'zzz', 'nope', 'abcdef123456', 'opus']) expect(json).not.toContain(secret);
    expect(shared.permissions?.ask).toEqual(['Bash(git push:*)']);
    expect(shared.hooks).toEqual([]);
    expect(local.error).toMatch(/not valid JSON/);
    expect(local.permissions).toBeUndefined();
  });

  it('reports missing files and only the user file without a folder', async () => {
    const other = path.join(base, 'empty');
    mkdirSync(other);
    const files = await app.call('config.read', { provider: 'claude', cwd: other });
    expect(files.slice(1).every((f) => !f.exists && !f.permissions)).toBe(true);
    expect(await app.call('config.read', { provider: 'claude' })).toHaveLength(1);
  });

  it('returns the codex config text with secret values masked and capped', async () => {
    const file = path.join(userHome, '.codex', 'config.toml');
    expect(await app.call('config.read', { provider: 'codex' })).toEqual([{ path: file, scope: 'user', exists: false, format: 'toml' }]);
    writeFileSync(
      file,
      [
        'model = "gpt-5"',
        'approval_policy = "on-request"',
        'api_key = "sk-live-123"',
        '',
        '[mcp_servers.github]',
        'command = "npx"',
        'env = { GITHUB_TOKEN = "ghp_abc", DEBUG = "1" }',
        'args = ["-y", "server"]',
        '',
        '[mcp_servers.other.env]',
        'PLAIN = "visible-only-by-name"',
        '',
        '[mcp_servers.third]',
        'config = { url = "https://x.test", bearer_token = "tok_999" }',
        'secret_lines = """',
        'line one',
        'line two',
        '"""',
        'after = true',
      ].join('\n'),
    );
    const [codex] = await app.call('config.read', { provider: 'codex' });
    expect(codex.exists).toBe(true);
    expect(codex.raw).toContain('model = "gpt-5"');
    expect(codex.raw).toContain('args = ["-y", "server"]');
    expect(codex.raw).toContain('api_key = "[hidden]"');
    expect(codex.raw).toContain('env = "[hidden]"');
    expect(codex.raw).toContain('config = { url = "https://x.test", bearer_token = "[hidden]" }');
    expect(codex.raw).toContain('after = true');
    for (const secret of ['sk-live-123', 'ghp_abc', 'visible-only-by-name', 'tok_999', 'line one']) expect(codex.raw).not.toContain(secret);

    writeFileSync(file, `# big\n${'x = 1\n'.repeat(20_000)}`);
    const [big] = await app.call('config.read', { provider: 'codex' });
    expect(big.truncated).toBe(true);
    expect(big.raw!.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('returns a canned example for the demo agent', async () => {
    const files = await app.call('config.read', { provider: 'demo', cwd: project });
    expect(files.map((f) => f.scope)).toEqual(['user', 'project', 'local']);
    expect(files[0].permissions?.allow.length).toBeGreaterThan(0);
    expect(files[1].hooks?.length).toBeGreaterThan(0);
  });
});

describe('masking helpers', () => {
  it('masks token-like command arguments and assignments', () => {
    expect(maskCommand('API_KEY=abc123 run --token xyz --api-key=foo ok')).toBe('API_KEY=[hidden] run --token [hidden] --api-key=[hidden] ok');
    expect(maskCommand('echo hello')).toBe('echo hello');
  });

  it('masks multi-line arrays under secret keys', () => {
    expect(maskToml('tokens = [\n  "a",\n  "b",\n]\nnext = 1')).toBe('tokens = "[hidden]"\nnext = 1');
  });
});
