import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  PHONE_METHODS,
  PHONE_OWN_METHODS,
  PHONE_PATH,
  PHONE_PORT,
  type Attachment,
  type BridgeEvent,
  type PhoneDevice,
  type PhoneFrame,
  type PhoneHello,
  type PhoneItem,
  type PhoneReset,
  type PhoneStatus,
  type PhoneTail,
  type QueuedMessage,
  type RpcName,
  type RpcRequest,
  type ServerFrame,
  type SessionSnapshot,
  type TimelineItem,
  type ToolDetail,
  type ToolItem,
  type ToolResult,
  type WorkflowRun,
} from '../../shared/protocol';
import { partOfTurn, syntheticOf } from '../../shared/synthetic';
import type { App } from '../app';
import { cap, isSnapshot, lines } from '../core/trim';
import { VERSION } from '../version';
import { qrSvgPath } from './qr';

/**
 * The phone endpoint: Sable's phone app (`mobile/`) on the home network.
 *
 * - Its own HTTP server on all interfaces at `PHONE_PORT`, started only while Settings › Phone is
 *   on. The localhost bridge is untouched: nothing here is reachable through it, and the phone
 *   never reaches the localhost bridge.
 * - Pairing: a one-time key (QR code / link, valid 10 minutes, used up by the first phone that
 *   presents it), then "Allow <phone>?" on the desktop. An allowed phone gets a 256-bit token,
 *   stored here only as a SHA-256 hash; Settings › Phone revokes it.
 * - Every socket authenticates first (`hello` with the token) within a few seconds; wrong keys and
 *   tokens are counted per address and block it for a while; there is a cap on sockets.
 * - Authenticated sockets may call only `PHONE_METHODS`, with their parameters narrowed; they get
 *   the conversation events, never terminal output, browser requests, sign-in links or this
 *   service's own state (which holds the pairing key).
 * - Conversations reach a phone in pages (`phone.tail`, `phone.item`; a snapshot from any method
 *   is cut to its newest page), items trimmed to what the phone shows, and item events only for
 *   the conversations it has open, trimmed the same way. Frames over 1 KB are compressed.
 */

interface StoredPhone {
  id: string;
  name: string;
  /** SHA-256 of the token, hex. */
  tokenHash: string;
  pairedAt: number;
  lastSeen?: number;
}

interface PhoneFile {
  enabled: boolean;
  devices: StoredPhone[];
}

export interface PhoneOptions {
  /** Port to listen on (tests use 0). */
  port?: number;
  /** Interface to listen on (tests use 127.0.0.1). */
  host?: string;
  /** Where the paired phones are kept (defaults to `<SABLE_HOME>/phone.json`). */
  file?: string;
}

const PAIR_TTL_MS = 10 * 60_000;
const REQUEST_TTL_MS = 2 * 60_000;
const HELLO_TIMEOUT_MS = 8_000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
const BLOCK_MS = 15 * 60_000;
const GLOBAL_FAILS_PER_MIN = 30;
const MAX_SOCKETS = 12;
const MAX_HELLO_BYTES = 4096;
/** A phone that falls this far behind (bytes queued) is dropped; it reconnects and reloads. */
const MAX_BUFFERED = 24 * 1024 * 1024;

/** Events a phone needs to show conversations, limits and folders. */
const PHONE_EVENTS = new Set<BridgeEvent['type']>([
  'provider.updated',
  'projects.updated',
  'settings.updated',
  'session.added',
  'session.updated',
  'session.removed',
  'session.caps',
  'item.added',
  'item.delta',
  'item.patch',
  'item.removed',
  'timeline.reset',
  'permission.added',
  'permission.removed',
  'question.added',
  'question.removed',
  'todos.updated',
  'suggestion',
  'queue.updated',
  'limits.updated',
  'limits.report',
  'limit.reset',
  'caps.updated',
  'toast',
]);

const ALLOWED = new Set<string>(PHONE_METHODS);
const OWN = new Set<string>(PHONE_OWN_METHODS);

/** Events that carry a conversation's items: sent only for the conversations a phone has open. */
const ITEM_EVENTS = new Set<BridgeEvent['type']>(['item.added', 'item.delta', 'item.patch', 'item.removed', 'timeline.reset']);
/** Conversations a socket follows (the ones it opened last). */
const WATCH_MAX = 8;

// ── what a phone gets of a conversation ──
//
// Real conversations reach hundreds of MB (tool output, file reads, screenshots). A phone gets
// pages of root items with what it shows: titles, kinds, states, a change's counts, texts up to a
// generous length; `phone.item` returns one item with more of it.

/** Root items per page, by default and at most. */
export const PAGE_ITEMS = 40;
const PAGE_MAX = 120;
/** A page stops growing past this many bytes of JSON (it always holds a few items). */
export const PAGE_BYTES = 90_000;
/** How far a page reaches back for the message that opened its first turn. */
const TURN_REACH = 160;
/** Text lengths: an answer or a message, text between steps, thinking, a notice. */
export const LIMITS = { answer: 8000, step: 1600, thinking: 320, notice: 1200, field: 400 };
/** `phone.item`: how much of one item. */
const FULL = { text: 200_000, thinking: 40_000, field: 4000, outLines: 200, outChars: 12_000, files: 6, hunks: 4, hunkLines: 80, children: 40 };

const DETAIL_TEXT = ['command', 'description', 'cwd', 'path', 'url', 'query', 'pattern', 'glob', 'subagent', 'server', 'tool', 'skill', 'caption'] as const;

function trimDetail(d: ToolDetail | undefined, n: number, full = false): ToolDetail {
  const out: ToolDetail = {};
  if (!d) return out;
  for (const k of DETAIL_TEXT) if (typeof d[k] === 'string') out[k] = cap(d[k] as string, n);
  if (d.range) out.range = d.range;
  // A `share` step: the files' names and sizes for its cards (the phone downloads one through `phone.fileLink`).
  if (d.files) out.files = d.files.slice(0, 12).map((f) => ({ path: cap(f.path, 400), name: cap(f.name, 200), ...(typeof f.size === 'number' ? { size: f.size } : {}) }));
  if (d.background) out.background = true;
  if (full) {
    for (const k of ['oldText', 'newText', 'content', 'prompt', 'plan'] as const) if (typeof d[k] === 'string') out[k] = cap(d[k] as string, n);
    if (d.todos) out.todos = d.todos.slice(0, 40);
  }
  return out;
}

function trimResult(r: ToolResult | undefined, full = false): ToolResult | undefined {
  if (!r) return undefined;
  const out: ToolResult = {};
  for (const k of ['exitCode', 'isError', 'interrupted', 'truncated', 'count'] as const) if (r[k] !== undefined) (out as Record<string, unknown>)[k] = r[k];
  if (r.agent) out.agent = r.agent;
  if (r.diff) {
    out.diff = r.diff.slice(0, full ? FULL.files : 24).map((f) => ({
      path: cap(f.path, 400),
      ...(f.oldPath ? { oldPath: cap(f.oldPath, 400) } : {}),
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      ...(f.binary ? { binary: true } : {}),
      hunks: full ? f.hunks.slice(0, FULL.hunks).map((h) => ({ ...h, lines: h.lines.slice(0, FULL.hunkLines).map((l) => cap(l, 400)) })) : [],
    }));
  }
  if (full) {
    if (r.text) out.text = lines(r.text, FULL.outLines, FULL.outChars);
    if (r.stderr) out.stderr = lines(r.stderr, FULL.outLines, FULL.outChars);
    if (r.files) out.files = r.files.slice(0, 50);
    if (r.links) out.links = r.links.slice(0, 20);
    if (r.file) out.file = { path: r.file.path, startLine: r.file.startLine, numLines: r.file.numLines, totalLines: r.file.totalLines, ...(r.file.content ? { content: lines(r.file.content, FULL.outLines, FULL.outChars) } : {}) };
  }
  return out;
}

function trimWorkflow(w: WorkflowRun): WorkflowRun {
  return {
    ...w,
    phases: w.phases.slice(0, 24).map((p) => ({ title: cap(p.title, 120), ...(p.detail ? { detail: cap(p.detail, 200) } : {}) })),
    agents: w.agents.slice(0, 40).map((a) => ({ ...a, label: cap(a.label, 120), ...(a.activity ? { activity: cap(a.activity, 160) } : {}), ...(a.error ? { error: cap(a.error, 200) } : {}) })),
  };
}

/** Attachments without their data (a picture shows as its name). */
const trimAttachments = (list: Attachment[] | undefined) => list?.map((a) => ({ id: a.id, kind: a.kind, name: cap(a.name, 120), ...(a.mime ? { mime: a.mime } : {}), ...(a.size ? { size: a.size } : {}) }));

function hasMore(t: ToolItem): boolean {
  const r = t.result;
  const d = t.detail ?? {};
  return !!(t.output || r?.text || r?.stderr || r?.diff?.some((f) => f.hunks.length) || r?.file?.content || r?.files?.length || r?.links?.length || d.oldText || d.newText || d.content || d.prompt || d.plan);
}

/**
 * An item as a phone gets it. `role` says where it shows: an answer or a message (long texts),
 * text between steps (shortened), or `full` for `phone.item`.
 */
export function phoneItem(it: TimelineItem, opts: { role?: 'answer' | 'step' | 'full'; kids?: number } = {}): PhoneItem {
  const full = opts.role === 'full';
  const textCap = (s: string, n: number): { text: string; cut?: true } => (s.length > n ? { text: s.slice(0, n), cut: true } : { text: s });
  // A `/until` check's output: the start of it (the phone shows a few lines).
  const until = (it.type === 'user' || it.type === 'notice') && it.until?.check?.output ? { until: { ...it.until, check: { ...it.until.check, output: cap(it.until.check.output, full ? FULL.field : 3000) } } } : {};
  switch (it.type) {
    case 'user': {
      const { attachments, ...rest } = it;
      return { ...rest, ...textCap(it.text, full ? FULL.text : it.until ? LIMITS.step : LIMITS.answer), ...(attachments ? { attachments: trimAttachments(attachments) } : {}), ...until };
    }
    case 'text':
      return { ...it, ...textCap(it.text, full ? FULL.text : opts.role === 'step' ? LIMITS.step : LIMITS.answer) };
    case 'thinking':
      return { ...it, ...textCap(it.text, full ? FULL.thinking : LIMITS.thinking) };
    case 'notice':
      return { ...it, text: cap(it.text, full ? FULL.field : LIMITS.notice), ...(it.detail ? { detail: cap(it.detail, full ? FULL.field : LIMITS.notice) } : {}), ...until };
    case 'turn':
      return it.error ? { ...it, error: cap(it.error, LIMITS.notice) } : it;
    case 'tool': {
      const n = full ? FULL.field : LIMITS.field;
      const out: PhoneItem = {
        id: it.id,
        ts: it.ts,
        ...(it.parentId ? { parentId: it.parentId } : {}),
        type: 'tool',
        name: cap(it.name, 120),
        kind: it.kind,
        title: cap(it.title, 300),
        status: it.status,
        detail: trimDetail(it.detail, n, full),
        ...(it.endedAt ? { endedAt: it.endedAt } : {}),
        ...(it.waitedMs ? { waitedMs: it.waitedMs } : {}),
        ...(it.result ? { result: trimResult(it.result, full) } : {}),
        ...(it.workflow ? { workflow: trimWorkflow(it.workflow) } : {}),
        // A check of a turn by the other agent: which turn and who, and its findings (they are its answer).
        ...(it.check ? { check: it.check } : {}),
        ...(opts.kids ? { kids: opts.kids } : {}),
        ...(!full && hasMore(it) ? { more: true } : {}),
      };
      if (it.check && it.result?.text && out.result) (out.result as ToolResult).text = cap(it.result.text, full ? FULL.text : LIMITS.answer);
      // A widget shows by its title only.
      if (it.kind === 'widget') {
        const title = (it.input as { title?: unknown } | undefined)?.title;
        if (typeof title === 'string') (out as ToolItem).input = { title: cap(title, 200) };
      }
      if (full && it.output) (out as ToolItem).output = lines(it.output.replace(/\x1b\[[0-9;]*m/g, ''), FULL.outLines, FULL.outChars);
      return out;
    }
  }
}

/** A patch to an item, trimmed like the item (no output, input or images; long text cut). */
export function phonePatch(patch: Partial<TimelineItem>): Partial<PhoneItem> | null {
  const p = { ...patch } as Record<string, unknown>;
  delete p.input;
  delete p.inputText;
  delete p.output;
  if (p.detail) p.detail = trimDetail(p.detail as ToolDetail, LIMITS.field);
  if (p.result) p.result = trimResult(p.result as ToolResult);
  if (p.workflow) p.workflow = trimWorkflow(p.workflow as WorkflowRun);
  if (p.attachments) p.attachments = trimAttachments(p.attachments as Attachment[]);
  if (typeof p.text === 'string' && p.text.length > LIMITS.answer) {
    p.text = p.text.slice(0, LIMITS.answer);
    p.cut = true;
  }
  if (typeof p.detail === 'string') p.detail = cap(p.detail, LIMITS.notice);
  if (typeof p.error === 'string') p.error = cap(p.error, LIMITS.notice);
  if ((patch as Partial<ToolItem>).output || (patch as Partial<ToolItem>).result?.text) p.more = true;
  return Object.keys(p).length ? (p as Partial<PhoneItem>) : null;
}

/** A message that opens a turn: not a steer, not a command's output or a reminder the agent's harness wrote. */
const turnStart = (it: TimelineItem) => it.type === 'user' && !it.steered && !partOfTurn(syntheticOf(it));

/**
 * One page of a conversation's root items, newest last: up to `limit` before `before` (or the
 * newest), reaching back to the message that opened the first turn when that is near, within a
 * byte budget. Text between steps is shortened (`LIMITS.step`); answers keep their length.
 */
export function phonePage(items: TimelineItem[], opts: { before?: string; limit?: number; budget?: number } = {}): { items: PhoneItem[]; cursor?: string; total: number } {
  const roots: TimelineItem[] = [];
  const kids = new Map<string, number>();
  for (const it of items) {
    if (it.parentId) kids.set(it.parentId, (kids.get(it.parentId) ?? 0) + 1);
    else roots.push(it);
  }
  const total = roots.length;
  let end = total;
  if (opts.before) {
    end = roots.findIndex((r) => r.id === opts.before);
    if (end < 0) return { items: [], total };
  }
  const limit = Math.max(1, Math.min(PAGE_MAX, opts.limit ?? PAGE_ITEMS));
  const budget = opts.budget ?? PAGE_BYTES;
  // A text item is an answer unless a step follows it in its turn (then it is a report along the way, shortened).
  const roleAt = (i: number): 'answer' | 'step' => {
    if (roots[i].type !== 'text') return 'answer';
    for (let j = i + 1; j < total; j++) {
      const t = roots[j];
      if (turnStart(t) || t.type === 'turn') return 'answer';
      if (t.type === 'tool' || t.type === 'thinking') return 'step';
    }
    return 'answer';
  };
  const out: PhoneItem[] = [];
  let bytes = 0;
  let start = end;
  const take = (i: number) => {
    const p = phoneItem(roots[i], { role: roleAt(i), kids: kids.get(roots[i].id) });
    out.push(p);
    bytes += JSON.stringify(p).length;
    start = i;
  };
  while (start > 0 && end - start < limit && (bytes < budget || end - start < 4)) take(start - 1);
  // Reach back to the message that opened this turn when it is near (a turn is not split).
  if (start > 0 && !turnStart(roots[start])) {
    let s = start - 1;
    while (s > 0 && start - s < TURN_REACH && !turnStart(roots[s])) s--;
    if (turnStart(roots[s])) while (start > s && bytes < budget * 1.6) take(start - 1);
  }
  out.reverse();
  return { items: out, ...(start > 0 ? { cursor: roots[start].id } : {}), total };
}

const trimQueue = (q: QueuedMessage[]) => q.map((m) => (m.attachments ? { ...m, attachments: trimAttachments(m.attachments) } : m)) as QueuedMessage[];

/** A snapshot as a phone gets it: the newest page instead of every item. */
export function phoneTail(snap: SessionSnapshot, opts: { before?: string; limit?: number } = {}): PhoneTail {
  const page = phonePage(snap.items, opts);
  return { ...snap, queue: trimQueue(snap.queue ?? []), items: page.items, total: page.total, ...(page.cursor ? { cursor: page.cursor } : {}) };
}

/** One item with more of it, and the last steps nested under it. */
export function phoneDetail(items: TimelineItem[], itemId: string): { item: PhoneItem; children: PhoneItem[] } {
  const it = items.find((i) => i.id === itemId);
  if (!it) throw new Error('That part of the conversation is no longer there');
  const kids = items.filter((i) => i.parentId === itemId);
  const count = new Map<string, number>();
  for (const k of items) if (k.parentId) count.set(k.parentId, (count.get(k.parentId) ?? 0) + 1);
  return { item: phoneItem(it, { role: 'full', kids: kids.length }), children: kids.slice(-FULL.children).map((k) => phoneItem(k, { role: 'step', kids: count.get(k.id) })) };
}

/** An event as a phone gets it, or null when it does not need it. */
export function phoneEvent(event: BridgeEvent): BridgeEvent | PhoneReset | null {
  switch (event.type) {
    case 'item.added':
      return { ...event, item: phoneItem(event.item, { role: event.item.type === 'text' && event.item.parentId ? 'step' : 'answer' }) };
    case 'item.delta':
      // Live tool output and streamed tool input stay on the desktop (`phone.item` has it).
      return event.field === 'text' ? event : null;
    case 'item.patch': {
      const patch = phonePatch(event.patch);
      return patch ? { ...event, patch } : null;
    }
    case 'timeline.reset': {
      const page = phonePage(event.items);
      return { type: 'timeline.reset', sessionId: event.sessionId, items: page.items, total: page.total, ...(page.cursor ? { cursor: page.cursor } : {}) };
    }
    case 'permission.added':
    case 'question.added':
      return event;
    case 'queue.updated':
      return { ...event, queue: trimQueue(event.queue) };
    default:
      return event;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a), 'hex');
  const y = Buffer.from(sha256(b), 'hex');
  return timingSafeEqual(x, y);
}

/** A phone's name as shown on the desktop: printable, short. */
function cleanName(name: unknown): string {
  const s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 40);
  return s || 'Phone';
}

/** Only pages of the phone app itself (or non-browser clients) may open a socket here. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.hostname === 'localhost' && ['http:', 'https:', 'capacitor:'].includes(o.protocol);
  } catch {
    return false;
  }
}

/** This computer's IPv4 addresses on private networks, the likely home network first. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== 'IPv4') continue;
      if (/^169\.254\./.test(a.address)) continue;
      out.push(a.address);
    }
  }
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ? 3 : 4);
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b)).slice(0, 4);
}

/** Narrows what a phone may pass to a method beyond the allowlist itself. */
function narrow(method: string, params: Record<string, unknown>): Record<string, unknown> {
  const p = { ...params };
  if (method === 'session.setOptions') {
    const o = (p.options ?? {}) as Record<string, unknown>;
    p.options = 'remoteControl' in o ? { remoteControl: !!o.remoteControl } : {};
  }
  if (method === 'session.create') {
    const o = p.options as Record<string, unknown> | undefined;
    if (o && typeof o === 'object') p.options = 'remoteControl' in o ? { remoteControl: !!o.remoteControl } : undefined;
    delete p.handoverFrom;
  }
  if (method === 'session.update') {
    const patch = (p.patch ?? {}) as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const k of ['pinned', 'archived', 'unread'] as const) if (typeof patch[k] === 'boolean') out[k] = patch[k] as boolean;
    p.patch = out;
  }
  if (method === 'provider.limits') delete p.force;
  return p;
}

export class PhoneService {
  private server?: Server;
  private wss?: WebSocketServer;
  private file: string;
  private data: PhoneFile;
  private listening = false;
  private error?: string;
  private port: number;
  private host: string;
  private pairing?: { key: string; expiresAt: number; link: string; qr: string; size: number };
  private request?: { id: string; name: string; address: string; at: number; ws: WebSocket; timer: NodeJS.Timeout };
  private fails = new Map<string, { count: number; first: number; blockedUntil?: number }>();
  private globalFails: number[] = [];
  /** Authenticated sockets per device id. */
  private live = new Map<string, Set<WebSocket>>();
  private saveTimer?: NodeJS.Timeout;
  private starting?: Promise<void>;

  constructor(
    private app: App,
    opts: PhoneOptions = {},
  ) {
    this.file = opts.file ?? path.join(app.store.dir, 'phone.json');
    this.port = opts.port ?? PHONE_PORT;
    this.host = opts.host ?? process.env.SABLE_PHONE_HOST ?? '0.0.0.0';
    this.data = this.read();
  }

  get enabled() {
    return this.data.enabled;
  }

  private read(): PhoneFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PhoneFile>;
      const devices = Array.isArray(raw.devices) ? raw.devices.filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(d.tokenHash)) : [];
      return { enabled: !!raw.enabled, devices };
    } catch {
      return { enabled: false, devices: [] };
    }
  }

  private save(now = false) {
    clearTimeout(this.saveTimer);
    const write = () => {
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        renameSync(tmp, this.file);
      } catch (err) {
        this.app.log('phone: could not save', (err as Error).message);
      }
    };
    if (now) write();
    else this.saveTimer = setTimeout(write, 2000);
  }

  status(): PhoneStatus {
    if (this.pairing && this.pairing.expiresAt < Date.now()) this.pairing = undefined;
    const devices: PhoneDevice[] = this.data.devices
      .map((d) => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen, ...(this.live.get(d.id)?.size ? { online: true } : {}) }))
      .sort((a, b) => (b.lastSeen ?? b.pairedAt) - (a.lastSeen ?? a.pairedAt));
    return {
      enabled: this.data.enabled,
      listening: this.listening,
      port: this.port,
      hosts: lanAddresses(),
      name: os.hostname(),
      devices,
      ...(this.pairing ? { pairing: { link: this.pairing.link, expiresAt: this.pairing.expiresAt, qr: this.pairing.qr, size: this.pairing.size } } : {}),
      ...(this.request ? { request: { id: this.request.id, name: this.request.name, address: this.request.address, at: this.request.at } } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private changed() {
    this.app.emit({ type: 'phone.updated', status: this.status() });
  }

  async setEnabled(on: boolean) {
    this.data.enabled = on;
    this.save(true);
    if (on) await this.start();
    else await this.stop();
    this.changed();
    return this.status();
  }

  start(): Promise<void> {
    if (this.server) return this.starting ?? Promise.resolve();
    this.error = undefined;
    const server = createServer((req, res) => {
      // A file the agent handed over, by the link `phone.fileLink` made (the token is the only key).
      if (req.method === 'GET' && req.url?.startsWith('/f/')) return void this.serveFile(req, res);
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end();
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 10_000;
    // Compressed frames (permessage-deflate) above 1 KB: JSON of a conversation shrinks several times over Wi-Fi.
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 5 }, concurrencyLimit: 4 },
    });
    server.on('upgrade', (req, socket, head) => this.onUpgrade(wss, req, socket, head));
    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => this.onSocket(ws, req));
    this.server = server;
    this.wss = wss;
    this.starting = new Promise<void>((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.listening = false;
        this.error = err.code === 'EADDRINUSE' ? `Port ${this.port} is in use by another program` : err.message;
        this.server = undefined;
        this.wss = undefined;
        this.changed();
        resolve();
      });
      server.listen(this.port, this.host, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
        this.listening = true;
        this.app.log(`phone endpoint on ${this.host}:${this.port}`);
        this.changed();
        resolve();
      });
    });
    return this.starting;
  }

  async stop() {
    this.listening = false;
    this.pairing = undefined;
    this.endRequest('Phone access was turned off');
    const server = this.server;
    const wss = this.wss;
    this.server = undefined;
    this.wss = undefined;
    this.starting = undefined;
    if (wss) {
      for (const c of wss.clients) c.terminate();
      wss.close();
    }
    this.live.clear();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  pair(cancel?: boolean) {
    if (cancel) this.pairing = undefined;
    else {
      const key = randomBytes(16).toString('base64url');
      const hosts = lanAddresses();
      const link = `sable://pair?h=${hosts.join(',')}&p=${this.port}&k=${key}&n=${encodeURIComponent(os.hostname().slice(0, 30))}`;
      const { path: qr, size } = qrSvgPath(link);
      this.pairing = { key, expiresAt: Date.now() + PAIR_TTL_MS, link, qr, size };
    }
    this.changed();
    return this.status();
  }

  approve(requestId: string, allow: boolean) {
    const r = this.request;
    if (!r || r.id !== requestId) return this.status();
    clearTimeout(r.timer);
    this.request = undefined;
    if (!allow) {
      this.sendFrame(r.ws, { denied: 'The desktop did not allow this phone' });
      r.ws.close(4003, 'denied');
    } else if (r.ws.readyState === r.ws.OPEN) {
      const token = randomBytes(32).toString('base64url');
      const device: StoredPhone = { id: randomUUID(), name: r.name, tokenHash: sha256(token), pairedAt: Date.now(), lastSeen: Date.now() };
      this.data.devices.push(device);
      this.save(true);
      this.sendFrame(r.ws, { paired: { token, deviceId: device.id, desktop: os.hostname() } });
      this.authenticated(r.ws, device);
    }
    this.changed();
    return this.status();
  }

  revoke(deviceId: string) {
    this.data.devices = this.data.devices.filter((d) => d.id !== deviceId);
    this.save(true);
    for (const ws of this.live.get(deviceId) ?? []) {
      this.sendFrame(ws, { denied: 'This phone was removed on the desktop' });
      ws.close(4001, 'revoked');
    }
    this.live.delete(deviceId);
    this.changed();
    return this.status();
  }

  private endRequest(reason: string) {
    const r = this.request;
    if (!r) return;
    clearTimeout(r.timer);
    this.request = undefined;
    this.sendFrame(r.ws, { denied: reason });
    r.ws.close(4003, 'denied');
  }

  // ── rate limits ──

  private blocked(ip: string): boolean {
    const now = Date.now();
    this.globalFails = this.globalFails.filter((t) => now - t < 60_000);
    if (this.globalFails.length >= GLOBAL_FAILS_PER_MIN) return true;
    const f = this.fails.get(ip);
    return !!f?.blockedUntil && f.blockedUntil > now;
  }

  private failed(ip: string) {
    const now = Date.now();
    this.globalFails.push(now);
    let f = this.fails.get(ip);
    if (!f || now - f.first > FAIL_WINDOW_MS) f = { count: 0, first: now };
    f.count++;
    if (f.count >= MAX_FAILS) f.blockedUntil = now + BLOCK_MS;
    this.fails.set(ip, f);
    if (this.fails.size > 1000) for (const [k, v] of this.fails) if (now - v.first > FAIL_WINDOW_MS) this.fails.delete(k);
  }

  // ── sockets ──

  /** Download links for files the agent handed over (`phone.fileLink`): token -> the one file, until it expires. */
  private files = new Map<string, { path: string; name: string; expires: number }>();

  private async fileLink(sessionId: string, itemId: string, index: number): Promise<{ path: string; name: string; size?: number }> {
    const snap = await this.app.call('session.snapshot', { sessionId });
    const item = snap.items.find((i) => i.id === itemId);
    const file = item?.type === 'tool' && item.kind === 'share' ? item.detail.files?.[index] : undefined;
    if (!file) throw new Error('That file is not in this chat.');
    let size: number;
    try {
      const st = statSync(file.path);
      if (!st.isFile()) throw new Error();
      size = st.size;
    } catch {
      throw new Error('That file is no longer on the computer.');
    }
    const now = Date.now();
    for (const [t, f] of this.files) if (f.expires < now) this.files.delete(t);
    while (this.files.size >= 50) this.files.delete(this.files.keys().next().value as string);
    const token = randomBytes(24).toString('base64url');
    this.files.set(token, { path: file.path, name: file.name, expires: now + 15 * 60_000 });
    return { path: `/f/${token}/${encodeURIComponent(file.name)}`, name: file.name, size };
  }

  /** `phone.mkdir`: one new folder in an existing one, by a plain name (no separators, nothing hidden, no overwrite). */
  private makeFolder(parent: string, name: string): { path: string } {
    const n = name.trim();
    if (!n || n.length > 120 || n.startsWith('.') || /[\\/:*?"<>|\x00-\x1f]/.test(n) || /[. ]$/.test(n)) throw new Error('That name cannot be a folder name.');
    if (!path.isAbsolute(parent)) throw new Error('That folder is not on this computer.');
    try {
      if (!statSync(parent).isDirectory()) throw new Error();
    } catch {
      throw new Error('That folder is not on this computer.');
    }
    const target = path.join(parent, n);
    if (path.dirname(target) !== path.resolve(parent)) throw new Error('That name cannot be a folder name.');
    try {
      mkdirSync(target);
    } catch (err) {
      throw new Error((err as NodeJS.ErrnoException).code === 'EEXIST' ? 'A folder with that name is already there.' : 'The folder could not be made there.');
    }
    return { path: target };
  }

  private serveFile(req: IncomingMessage, res: ServerResponse) {
    const token = (req.url ?? '').split('/')[2] ?? '';
    const entry = this.files.get(token);
    const fail = (code: number, text: string) => void res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(text);
    if (!entry) return fail(404, 'Not found');
    if (entry.expires < Date.now()) {
      this.files.delete(token);
      return fail(410, 'This link has expired. Open the file again in Sable.');
    }
    let size: number;
    try {
      size = statSync(entry.path).size;
    } catch {
      return fail(404, 'The file is no longer on the computer.');
    }
    const type = /\.apk$/i.test(entry.name) ? 'application/vnd.android.package-archive' : 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(entry.path).on('error', () => res.destroy()).pipe(res);
  }

  private onUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer) {
    const ip = req.socket.remoteAddress ?? '?';
    const url = new URL(req.url ?? '/', 'http://phone');
    const refuse = (code: number, text: string) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nconnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== PHONE_PATH) return refuse(404, 'Not Found');
    if (!originAllowed(req)) return refuse(403, 'Forbidden');
    if (this.blocked(ip)) return refuse(429, 'Too Many Requests');
    if (wss.clients.size >= MAX_SOCKETS) return refuse(503, 'Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  private sendFrame(ws: WebSocket, frame: PhoneFrame | ServerFrame) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(frame));
  }

  private onSocket(ws: WebSocket, req: IncomingMessage) {
    const ip = req.socket.remoteAddress ?? '?';
    let state: 'hello' | 'waiting' | 'open' = 'hello';
    const helloTimer = setTimeout(() => {
      if (state === 'hello') ws.close(4000, 'timeout');
    }, HELLO_TIMEOUT_MS);

    const onHello = (raw: RawData) => {
      if (state !== 'hello') return;
      const text = raw.toString();
      if (text.length > MAX_HELLO_BYTES) return ws.close(1009, 'too big');
      let msg: PhoneHello;
      try {
        msg = JSON.parse(text);
      } catch {
        return ws.close(4000, 'bad hello');
      }
      if ('hello' in msg && msg.hello && typeof msg.hello.token === 'string') {
        const hash = sha256(msg.hello.token);
        const device = this.data.devices.find((d) => timingSafeEqual(Buffer.from(d.tokenHash, 'hex'), Buffer.from(hash, 'hex')));
        if (!device) {
          this.failed(ip);
          this.sendFrame(ws, { denied: 'This phone is not paired with this computer' });
          return ws.close(4001, 'unknown token');
        }
        this.fails.delete(ip);
        clearTimeout(helloTimer);
        ws.off('message', onHello);
        state = 'open';
        this.authenticated(ws, device);
        return;
      }
      if ('pair' in msg && msg.pair && typeof msg.pair.key === 'string') {
        const p = this.pairing;
        if (!p || p.expiresAt < Date.now() || !sameSecret(msg.pair.key, p.key)) {
          this.failed(ip);
          this.sendFrame(ws, { denied: p ? 'This pairing code is not valid. Show a new one on the desktop.' : 'Pairing is not open. Show the code in Settings › Phone.' });
          return ws.close(4002, 'bad key');
        }
        // One phone per key; a second request replaces nothing while one waits.
        if (this.request) {
          this.sendFrame(ws, { denied: 'Another phone is pairing. Try again in a moment.' });
          return ws.close(4003, 'busy');
        }
        this.pairing = undefined;
        clearTimeout(helloTimer);
        state = 'waiting';
        const id = randomUUID();
        this.request = {
          id,
          name: cleanName(msg.pair.name),
          address: ip.replace(/^::ffff:/, ''),
          at: Date.now(),
          ws,
          timer: setTimeout(() => {
            if (this.request?.id === id) {
              this.endRequest('Nobody answered on the desktop');
              this.changed();
            }
          }, REQUEST_TTL_MS),
        };
        this.sendFrame(ws, { waiting: true });
        ws.off('message', onHello);
        this.changed();
        return;
      }
      ws.close(4000, 'bad hello');
    };
    ws.on('message', onHello);
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (this.request?.ws === ws) {
        clearTimeout(this.request.timer);
        this.request = undefined;
        this.changed();
      }
    });
    ws.on('error', () => ws.terminate());
  }

  /** From here on the socket is a narrowed bridge connection for `device`. */
  private authenticated(ws: WebSocket, device: StoredPhone) {
    device.lastSeen = Date.now();
    this.save();
    let set = this.live.get(device.id);
    if (!set) this.live.set(device.id, (set = new Set()));
    set.add(ws);
    // Its addresses now: a phone keeps new ones (Tailscale, a new network) and reaches it there later.
    this.sendFrame(ws, { welcome: { deviceId: device.id, desktop: os.hostname(), version: VERSION, hosts: lanAddresses() } });
    this.changed();

    // The conversations this socket has open (opened last at the end): their items' events reach it.
    const watching: string[] = [];
    const watch = (id: string) => {
      const i = watching.indexOf(id);
      if (i >= 0) watching.splice(i, 1);
      watching.push(id);
      if (watching.length > WATCH_MAX) watching.shift();
    };
    const unsubscribe = this.app.subscribe((event) => {
      if (!PHONE_EVENTS.has(event.type)) return;
      if (ITEM_EVENTS.has(event.type) && !watching.includes((event as { sessionId: string }).sessionId)) return;
      const e = phoneEvent(event);
      if (e) this.sendFrame(ws, { event: e as BridgeEvent });
    });
    let alive = true;
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 25_000);

    ws.on('message', async (raw) => {
      let req: RpcRequest;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof req?.id !== 'number' || typeof req.method !== 'string') return;
      if (!ALLOWED.has(req.method) && !OWN.has(req.method)) {
        this.sendFrame(ws, { id: req.id, ok: false, error: `Not available from the phone: ${req.method}` });
        return;
      }
      try {
        const raw = req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {};
        const own = req.method as string;
        let result: unknown;
        if (own === 'phone.fileLink') {
          result = await this.fileLink(String(raw.sessionId ?? ''), String(raw.itemId ?? ''), Number(raw.index ?? 0));
        } else if (own === 'phone.mkdir') {
          result = this.makeFolder(String(raw.parent ?? ''), String(raw.name ?? ''));
        } else if (own === 'phone.tail' || own === 'phone.item') {
          const sessionId = String(raw.sessionId ?? '');
          // The session's own snapshot (loads it from disk the first time, marks it read), then trimmed.
          const snap = await this.app.call('session.snapshot', { sessionId });
          if (own === 'phone.tail') {
            watch(sessionId);
            const before = typeof raw.before === 'string' ? raw.before : undefined;
            const limit = typeof raw.limit === 'number' ? raw.limit : undefined;
            result = phoneTail(snap, { before, limit });
          } else result = phoneDetail(snap.items, String(raw.itemId ?? ''));
        } else {
          const params = narrow(req.method, raw);
          result = await this.app.call(req.method as RpcName, params as never);
          // Folder browsing for a new chat: folders only, never file names.
          if (req.method === 'fs.list' && result && typeof result === 'object') {
            const r = result as { entries?: { dir: boolean }[] };
            result = { ...r, entries: (r.entries ?? []).filter((e) => e.dir) };
          }
          // A conversation (opened, created, carried to another account): its newest page, never all of it.
          if (isSnapshot(result)) {
            watch(result.session.id);
            result = phoneTail(result);
          }
        }
        this.sendFrame(ws, { id: req.id, ok: true, result });
      } catch (err) {
        this.sendFrame(ws, { id: req.id, ok: false, error: (err as Error).message ?? String(err) });
      }
    });
    const done = () => {
      clearInterval(ping);
      unsubscribe();
      const s = this.live.get(device.id);
      s?.delete(ws);
      if (s && !s.size) this.live.delete(device.id);
      const d = this.data.devices.find((x) => x.id === device.id);
      if (d) {
        d.lastSeen = Date.now();
        this.save();
      }
      this.changed();
    };
    ws.once('close', done);
  }

  async dispose() {
    clearTimeout(this.saveTimer);
    this.save(true);
    await this.stop();
  }
}

export function registerPhone(app: App, opts: PhoneOptions = {}) {
  const phone = new PhoneService(app, opts);
  app.register('phone.status', () => phone.status());
  app.register('phone.setEnabled', ({ on }) => phone.setEnabled(!!on));
  app.register('phone.pair', ({ cancel } = {}) => phone.pair(!!cancel));
  app.register('phone.approve', ({ requestId, allow }) => phone.approve(String(requestId), !!allow));
  app.register('phone.revoke', ({ deviceId }) => phone.revoke(String(deviceId)));
  app.onDispose(() => phone.dispose());
  if (phone.enabled) void phone.start();
  return phone;
}
