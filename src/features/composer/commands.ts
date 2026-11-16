import type { Capabilities, CommandKind } from '@shared/protocol';
import { fuzzy } from '@/lib/fuzzy';
import { skillLabeller } from '@/lib/skills';
import { goHome, interrupt, openSettings, renameSession } from '@/state/actions';
import { useStore } from '@/state/store';

/** Slash commands Sable handles itself, before anything reaches the agent. */

export interface CommandCtx {
  sessionId: string | null;
  openModel: () => void;
  openMode: () => void;
  openEffort: () => void;
}

export interface AppCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** Only offered inside a session. */
  session?: boolean;
  run: (ctx: CommandCtx, arg: string) => void;
}

const ui = () => useStore.getState().setUi;

function copyLastAnswer(sessionId: string) {
  const s = useStore.getState();
  const d = s.data[sessionId];
  if (!d) return;
  for (let i = d.roots.length - 1; i >= 0; i--) {
    const item = d.items[d.roots[i]];
    if (item?.type === 'text' && item.text.trim()) {
      navigator.clipboard.writeText(item.text).then(
        () => s.toast('Copied the last answer', 'success'),
        () => s.toast('Could not reach the clipboard', 'error'),
      );
      return;
    }
  }
  s.toast('There is no answer to copy yet');
}

export const APP_COMMANDS: AppCommand[] = [
  {
    name: 'new',
    description: 'Start a new session',
    run: ({ sessionId }) => {
      const s = useStore.getState();
      const meta = sessionId ? s.sessions[sessionId] : undefined;
      if (meta) s.setUi({ homeProvider: meta.provider });
      goHome(meta?.cwd);
    },
  },
  { name: 'model', description: 'Choose the model', run: (c) => c.openModel() },
  { name: 'effort', description: 'Choose the reasoning effort', run: (c) => c.openEffort() },
  { name: 'mode', description: 'Choose how much the agent may do without asking', run: (c) => c.openMode() },
  { name: 'resume', description: 'Resume an earlier conversation', run: () => ui()({ historyOpen: true }) },
  { name: 'settings', description: 'Open settings', run: () => openSettings() },
  { name: 'mcp', description: 'Manage MCP servers', run: () => openSettings('mcp') },
  { name: 'skills', description: 'Browse and toggle skills', run: () => openSettings('skills') },
  { name: 'agents', description: 'Manage subagents', run: () => openSettings('agents') },
  { name: 'memory', description: 'Edit memory files', run: () => openSettings('memory') },
  { name: 'permissions', description: 'Review permission rules', run: () => openSettings('permissions') },
  { name: 'context', description: 'Show how the context window is used', session: true, run: () => ui()({ railOpen: true, railTab: 'context' }) },
  { name: 'diff', description: 'Review changes in this folder', session: true, run: () => ui()({ railOpen: true, railTab: 'changes' }) },
  { name: 'terminal', description: 'Open the terminal panel', session: true, run: () => ui()({ railOpen: true, railTab: 'terminal' }) },
  {
    name: 'browser',
    description: 'Open a page in the panel browser',
    argumentHint: '[url]',
    session: true,
    run: (_c, arg) => ui()({ railOpen: true, railTab: 'browser', ...(arg.trim() ? { browserUrl: arg.trim() } : {}) }),
  },
  {
    name: 'rename',
    description: 'Rename this session',
    argumentHint: '<title>',
    session: true,
    run: ({ sessionId }, arg) => {
      if (!sessionId) return;
      if (!arg) {
        useStore.getState().toast('Add a title after /rename');
        return;
      }
      void renameSession(sessionId, arg);
    },
  },
  { name: 'stop', description: 'Stop the current turn', session: true, run: ({ sessionId }) => sessionId && void interrupt(sessionId) },
  { name: 'copy', description: 'Copy the last answer', session: true, run: ({ sessionId }) => sessionId && copyLastAnswer(sessionId) },
  { name: 'help', description: 'Show keyboard shortcuts', run: () => ui()({ shortcutsOpen: true }) },
];

export const appCommandsFor = (sessionId: string | null) => APP_COMMANDS.filter((c) => !c.session || sessionId);

export type RowKind = CommandKind | 'file' | 'dir' | 'skill';

export interface SuggestRow {
  id: string;
  group?: string;
  kind: RowKind;
  /** What the row inserts or runs. */
  name: string;
  label: string;
  indices?: number[];
  hint?: string;
  detail?: string;
  /** Path-like rows use the mono face. */
  mono?: boolean;
  /** For files: the relative path to insert. */
  value?: string;
}

/**
 * Fuzzy-ranks by the displayed text; an entry whose display name dropped a plugin prefix
 * still matches on its full name (without highlights, since those letters are not shown).
 */
function rank<T>(list: T[], query: string, text: (t: T) => string, full?: (t: T) => string) {
  if (!query) return list.map((t) => ({ t, indices: [] as number[] }));
  const out: { t: T; indices: number[]; score: number }[] = [];
  for (const t of list) {
    const m = fuzzy(query, text(t));
    if (m) out.push({ t, indices: m.indices, score: m.score });
    else if (full && full(t) !== text(t)) {
      const f = fuzzy(query, full(t));
      if (f) out.push({ t, indices: [], score: f.score - 1 });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Rows for "/": Sable's own commands, then the agent's commands and skills. */
export function commandRows(query: string, caps: Capabilities | undefined, sessionId: string | null): SuggestRow[] {
  const app = appCommandsFor(sessionId);
  const taken = new Set(APP_COMMANDS.map((c) => c.name));
  const provider = (caps?.commands ?? []).filter((c) => c.kind !== 'app' && !taken.has(c.name));
  const cmds = provider.filter((c) => c.kind !== 'skill');
  const skillNames = new Set<string>();
  const skills: { name: string; description: string }[] = [];
  for (const c of provider) if (c.kind === 'skill' && !skillNames.has(c.name)) (skillNames.add(c.name), skills.push(c));
  if (caps?.skillTrigger !== '$')
    for (const s of caps?.skills ?? [])
      if (s.enabled !== false && !skillNames.has(s.name) && !cmds.some((c) => c.name === s.name)) (skillNames.add(s.name), skills.push(s));
  // Short names only where they stay unambiguous, Sable's own commands included: what is shown is what is inserted.
  const short = skillLabeller([...taken, ...cmds.map((c) => c.name), ...skillNames]);

  const rows: SuggestRow[] = [];
  const shift = (ix: number[]) => ix.map((i) => i + 1);
  for (const { t, indices } of rank(app, query, (c) => c.name))
    rows.push({ id: `app:${t.name}`, group: 'Sable', kind: 'app', name: t.name, label: `/${t.name}`, indices: shift(indices), hint: t.argumentHint });
  // Built-in commands (Sable's and the agent's) need no description: people know them. Only what the
  // user's or the agent's own setup adds (custom commands, skills) keeps one, since its meaning is not known in advance.
  for (const { t, indices } of rank(cmds, query, (c) => short(c.name), (c) => c.name))
    rows.push({ id: `cmd:${t.name}`, group: 'Commands', kind: t.kind, name: short(t.name), label: `/${short(t.name)}`, indices: shift(indices), hint: t.argumentHint, detail: t.kind === 'builtin' ? undefined : t.description });
  for (const { t, indices } of rank(skills, query, (c) => short(c.name), (c) => c.name))
    rows.push({ id: `skill:${t.name}`, group: 'Skills', kind: 'skill', name: short(t.name), label: `/${short(t.name)}`, indices: shift(indices), detail: t.description });
  return rows;
}

/** Rows for "$" (Codex): skills only. */
export function skillRows(query: string, caps: Capabilities | undefined): SuggestRow[] {
  const skills = (caps?.skills ?? []).filter((s) => s.enabled !== false);
  const short = skillLabeller(skills.map((s) => s.name));
  return rank(skills, query, (s) => short(s.name), (s) => s.name).map(({ t, indices }) => ({
    id: `skill:${t.name}`,
    kind: 'skill' as const,
    name: short(t.name),
    label: `$${short(t.name)}`,
    indices: indices.map((i) => i + 1),
    detail: t.description,
  }));
}
