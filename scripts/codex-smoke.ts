/**
 * Smoke test for the Codex adapter against the real `codex app-server`.
 *
 *   pnpm exec tsx scripts/codex-smoke.ts            # info/caps/limits/history + one tiny turn + resume
 *   pnpm exec tsx scripts/codex-smoke.ts --shell    # one turn that runs a shell command (auto-approves) and steers mid-turn
 *   pnpm exec tsx scripts/codex-smoke.ts --interrupt  # one turn interrupted shortly after it starts
 *   pnpm exec tsx scripts/codex-smoke.ts --no-turn  # everything except real turns (free)
 *
 * Every real turn costs Codex quota.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BridgeEvent, SessionMeta, TimelineItem } from '../shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { CodexProvider } from '../server/providers/codex';

/**
 * --probe: one app-server with experimental methods, no threads, no turns. Prints remote-control
 * status, the plugins that look like browser / computer use, and MCP servers. `--rc` also enables
 * remote control (ephemeral), starts a pairing code and disables it again.
 */
if (process.argv.includes('--probe')) {
  const { CodexRpc } = await import('../server/providers/codex-rpc');
  const t = Date.now();
  const rpc = await CodexRpc.start({ log: () => {}, clientVersion: '0.0.0', experimental: true });
  rpc.onNotification = (m, p) => /remote|environment|mcpServer\/startup/i.test(m) && console.log('notify', m, JSON.stringify(p).slice(0, 300));
  console.log(`app-server up in ${Date.now() - t}ms`);
  const show = async (method: string, params: unknown, ms = 20_000) => {
    const t1 = Date.now();
    try {
      const r = await rpc.request<any>(method, params, ms);
      return { ms: Date.now() - t1, r };
    } catch (e) {
      return { ms: Date.now() - t1, r: { error: (e as Error).message } };
    }
  };
  console.log('remoteControl/status/read', JSON.stringify(await show('remoteControl/status/read', undefined)));
  const cfgAt = process.argv.indexOf('--thread-config');
  if (cfgAt > 0) {
    // An ephemeral thread (no turn, nothing stored) with per-thread config overrides.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sable-codex-probe-'));
    const th = await show('thread/start', { cwd: dir, ephemeral: true, config: JSON.parse(process.argv[cfgAt + 1]) }, 60_000);
    const threadId = th.r.thread?.id;
    console.log(`thread/start ${th.ms}ms`, threadId ?? JSON.stringify(th.r).slice(0, 300));
    const m = await show('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', limit: 100, threadId }, 120_000);
    console.log(`thread mcp ${m.ms}ms`, (m.r.data ?? []).map((s: any) => `${s.name}${s.pluginId ? `(${s.pluginId})` : ''}`).join(', '), m.r.error ?? '');
    await rpc.close();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }
  const pl = await show('plugin/list', {});
  const plugins = (pl.r.marketplaces ?? []).flatMap((m: any) => m.plugins ?? []);
  console.log(`plugin/list ${pl.ms}ms`, plugins.filter((p: any) => /browser|chrome|computer/i.test(p.id)).map((p: any) => `${p.id} installed=${p.installed} enabled=${p.enabled} avail=${JSON.stringify(p.availability)}`));
  const mcp = await show('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', limit: 100 }, 120_000);
  console.log(`mcpServerStatus/list ${mcp.ms}ms`);
  for (const s of mcp.r.data ?? []) console.log(' ', s.name, JSON.stringify({ ...s, tools: Object.keys(s.tools ?? {}).length > 15 ? Object.keys(s.tools).length : Object.keys(s.tools ?? {}), name: undefined, resources: undefined, resourceTemplates: undefined }).slice(0, 400));
  if (process.argv.includes('--rc')) {
    console.log('enable', JSON.stringify(await show('remoteControl/enable', { ephemeral: true })));
    console.log('pairing', JSON.stringify(await show('remoteControl/pairing/start', { manualCode: true }), (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
    await new Promise((r) => setTimeout(r, 3000));
    console.log('status', JSON.stringify(await show('remoteControl/status/read', undefined)));
    console.log('disable', JSON.stringify(await show('remoteControl/disable', { ephemeral: true })));
  }
  await rpc.close();
  process.exit(0);
}

const args = new Set(process.argv.slice(2));
const compactArg = process.argv.find((a) => a.startsWith('--compact='));
const compactThread = compactArg?.slice('--compact='.length);
const mode = compactThread
  ? 'compact'
  : args.has('--shell')
    ? 'shell'
    : args.has('--interrupt')
      ? 'interrupt'
      : args.has('--no-turn')
        ? 'none'
        : 'ok';

const clip = (s: string, n = 100) => {
  const one = s.replace(/\s+/g, ' ');
  return one.length > n ? one.slice(0, n) + '…' : one;
};

let rtRef: SessionRuntime | undefined;
const listeners: ((e: BridgeEvent) => void)[] = [];

function logEvent(e: BridgeEvent) {
  switch (e.type) {
    case 'item.added':
      console.log(`  [ev] item.added ${e.item.type} ${e.item.id.slice(-12)} ${clip(JSON.stringify(e.item), 160)}`);
      break;
    case 'item.delta':
      console.log(`  [ev] item.delta ${e.field} ${e.id.slice(-12)} ${JSON.stringify(clip(e.delta, 60))}`);
      break;
    case 'item.patch':
      console.log(`  [ev] item.patch ${e.id.slice(-12)} ${clip(JSON.stringify(e.patch), 160)}`);
      break;
    case 'session.updated':
      console.log(`  [ev] session.updated ${clip(JSON.stringify(e.patch), 160)}`);
      break;
    case 'session.caps':
      console.log(`  [ev] session.caps models=${e.caps.models.length} skills=${e.caps.skills.length} mcp=${e.caps.mcpServers.length}`);
      break;
    case 'timeline.reset':
      console.log(`  [ev] timeline.reset items=${e.items.length}`);
      break;
    case 'permission.added':
      console.log(`  [ev] permission.added ${e.request.title} | ${clip(e.request.detail.command ?? e.request.description ?? '')} | options=${e.request.options.map((o) => o.id).join(',')}`);
      break;
    default:
      console.log(`  [ev] ${e.type} ${clip(JSON.stringify(e), 140)}`);
  }
  for (const l of listeners) l(e);
}

const ctx = { emit: logEvent, log: (...a: unknown[]) => console.log('  [log]', ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))) };

function makeRuntime(meta: Partial<SessionMeta>): SessionRuntime {
  const now = Date.now();
  const full: SessionMeta = {
    id: `smoke-${now}`,
    provider: 'codex',
    cwd: meta.cwd!,
    title: 'smoke',
    titleSource: 'auto',
    model: '',
    mode: 'read-only',
    status: 'starting',
    createdAt: now,
    updatedAt: now,
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
    ...meta,
  };
  return new SessionRuntime(full, logEvent, () => {});
}

function waitTurnEnd(rt: SessionRuntime, timeoutMs = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('turn did not end in time')), timeoutMs);
    const tick = setInterval(() => {
      if (!rt.turnActive) {
        clearTimeout(t);
        clearInterval(tick);
        resolve();
      }
    }, 100);
  });
}

function printTimeline(items: TimelineItem[]) {
  console.log(`\n== timeline (${items.length} items)`);
  for (const i of items) {
    switch (i.type) {
      case 'user':
        console.log(`  user[${i.state}]: ${clip(i.text)}`);
        break;
      case 'text':
        console.log(`  text${i.streaming ? '(streaming!)' : ''}: ${clip(i.text)}`);
        break;
      case 'thinking':
        console.log(`  thinking${i.streaming ? '(streaming!)' : ''}: ${clip(i.text, 80)}`);
        break;
      case 'tool':
        console.log(
          `  tool ${i.kind}/${i.name} [${i.status}] "${i.title}" detail=${clip(JSON.stringify(i.detail), 80)} result=${clip(JSON.stringify(i.result ?? null), 120)}`,
        );
        break;
      case 'notice':
        console.log(`  notice(${i.variant}): ${i.text}${i.detail ? ` — ${clip(i.detail, 80)}` : ''}`);
        break;
      case 'turn':
        console.log(`  turn: ${i.durationMs}ms in=${i.inputTokens ?? '-'} out=${i.outputTokens ?? '-'} stop=${i.stopReason}${i.error ? ` error=${i.error}` : ''}`);
        break;
    }
  }
}

async function main() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'sable-codex-'));
  const provider = new CodexProvider(ctx);
  let pid: number | undefined;
  try {
    console.log('== info()');
    const info = await provider.info();
    console.log(JSON.stringify({ ...info, auth: { ...info.auth, email: info.auth.email ? '<redacted>' : undefined } }));

    console.log('\n== caps()');
    const caps = await provider.caps(cwd);
    console.log(
      JSON.stringify({
        models: caps.models.map((m) => `${m.id}${m.isDefault ? '*' : ''} [${m.efforts?.join('/') ?? ''}] def=${m.defaultEffort}`),
        modes: caps.modes.map((m) => `${m.id}:${m.tone}`),
        commands: caps.commands.map((c) => c.name),
        skills: caps.skills.length,
        firstSkills: caps.skills.slice(0, 3).map((s) => s.name),
        mcp: caps.mcpServers.map((s) => `${s.name}:${s.status}:${s.tools?.length ?? 0}`),
        features: caps.features,
        skillTrigger: caps.skillTrigger,
      }),
    );

    console.log('\n== limits()');
    console.log(JSON.stringify(await provider.limits()));

    console.log('\n== history() first 5');
    for (const h of (await provider.history(undefined, 5)).slice(0, 5)) console.log(' ', JSON.stringify({ ...h, preview: h.preview && clip(h.preview, 60) }));
    console.log('== history(cwd of temp dir) →', (await provider.history(cwd, 5)).length, 'entries');

    pid = (provider as any).rpc?.child?.pid;
    console.log('\napp-server pid', pid);

    if (mode === 'none') return;

    console.log(`\n== open session (mode=${mode === 'shell' ? 'default' : 'read-only'}) in ${cwd}`);
    const rt = makeRuntime({ cwd, mode: mode === 'shell' ? 'default' : 'read-only', providerSessionId: compactThread });
    rtRef = rt;
    rt.handle = await provider.open(rt, { loadTranscript: !!compactThread });
    rt.update({ status: 'idle' });
    console.log('thread', rt.meta.providerSessionId, 'model', rt.meta.model, 'effort', rt.meta.effort);

    const send = async (text: string) => {
      const item = rt.add({ type: 'user', text, state: rt.turnActive ? 'queued' : 'sent' } as never);
      await rt.handle!.send(item as never);
    };

    if (mode === 'ok') {
      await send('Reply with exactly: ok');
      await waitTurnEnd(rt);
    } else if (mode === 'shell') {
      // Approve everything once; steer once when the first tool shows up.
      let steered = false;
      listeners.push((e) => {
        if (e.type === 'permission.added') {
          const allow = e.request.options.find((o) => o.tone === 'allow');
          console.log('  >> approving', allow?.id);
          setTimeout(() => rt.answerPermission(e.request.id, { optionId: allow!.id }), 300);
        }
        if (e.type === 'item.added' && e.item.type === 'tool' && !steered) {
          steered = true;
          setTimeout(() => {
            console.log('  >> steering');
            void send('Also end your reply with the word: banana').catch((err) => console.log('steer failed', err));
          }, 200);
        }
      });
      await send('Run the shell command `node --version` in the current directory and tell me exactly what it printed. Keep the reply to one short line.');
      await waitTurnEnd(rt);
    } else if (mode === 'compact') {
      await send('/compact');
      await waitTurnEnd(rt);
    } else if (mode === 'interrupt') {
      listeners.push((e) => {
        if (e.type === 'item.added' && (e.item.type === 'thinking' || e.item.type === 'text' || e.item.type === 'tool')) {
          console.log('  >> interrupting');
          void rt.handle!.interrupt();
          listeners.length = 0;
        }
      });
      await send('Count slowly from 1 to 200, one number per line.');
      await waitTurnEnd(rt);
    }
    printTimeline(rt.items);
    console.log('\nusage', JSON.stringify(rt.meta.usage), 'status', rt.meta.status, 'lastError', rt.meta.lastError ?? '-');
    console.log('todos', JSON.stringify(rt.todos));

    // Resume the same thread into a fresh runtime with transcript loading (no quota used).
    console.log('\n== resume with loadTranscript');
    const threadId = rt.meta.providerSessionId!;
    await rt.handle.close();
    const rt2 = makeRuntime({ cwd, providerSessionId: threadId, mode: 'read-only', id: 'smoke-resume' });
    rt2.handle = await provider.open(rt2, { loadTranscript: true });
    printTimeline(rt2.items);
    await rt2.handle.close();
  } finally {
    console.log('\n== dispose');
    await provider.dispose();
    if (pid) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      console.log('app-server pid', pid, alive ? 'STILL ALIVE (bug)' : 'is gone');
    }
    rmSync(cwd, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('SMOKE FAILED:', err);
    if (rtRef) printTimeline(rtRef.items);
    process.exit(1);
  },
);
