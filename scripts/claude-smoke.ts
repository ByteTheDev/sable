/**
 * Smoke test for the Claude Code adapter. Usage:
 *   pnpm exec tsx scripts/claude-smoke.ts            # info, caps, history (no tokens)
 *   pnpm exec tsx scripts/claude-smoke.ts --turn     # plus one tiny real turn on Haiku
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BridgeEvent, SessionMeta, UserItem } from '../shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { ClaudeProvider } from '../server/providers/claude';

const events: BridgeEvent[] = [];
const emit = (e: BridgeEvent) => {
  events.push(e);
  if (e.type === 'item.delta') process.stdout.write(e.field === 'text' ? e.delta : '');
  else if (e.type === 'item.added') console.log(`\n+ ${e.item.type}${e.item.type === 'tool' ? ` ${e.item.name} (${e.item.title})` : ''}`);
  else if (e.type === 'item.patch') console.log(`\n~ patch ${JSON.stringify(e.patch).slice(0, 160)}`);
  else if (e.type === 'session.updated') console.log(`\n~ session ${JSON.stringify(e.patch).slice(0, 200)}`);
  else if (e.type === 'limits.updated') console.log(`\n~ limits ${JSON.stringify(e.limits)}`);
  else if (e.type !== 'session.caps') console.log(`\n* ${e.type}`);
};

const provider = new ClaudeProvider({ emit, log: (...a) => console.log('[log]', ...a) });

/**
 * --probe: start one agent process (no prompt, no tokens) and print what it reports.
 *   --extra chrome            pass a CLI flag (repeatable; "name=value" for flags with a value)
 *   --settings '{"k":true}'   flag settings for the process
 */
if (process.argv.includes('--probe')) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const extraArgs: Record<string, string | null> = {};
  const settingsAt = process.argv.indexOf('--settings');
  process.argv.forEach((a, i) => {
    if (a !== '--extra') return;
    const [k, v] = process.argv[i + 1].split('=');
    extraArgs[k] = v ?? null;
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'sable-probe-'));
  const input = (async function* () {
    await new Promise((r) => setTimeout(r, 60_000));
  })();
  const q = query({
    prompt: input as never,
    options: {
      ...provider.baseOptions(dir),
      persistSession: false,
      extraArgs,
      settings: settingsAt > 0 ? JSON.parse(process.argv[settingsAt + 1]) : undefined,
      stderr: (d: string) => process.argv.includes('--stderr') && process.stdout.write(`[stderr] ${d}`),
    } as never,
  });
  const t = Date.now();
  const init = (await q.initializationResult()) as Record<string, any>;
  console.log(`init in ${Date.now() - t}ms; keys`, Object.keys(init).join(','));
  console.log('init.capabilities', JSON.stringify(init.capabilities ?? null).slice(0, 600));
  console.log('init.remote', JSON.stringify(Object.fromEntries(Object.entries(init).filter(([k]) => /remote|rc_|chrome|computer/i.test(k)))));
  const mcp = (await q.mcpServerStatus()) as Record<string, any>[];
  console.log('mcp', mcp.map((s) => `${s.name}:${s.status}${s.error ? ` (${s.error})` : ''} tools=${(s.tools ?? []).length > 12 ? (s.tools ?? []).length : (s.tools ?? []).map((x: any) => x.name).join('|')}`).join('\n  '));
  const cmds = await q.supportedCommands();
  console.log('commands', cmds.filter((c) => /chrome|remote|computer|mcp|ide/i.test(c.name)).map((c) => `${c.name}: ${c.description}`).join('\n  '));
  // Undocumented control requests the SDK does not wrap (the CLI answers them on its stdio).
  const request = (r: object) => (q as any).request(r).then((x: any) => x.response);
  const callAt = process.argv.indexOf('--mcp-call');
  if (callAt > 0) {
    const t1 = Date.now();
    const r = await request({ subtype: 'mcp_call', tool: process.argv[callAt + 1], arguments: {} }).catch((e: Error) => ({ error: e.message }));
    console.log(`mcp_call in ${Date.now() - t1}ms`, JSON.stringify(r).slice(0, 800));
  }
  if (process.argv.includes('--rc')) {
    const t1 = Date.now();
    const on = await request({ subtype: 'remote_control', enabled: true }).catch((e: Error) => ({ error: e.message }));
    console.log(`remote_control on in ${Date.now() - t1}ms`, JSON.stringify(on));
    const off = await request({ subtype: 'remote_control', enabled: false }).catch((e: Error) => ({ error: e.message }));
    console.log('remote_control off', JSON.stringify(off));
  }
  if (process.argv.includes('--wait')) {
    // Collect anything the process says on its own (system messages, status) for a while.
    const until = Date.now() + Number(process.argv[process.argv.indexOf('--wait') + 1] ?? 5000);
    const it = q[Symbol.asyncIterator]();
    while (Date.now() < until) {
      const r = await Promise.race([it.next(), new Promise<null>((res) => setTimeout(() => res(null), until - Date.now()))]);
      if (!r || r.done) break;
      console.log('msg', JSON.stringify(r.value).slice(0, 500));
    }
  }
  q.close();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
}

const t0 = Date.now();
console.log('info', await provider.info());
const cwd = mkdtempSync(path.join(tmpdir(), 'sable-smoke-'));
const caps = await provider.caps(cwd);
console.log(`caps in ${Date.now() - t0}ms`);
console.log('models', caps.models.map((m) => `${m.id} [${m.name}] efforts=${m.efforts?.join('/') ?? '-'}${m.isDefault ? ' *' : ''}`));
console.log('modes', caps.modes.map((m) => m.id).join(', '));
console.log('commands', caps.commands.length, caps.commands.slice(0, 12).map((c) => `${c.name}:${c.kind}`).join(', '));
console.log('agents', caps.agents.map((a) => a.name).join(', '));
console.log('mcp', caps.mcpServers.map((s) => `${s.name}:${s.status}`).join(', '));
const history = await provider.history(process.cwd(), 3);
console.log('history', history.map((h) => `${h.title.slice(0, 40)} @ ${new Date(h.updatedAt).toISOString()}`));

if (process.argv.includes('--turn')) {
  const meta: SessionMeta = {
    id: 'smoke',
    provider: 'claude',
    cwd,
    title: 'smoke',
    titleSource: 'auto',
    model: 'haiku',
    mode: 'default',
    status: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  };
  const rt = new SessionRuntime(meta, emit, () => {});
  const session = await provider.open(rt, {});
  rt.handle = session;
  const prompt = process.argv[process.argv.indexOf('--turn') + 1] ?? 'Reply with exactly: ok';
  const item = rt.add<UserItem>({ type: 'user', text: prompt, state: 'sent' });
  await session.send(item);
  // Auto-approve anything that asks, so the smoke run never hangs.
  const timer = setInterval(() => {
    for (const p of rt.snapshot().permissions) rt.answerPermission(p.id, { optionId: 'allow' });
  }, 300);
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!rt.turnActive) {
        clearInterval(check);
        resolve();
      }
    }, 200);
  });
  clearInterval(timer);
  console.log('\n--- timeline ---');
  for (const i of rt.items) {
    const o = i as unknown as Record<string, unknown>;
    console.log(i.type, JSON.stringify({ ...o, id: undefined, ts: undefined }).slice(0, 260));
  }
  console.log('meta', JSON.stringify(rt.meta));
  console.log('limits', await provider.limits());
  await session.close();
}
await provider.dispose();
process.exit(0);
