/**
 * Long chats reach a window cut (server/core/trim.ts, applied by server/bridge.ts): finished steps'
 * long output and results keep their start and end, pictures go, the step is marked `more`, and
 * `session.item` returns it whole. Short items, live items and what shows without opening a step
 * (widgets, edits' diffs, messages' pictures, tasks) reach it as they are. Demo provider only.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BRIDGE_PATH, type BridgeEvent, type RpcResponse, type ServerFrame, type SessionSnapshot, type TimelineItem, type ToolItem, type UserItem } from '@shared/protocol';
import { attachBridge } from '../server/bridge';
import { CUT_AT, KEEP, cutItem, cutItems, eventForWindow, headTail, resultForWindow } from '../server/core/trim';
import { DemoProvider } from '../server/providers/demo';

const line = (i: number) => `line ${String(i).padStart(6, '0')} of the command's output, some words to make it long\n`;
const long = (n: number, from = 0) => {
  let s = '';
  for (let i = from; s.length < n; i++) s += line(i);
  return s;
};
const picture = `data:image/png;base64,${'A'.repeat(200_000)}`;

const tool = (patch: Partial<ToolItem>): ToolItem => ({ id: 'x', ts: 1, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run tests', status: 'done', detail: { command: 'pnpm test' }, ...patch });

describe('cutting a timeline for a window', () => {
  it('keeps short items, live items and what shows without opening a step as they are', () => {
    const output = long(100_000);
    const same: TimelineItem[] = [
      { id: 'u', ts: 1, type: 'user', text: long(80_000), attachments: [{ id: 'a', kind: 'image', name: 'shot.png', dataUrl: picture }] } satisfies UserItem,
      { id: 't', ts: 2, type: 'text', text: long(80_000), streaming: false },
      { id: 'n', ts: 3, type: 'notice', variant: 'info', text: 'x', detail: long(50_000) },
      tool({ id: 's', output: 'ok\n', result: { text: 'ok\n', exitCode: 0 } }),
      // Running, waiting or pending: live, whole.
      tool({ id: 'r', status: 'running', output }),
      tool({ id: 'w', status: 'awaiting', output }),
      // A sub-agent or workflow still at work in the background.
      tool({ id: 'g', kind: 'agent', name: 'Agent', result: { text: output, agent: { background: 'running' } } }),
      tool({ id: 'f', kind: 'agent', name: 'Workflow', result: { text: output }, workflow: { phases: [], phase: 0, agents: [], status: 'running' } }),
      // Shown as they are: a widget, tasks, a question, a plan.
      tool({ id: 'wd', kind: 'widget', name: 'show_widget', input: { title: 'Chart', code: long(60_000) }, result: { text: output } }),
      tool({ id: 'td', kind: 'todo', name: 'TodoWrite', result: { text: output } }),
      tool({ id: 'q', kind: 'question', name: 'AskUserQuestion', result: { text: output } }),
      tool({ id: 'p', kind: 'plan', name: 'ExitPlanMode', detail: { plan: long(60_000) }, result: { text: output } }),
      // A small picture stays.
      tool({ id: 'i', kind: 'browser', name: 'browser_screenshot', result: { images: ['data:image/png;base64,AAAA'] } }),
    ];
    const out = cutItems(same);
    out.forEach((it, i) => expect(it).toBe(same[i]));
    expect(out.some((it) => it.type === 'tool' && it.more)).toBe(false);
  });

  it('cuts a finished step: the start and end of long texts, a file read its first lines, pictures, long file lists', () => {
    const output = long(300_000);
    const text = long(120_000, 50_000);
    const stderr = long(40_000, 90_000);
    const diff = [{ path: 'src/session.ts', status: 'modified' as const, additions: 1, deletions: 0, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+b'] }] }];
    const bash = tool({ id: 'b', output, input: { command: 'pnpm test' }, result: { text, stderr, exitCode: 1, diff, answers: { q: ['a'] }, agent: { tokens: 3 } } });
    const cut = cutItem(bash) as ToolItem;
    expect(cut).not.toBe(bash);
    expect(cut.more).toBe(true);
    // The original is untouched (the bridge keeps it whole).
    expect(bash.output).toBe(output);
    expect(bash.more).toBeUndefined();
    for (const [whole, part] of [
      [output, cut.output!],
      [text, cut.result!.text!],
      [stderr, cut.result!.stderr!],
    ]) {
      expect(part.length).toBeLessThan(KEEP.head + KEEP.tail + 10);
      const [head, tail] = part.split('\n…\n');
      // Whole lines from the start and whole lines up to the very end.
      expect(whole.startsWith(head)).toBe(true);
      expect(whole.endsWith(tail)).toBe(true);
      expect(head.length).toBeGreaterThan(KEEP.head / 2);
      expect(tail.length).toBeGreaterThan(KEEP.tail / 2);
      expect(head.endsWith('output, some words to make it long')).toBe(true);
      expect(tail.startsWith('line ')).toBe(true);
    }
    // What the row shows, and the change, answers and figures, stay.
    expect(cut.result!.exitCode).toBe(1);
    expect(cut.result!.diff).toBe(diff);
    expect(cut.result!.answers).toEqual({ q: ['a'] });
    expect(cut.result!.agent).toEqual({ tokens: 3 });
    expect(cut.input).toBe(bash.input);
    expect(cut.detail).toBe(bash.detail);

    const content = long(90_000);
    const read = cutItem(tool({ id: 'r', kind: 'read', name: 'Read', detail: { path: '/w/a.ts' }, result: { file: { path: '/w/a.ts', content, startLine: 1, numLines: 1000, totalLines: 1000 }, images: [picture] } })) as ToolItem;
    expect(read.more).toBe(true);
    // A file keeps its first lines (their numbers stay right) and says it goes on.
    expect(read.result!.file).toMatchObject({ path: '/w/a.ts', startLine: 1, numLines: 1000, totalLines: 1000 });
    expect(read.result!.file!.content!.endsWith('\n…')).toBe(true);
    expect(content.startsWith(read.result!.file!.content!.slice(0, -2))).toBe(true);
    expect(read.result!.file!.content!.length).toBeLessThanOrEqual(KEEP.head + KEEP.tail + 2);
    expect(read.result!.images).toBeUndefined();

    const files = Array.from({ length: 5000 }, (_, i) => `/work/project/src/module-${i}/file-${i}.ts`);
    const glob = cutItem(tool({ id: 'g', kind: 'glob', name: 'Glob', result: { files, count: 5000 } })) as ToolItem;
    expect(glob.result!.files).toEqual(files.slice(0, 200));
    expect(glob.result!.count).toBe(5000);

    // Just over the line is cut; just under is not.
    expect((cutItem(tool({ output: long(CUT_AT + 100) })) as ToolItem).more).toBe(true);
    const under = tool({ output: long(CUT_AT - 200) });
    expect(cutItem(under)).toBe(under);
    // Text without line breaks is cut at the lengths.
    expect(headTail('x'.repeat(50_000))).toBe(`${'x'.repeat(KEEP.head)}\n…\n${'x'.repeat(KEEP.tail)}`);
  });

  it('cuts snapshots and resets, and nothing else', () => {
    const items = [tool({ id: 'b', output: long(100_000) })];
    const snap = { session: { id: 's' }, items, permissions: [], questions: [], todos: [], queue: [] } as unknown as SessionSnapshot;
    const out = resultForWindow(snap);
    expect(out).not.toBe(snap);
    expect(snap.items[0]).toBe(items[0]);
    expect((out.items[0] as ToolItem).more).toBe(true);
    const other = { item: items[0] };
    expect(resultForWindow(other)).toBe(other);

    const reset: BridgeEvent = { type: 'timeline.reset', sessionId: 's', items };
    const r1 = eventForWindow(reset);
    expect(((r1 as { items: TimelineItem[] }).items[0] as ToolItem).more).toBe(true);
    // Cut once for every window.
    expect(eventForWindow(reset)).toBe(r1);
    for (const e of [
      { type: 'item.added', sessionId: 's', item: items[0] },
      { type: 'item.patch', sessionId: 's', id: 'b', patch: { result: { text: long(100_000) } } },
      { type: 'item.delta', sessionId: 's', id: 'b', field: 'output', delta: long(100_000) },
    ] as BridgeEvent[])
      expect(eventForWindow(e)).toBe(e);
  });
});

// ── over the socket ──

let server: Server;
let bridge: ReturnType<typeof attachBridge>;
let home: string;
let port: number;

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'sable-trim-'));
  server = createServer((_req, res) => res.writeHead(404).end());
  bridge = attachBridge(server, { home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
  server.on('upgrade', (req, socket) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== BRIDGE_PATH) socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await bridge?.dispose();
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  rmSync(home, { recursive: true, force: true });
});

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_PATH}`, { maxPayload: 512 * 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const events: BridgeEvent[] = [];
  const pending = new Map<number, (f: RpcResponse & { bytes: number }) => void>();
  ws.on('message', (raw) => {
    const text = raw.toString();
    const frame = JSON.parse(text) as ServerFrame;
    if ('event' in frame) events.push(frame.event);
    else pending.get(frame.id)?.({ ...frame, bytes: text.length });
  });
  let next = 1;
  const call = <T>(method: string, params: unknown = {}) =>
    new Promise<{ result: T; bytes: number }>((resolve, reject) => {
      const id = next++;
      pending.set(id, (f) => (f.ok ? resolve({ result: f.result as T, bytes: f.bytes }) : reject(new Error(f.error))));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, events, call };
}

const settle = (sid: string) =>
  new Promise<void>((resolve) => {
    const off = bridge.app.subscribe((e) => {
      if (e.type === 'session.updated' && e.id === sid && (e.patch.status === 'idle' || e.patch.status === 'error')) {
        off();
        resolve();
      }
    });
  });

describe('a long Demo chat over the bridge', () => {
  it('opens a 40 MB chat in a few MB, gives any step whole, and still streams live steps whole', async () => {
    const c = await connect();
    const { result: created } = await c.call<SessionSnapshot>('session.create', { provider: 'demo', cwd: home, mode: 'bypassPermissions' });
    const sid = created.session.id;
    const done = settle(sid);
    await bridge.app.call('session.send', { sessionId: sid, text: 'marathon' });
    await done;
    // Padded like a real chat: command output, file reads, results, now and then a picture.
    const rt = bridge.app.sessions.get(sid)!;
    let n = 0;
    for (const it of rt.items) {
      if (it.type !== 'tool') continue;
      n++;
      if (it.kind === 'bash') Object.assign(it, { output: long(100_000, n), result: { ...it.result, text: long(100_000, n) } });
      else if (it.kind === 'read') it.result = { ...it.result, file: { path: it.detail.path ?? 'a.ts', ...it.result?.file, content: long(200_000, n) } };
      else if (it.kind !== 'edit') it.result = { ...it.result, text: long(200_000, n) };
      if (n % 40 === 0) it.result = { ...it.result, images: [picture] };
    }
    const whole = JSON.stringify(rt.items).length;
    expect(whole).toBeGreaterThan(38e6);

    const { result: snap, bytes } = await c.call<SessionSnapshot>('session.snapshot', { sessionId: sid });
    expect(bytes).toBeLessThan(4e6);
    expect(snap.items.length).toBe(rt.items.length);
    const cut = snap.items.filter((i): i is ToolItem => i.type === 'tool' && !!i.more);
    expect(cut.length).toBeGreaterThan(150);
    // Edits keep their diffs.
    const edits = snap.items.filter((i): i is ToolItem => i.type === 'tool' && i.kind === 'edit');
    expect(edits.length).toBeGreaterThan(50);
    for (const e of edits) expect(e.result?.diff).toEqual((rt.get(e.id) as ToolItem).result?.diff);
    // The bridge's own timeline stays whole.
    expect(JSON.stringify(rt.items).length).toBe(whole);

    // Any step whole.
    const bash = cut.find((i) => i.kind === 'bash')!;
    const { result: got } = await c.call<{ item: ToolItem }>('session.item', { sessionId: sid, itemId: bash.id });
    expect(got.item).toEqual(rt.get(bash.id));
    expect(got.item.more).toBeUndefined();
    const shot = rt.items.find((i): i is ToolItem => i.type === 'tool' && !!i.result?.images?.length)!;
    expect(snap.items.find((i) => i.id === shot.id)).toMatchObject({ more: true });
    expect((await c.call<{ item: ToolItem }>('session.item', { sessionId: sid, itemId: shot.id })).result.item.result?.images).toEqual([picture]);
    await expect(c.call('session.item', { sessionId: sid, itemId: 'nope' })).rejects.toThrow(/no longer there/);

    // A live step: added, streamed and finished whole, however long.
    const live = rt.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run the build', status: 'running', detail: { command: 'pnpm build' } });
    const chunk = long(50_000, 7);
    rt.delta(live.id, 'output', chunk);
    rt.delta(live.id, 'output', chunk);
    rt.patch<ToolItem>(live.id, { status: 'done', endedAt: Date.now(), result: { text: chunk + chunk, exitCode: 0 } });
    await new Promise((r) => setTimeout(r, 200));
    const mine = c.events.filter((e) => 'sessionId' in e && e.sessionId === sid && 'id' in e && e.id === live.id);
    expect(mine.filter((e) => e.type === 'item.delta').map((e) => (e as { delta: string }).delta).join('')).toBe(chunk + chunk);
    expect((mine.find((e) => e.type === 'item.patch') as { patch: ToolItem }).patch.result?.text).toBe(chunk + chunk);

    // A reset (a rewind, a resumed transcript) reaches the window cut too.
    rt.reset([...rt.items]);
    await new Promise((r) => setTimeout(r, 300));
    const reset = c.events.find((e) => e.type === 'timeline.reset' && e.sessionId === sid) as { items: TimelineItem[] };
    expect(reset.items.find((i) => i.id === live.id)).toMatchObject({ more: true });
    expect(JSON.stringify(reset.items).length).toBeLessThan(4e6);
    c.ws.close();
  }, 60_000);
});
