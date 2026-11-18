import type { FileDiff, Question, Todo, ToolDetail, ToolKind, ToolResult } from '../../shared/protocol';
import { countChanges, makeFileDiff } from '../../shared/diff';
import { WIDGET_SERVER, WIDGET_TOOL_ID, describeWidget } from './widget-tool';
import { browserOp, describeBrowser } from './browser-tool';
import { agentOfTool, describeAgentCall } from './agent-tool';

/** Normalizes Claude Code tool calls and results into Sable's display model. */

export interface ToolView {
  kind: ToolKind;
  title: string;
  detail: ToolDetail;
}

type Obj = Record<string, any>;

const MAX_TEXT = 80_000;

export function baseName(p?: string): string {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

function clip(text: string | undefined): { text?: string; truncated?: boolean } {
  if (text === undefined) return {};
  if (text.length <= MAX_TEXT) return { text };
  return { text: text.slice(0, MAX_TEXT), truncated: true };
}

export function shortCommand(command?: string): string {
  if (!command) return 'Run command';
  const first = command.trim().split('\n')[0];
  return first.length > 72 ? first.slice(0, 70) + '…' : first;
}

function host(url?: string): string {
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '');
  } catch {
    return url ?? 'page';
  }
}

export function describeTool(name: string, input: Obj = {}): ToolView {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return {
        kind: 'bash',
        title: input.description || shortCommand(input.command),
        detail: { command: input.command, description: input.description, background: !!input.run_in_background },
      };
    case 'BashOutput':
    case 'TaskOutput':
      return { kind: 'bash', title: 'Check background output', detail: {} };
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop':
      return { kind: 'bash', title: 'Stop background task', detail: {} };
    case 'Read':
      return {
        kind: 'read',
        title: `Read ${baseName(input.file_path) || 'file'}`,
        detail: {
          path: input.file_path,
          range: input.offset ? [Number(input.offset), Number(input.offset) + Number(input.limit ?? 0)] : undefined,
        },
      };
    case 'Edit':
      return {
        kind: 'edit',
        title: `Edit ${baseName(input.file_path) || 'file'}`,
        detail: { path: input.file_path, oldText: input.old_string, newText: input.new_string },
      };
    case 'MultiEdit': {
      // A blank line between edits keeps each old/new pair aligned in the joined diff.
      const edits = multiEdits(input);
      return {
        kind: 'edit',
        title: `Edit ${baseName(input.file_path) || 'file'}`,
        detail: edits.length
          ? { path: input.file_path, oldText: edits.map((e) => e.old).join('\n\n'), newText: edits.map((e) => e.new).join('\n\n') }
          : { path: input.file_path },
      };
    }
    case 'NotebookEdit':
      return { kind: 'edit', title: `Edit ${baseName(input.notebook_path) || 'notebook'}`, detail: { path: input.notebook_path, newText: input.new_source } };
    case 'Write':
      return { kind: 'write', title: `Write ${baseName(input.file_path) || 'file'}`, detail: { path: input.file_path, content: input.content } };
    case 'Glob':
      return { kind: 'glob', title: `Find ${input.pattern ?? 'files'}`, detail: { pattern: input.pattern, path: input.path } };
    case 'Grep':
      return { kind: 'search', title: `Search for ${input.pattern ? `“${clipInline(input.pattern, 40)}”` : 'text'}`, detail: { pattern: input.pattern, path: input.path, glob: input.glob } };
    case 'WebFetch':
      return { kind: 'fetch', title: `Fetch ${host(input.url)}`, detail: { url: input.url, description: input.prompt } };
    case 'WebSearch':
      return { kind: 'websearch', title: input.query ? `Search the web for “${clipInline(input.query, 48)}”` : 'Search the web', detail: { query: input.query } };
    case 'Task':
    case 'Agent':
      return {
        kind: 'agent',
        title: input.description || 'Run a subagent',
        // A background agent (run_in_background, or a remote one, which always runs in the background) keeps working after the call returns.
        detail: { subagent: input.subagent_type, description: input.description, prompt: input.prompt, ...(input.run_in_background || input.isolation === 'remote' ? { background: true } : {}) },
      };
    case 'TodoWrite':
      return { kind: 'todo', title: 'Update the task list', detail: { todos: normalizeTodos(input.todos) } };
    case 'TaskCreate':
      return { kind: 'todo', title: input.subject ? `Add task: ${input.subject}` : 'Add a task', detail: {} };
    case 'TaskUpdate':
      return { kind: 'todo', title: input.status ? `Mark task ${String(input.status).replace('_', ' ')}` : 'Update a task', detail: {} };
    case 'TaskList':
    case 'TaskGet':
      return { kind: 'todo', title: 'Review the task list', detail: {} };
    case 'AskUserQuestion':
      return { kind: 'question', title: 'Ask a question', detail: { questions: normalizeQuestions(input.questions) } };
    case 'ExitPlanMode':
      return { kind: 'plan', title: 'Propose a plan', detail: { plan: input.plan } };
    case 'EnterPlanMode':
      return { kind: 'plan', title: 'Switch to planning', detail: {} };
    case 'Skill':
      return { kind: 'skill', title: `Use the ${input.skill ?? ''} skill`.replace('  ', ' '), detail: { skill: input.skill, description: input.args } };
    case 'ToolSearch':
      return { kind: 'other', title: 'Look up tools', detail: { query: input.query } };
    case WIDGET_TOOL_ID:
      return describeWidget(input);
    default: {
      if (name.startsWith(`mcp__${WIDGET_SERVER}__browser_`) && browserOp(name)) return describeBrowser(name, input);
      const agent = agentOfTool(name);
      if (agent) return describeAgentCall(agent, input);
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__');
        const tool = rest.join('__');
        return { kind: 'mcp', title: tool.replace(/[_-]+/g, ' '), detail: { server, tool } };
      }
      return { kind: 'other', title: name.replace(/([a-z])([A-Z])/g, '$1 $2'), detail: {} };
    }
  }
}

function clipInline(s: string, n: number) {
  const one = String(s).replace(/\s+/g, ' ');
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

export function normalizeTodos(raw: unknown): Todo[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t: Obj) => ({
    id: t.id ? String(t.id) : undefined,
    content: String(t.content ?? t.subject ?? ''),
    activeForm: t.activeForm ? String(t.activeForm) : undefined,
    status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending',
  }));
}

export function normalizeQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((q: Obj) => ({
    question: String(q.question ?? ''),
    header: q.header ? String(q.header) : undefined,
    multiSelect: !!q.multiSelect,
    options: Array.isArray(q.options)
      ? q.options.map((o: Obj) => ({ label: String(o.label ?? ''), description: o.description ? String(o.description) : undefined }))
      : [],
  }));
}

/** Flattens a tool_result `content` (string or content blocks) into text + images. */
export function flattenContent(content: unknown): { text: string; images: string[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  const images: string[] = [];
  let text = '';
  if (Array.isArray(content)) {
    for (const block of content as Obj[]) {
      if (block?.type === 'text' && typeof block.text === 'string') text += (text ? '\n' : '') + block.text;
      else if (block?.type === 'image' && block.source?.type === 'base64') {
        images.push(`data:${block.source.media_type};base64,${block.source.data}`);
      }
    }
  }
  return { text, images };
}

function patchToDiff(path: string, patch: Obj[] | undefined, status: FileDiff['status']): FileDiff | undefined {
  if (!Array.isArray(patch) || !patch.length) return undefined;
  const hunks = patch.map((h) => ({
    oldStart: Number(h.oldStart ?? 1),
    oldLines: Number(h.oldLines ?? 0),
    newStart: Number(h.newStart ?? 1),
    newLines: Number(h.newLines ?? 0),
    lines: Array.isArray(h.lines) ? h.lines.map(String) : [],
  }));
  return { path, status, hunks, ...countChanges(hunks) };
}

function multiEdits(input: Obj): { old: string; new: string }[] {
  if (!Array.isArray(input.edits)) return [];
  return input.edits.filter((e: unknown) => e && typeof e === 'object').map((e: Obj) => ({ old: String(e.old_string ?? ''), new: String(e.new_string ?? '') }));
}

/** A best-effort diff from a tool's *input*, shown before the tool has run (permission prompts). */
export function previewDiff(name: string, input: Obj, currentFile?: string | null): FileDiff[] | undefined {
  if (name === 'Edit' && typeof input.file_path === 'string') {
    const oldText = String(input.old_string ?? '');
    const newText = String(input.new_string ?? '');
    let startLine = 1;
    if (currentFile) {
      const at = currentFile.indexOf(oldText);
      if (at >= 0) startLine = currentFile.slice(0, at).split('\n').length;
    }
    return [makeFileDiff(input.file_path, oldText, newText, { startLine })];
  }
  if (name === 'MultiEdit' && typeof input.file_path === 'string') {
    const edits = multiEdits(input);
    if (!edits.length) return undefined;
    if (currentFile) {
      // Apply the edits in order, as the tool does, and diff the whole file.
      let text: string | null = currentFile;
      for (const e of edits) {
        const at: number = text.indexOf(e.old);
        if (!e.old || at < 0) {
          text = null;
          break;
        }
        text = text.slice(0, at) + e.new + text.slice(at + e.old.length);
      }
      if (text !== null) return [makeFileDiff(input.file_path, currentFile, text)];
    }
    // Without the file: one hunk per edit.
    const hunks = edits.flatMap((e) => makeFileDiff(input.file_path, e.old, e.new).hunks);
    return [{ path: input.file_path, status: 'modified', hunks, ...countChanges(hunks) }];
  }
  if (name === 'Write' && typeof input.file_path === 'string') {
    return [makeFileDiff(input.file_path, currentFile ?? null, String(input.content ?? ''))];
  }
  return undefined;
}

export function mapResult(name: string, input: Obj, structured: unknown, content: unknown, isError: boolean): ToolResult {
  const flat = flattenContent(content);
  const r: Obj = structured && typeof structured === 'object' ? (structured as Obj) : {};
  const out: ToolResult = {};
  if (isError) out.isError = true;
  if (flat.images.length) out.images = flat.images;

  if (isError) {
    Object.assign(out, clip(flat.text || (typeof structured === 'string' ? structured : '')));
    const code = flat.text.match(/Exit code (\d+)/);
    if (code) out.exitCode = Number(code[1]);
    return out;
  }

  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      Object.assign(out, clip(typeof r.stdout === 'string' ? r.stdout : flat.text));
      if (r.stderr) out.stderr = String(r.stderr).slice(0, MAX_TEXT);
      if (r.interrupted) out.interrupted = true;
      out.exitCode = 0;
      return out;
    }
    case 'Read': {
      if (r.file && typeof r.file === 'object') {
        const c = clip(typeof r.file.content === 'string' ? r.file.content : undefined);
        out.file = {
          path: String(r.file.filePath ?? input.file_path ?? ''),
          content: c.text,
          startLine: r.file.startLine,
          numLines: r.file.numLines,
          totalLines: r.file.totalLines,
        };
        if (c.truncated) out.truncated = true;
      } else if (!flat.images.length) Object.assign(out, clip(flat.text));
      return out;
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const path = String(r.filePath ?? input.file_path ?? input.notebook_path ?? '');
      const created = r.type === 'create' || (name === 'Write' && r.originalFile == null && !r.structuredPatch?.length);
      const diff =
        patchToDiff(path, r.structuredPatch, created ? 'added' : 'modified') ??
        (created && typeof (r.content ?? input.content) === 'string' ? makeFileDiff(path, null, String(r.content ?? input.content)) : undefined) ??
        previewDiff(name, input)?.[0];
      if (diff) out.diff = [diff];
      return out;
    }
    case 'Glob': {
      if (Array.isArray(r.filenames)) out.files = r.filenames.slice(0, 400).map(String);
      out.count = Number(r.numFiles ?? out.files?.length ?? 0);
      if (r.truncated) out.truncated = true;
      if (!out.files) Object.assign(out, clip(flat.text));
      return out;
    }
    case 'Grep': {
      if (Array.isArray(r.filenames) && r.filenames.length) out.files = r.filenames.slice(0, 400).map(String);
      if (typeof r.content === 'string' && r.content) Object.assign(out, clip(r.content));
      out.count = Number(r.numMatches ?? r.numLines ?? r.numFiles ?? out.files?.length ?? 0);
      if (!out.files && out.text === undefined) Object.assign(out, clip(flat.text));
      return out;
    }
    case 'WebSearch': {
      const links: { title: string; url: string }[] = [];
      if (Array.isArray(r.results)) {
        for (const entry of r.results) {
          if (entry && typeof entry === 'object' && Array.isArray(entry.content)) {
            for (const hit of entry.content) if (hit?.url) links.push({ title: String(hit.title ?? hit.url), url: String(hit.url) });
          }
        }
      }
      if (links.length) out.links = links.slice(0, 24);
      else Object.assign(out, clip(flat.text));
      out.count = links.length;
      return out;
    }
    case 'WebFetch': {
      Object.assign(out, clip(typeof r.result === 'string' ? r.result : flat.text));
      return out;
    }
    case 'Task':
    case 'Agent': {
      const text = Array.isArray(r.content) ? flattenContent(r.content).text : flat.text;
      Object.assign(out, clip(text));
      return out;
    }
    case 'AskUserQuestion': {
      if (r.answers && typeof r.answers === 'object') {
        out.answers = Object.fromEntries(Object.entries(r.answers as Obj).map(([q, a]) => [q, Array.isArray(a) ? a.map(String) : [String(a)]]));
      }
      return out;
    }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return out;
    default: {
      Object.assign(out, clip(flat.text));
      return out;
    }
  }
}

/** Pulls early field values out of a still-streaming JSON input so titles can update live. */
export function peekPartialInput(json: string): Obj {
  const out: Obj = {};
  for (const key of ['file_path', 'notebook_path', 'command', 'description', 'pattern', 'url', 'query', 'subagent_type', 'skill', 'subject', 'title']) {
    const m = json.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (m) {
      try {
        out[key] = JSON.parse(`"${m[1]}"`);
      } catch {
        /* incomplete escape */
      }
    }
  }
  return out;
}
