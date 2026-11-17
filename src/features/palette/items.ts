import type { Capabilities, ProviderId, SessionMeta } from '@shared/protocol';
import { PROVIDER_NAME } from '@/art/Logo';
import type { IconName } from '@/icons';
import { baseName, tildePath } from '@/lib/format';
import { skillLabeller } from '@/lib/skills';
import { SECTIONS as SETTINGS_SECTIONS } from '@/features/settings/sections';
import { openImport } from '@/features/history/History';
import { continueInAgent, goHome, interrupt, openSession, openSettings } from '@/state/actions';
import { focusComposer } from '@/state/hooks';
import { useStore, type RailTab } from '@/state/store';

export type PaletteGroup = 'Recent' | 'Sessions' | 'Projects' | 'Actions' | 'Commands' | 'Skills';

export interface PaletteItem {
  id: string;
  group: Exclude<PaletteGroup, 'Recent'>;
  title: string;
  sub?: string;
  /** Extra words that match but are not shown. */
  keywords?: string;
  icon?: IconName;
  tone?: string;
  keys?: string;
  session?: SessionMeta;
  run: () => void;
}

const RAIL_TABS: { id: RailTab; label: string; icon: IconName }[] = [
  { id: 'changes', label: 'Changes', icon: 'diff' },
  { id: 'files', label: 'Files', icon: 'folder-open' },
  { id: 'browser', label: 'Browser', icon: 'globe' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'context', label: 'Context', icon: 'context' },
  { id: 'agents', label: 'Agents', icon: 'robot' },
];

const SKILL_TONE = 'var(--ember)';

/** Everything the palette can do right now, built fresh each time it opens or the store changes. */
export function buildItems(opts: {
  sessions: SessionMeta[];
  projects: { path: string; name: string }[];
  activeId: string | null;
  active?: SessionMeta;
  installed: ProviderId[];
  homeProvider: ProviderId;
  caps?: Capabilities;
  /** A session's account name, only when its agent has several accounts. */
  accountName?: (s: SessionMeta) => string | undefined;
}): PaletteItem[] {
  const { setUi } = useStore.getState();
  const ui = () => useStore.getState().ui;
  const items: PaletteItem[] = [];

  for (const s of opts.sessions) {
    items.push({
      id: `session:${s.id}`,
      group: 'Sessions',
      title: s.title,
      sub: [baseName(s.cwd), opts.accountName?.(s)].filter(Boolean).join(' · '),
      keywords: `${PROVIDER_NAME[s.provider]}${s.archived ? ' archived' : ''}`,
      session: s,
      run: () => openSession(s.id),
    });
  }

  for (const p of opts.projects) {
    items.push({
      id: `project:${p.path}`,
      group: 'Projects',
      title: p.name || baseName(p.path),
      sub: tildePath(p.path, useStore.getState().home),
      icon: 'folder',
      run: () => goHome(p.path),
    });
  }

  const act = (id: string, title: string, icon: IconName, run: () => void, extra: Partial<PaletteItem> = {}) =>
    items.push({ id: `action:${id}`, group: 'Actions', title, icon, run, ...extra });

  act('new', 'New session', 'compose', () => goHome(), { keys: 'mod+shift+o', keywords: 'start create chat' });
  act('open-folder', 'Open a folder', 'folder-plus', () => setUi({ projectPicker: true }), { keys: 'mod+o', keywords: 'project add browse' });
  act('history', 'History', 'history', () => setUi({ historyOpen: true }), { keywords: 'resume past conversations' });
  act('import', 'Import conversations', 'download', () => openImport(), { keywords: 'continue claude code codex cli desktop app history resume' });
  act('settings', 'Settings', 'settings', () => openSettings(), { keys: 'mod+,', keywords: 'preferences' });
  for (const s of SETTINGS_SECTIONS) {
    if (s.id === 'shortcuts') continue;
    act(`settings:${s.id}`, s.label, s.icon, () => openSettings(s.id), { sub: 'Settings', keywords: `settings preferences ${s.keywords}` });
  }
  act('toggle-sidebar', ui().sidebarOpen ? 'Hide sidebar' : 'Show sidebar', 'sidebar', () => setUi({ sidebarOpen: !ui().sidebarOpen }), {
    keys: 'mod+b',
    keywords: 'toggle sidebar',
  });

  if (opts.active) {
    const id = opts.active.id;
    act('toggle-panel', ui().railOpen ? 'Hide panel' : 'Show panel', 'sidebar', () => setUi({ railOpen: !ui().railOpen }), { keys: 'mod+j', keywords: 'toggle panel rail' });
    for (const t of RAIL_TABS) {
      if (t.id === 'browser') act('panel:browser', 'Open browser', t.icon, () => setUi({ railOpen: true, railTab: 'browser' }), { sub: 'Panel', keywords: 'panel show web page preview localhost url' });
      else act(`panel:${t.id}`, t.label, t.icon, () => setUi({ railOpen: true, railTab: t.id }), { sub: 'Panel', keywords: 'panel show open' });
    }
    // Continue in the other agent: Claude Code to Codex and back, starting from a summary.
    const other: ProviderId | undefined = opts.active.provider === 'claude' ? 'codex' : opts.active.provider === 'codex' ? 'claude' : undefined;
    if (other && opts.installed.includes(other))
      act(`continue:${other}`, `Continue in ${PROVIDER_NAME[other]}`, 'arrow-right', () => void continueInAgent(id, other), { keywords: 'handover switch agent move conversation' });
    const s = opts.active.status;
    if (s === 'running' || s === 'starting' || s === 'awaiting') {
      act('stop', 'Stop the current session', 'stop', () => void interrupt(id), { keywords: 'interrupt cancel halt', tone: 'var(--red)' });
    }
  }

  for (const p of opts.installed) {
    if (p === opts.homeProvider && !opts.activeId) continue;
    act(`provider:${p}`, `New session with ${PROVIDER_NAME[p]}`, 'compose', () => (setUi({ homeProvider: p }), goHome()), { sub: 'Switch provider', keywords: 'switch provider agent' });
  }

  act('shortcuts', 'Keyboard shortcuts', 'keyboard', () => openSettings('shortcuts'), { keywords: 'keys hotkeys bindings' });

  if (opts.caps) {
    const seen = new Set<string>();
    const label = skillLabeller([...opts.caps.commands.map((c) => c.name), ...opts.caps.skills.map((s) => s.name)]);
    for (const c of opts.caps.commands) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      const isSkill = c.kind === 'skill';
      items.push({
        id: `cmd:${c.name}`,
        group: isSkill ? 'Skills' : 'Commands',
        title: `${isSkill ? opts.caps.skillTrigger : '/'}${label(c.name)}`,
        sub: c.description,
        keywords: c.name,
        icon: isSkill ? 'skill' : 'prompt',
        tone: isSkill ? SKILL_TONE : undefined,
        run: () => focusComposer(`${isSkill ? opts.caps!.skillTrigger : '/'}${label(c.name)} `),
      });
    }
    for (const sk of opts.caps.skills) {
      if (seen.has(sk.name) || sk.enabled === false) continue;
      seen.add(sk.name);
      items.push({
        id: `skill:${sk.name}`,
        group: 'Skills',
        title: `${opts.caps.skillTrigger}${label(sk.name)}`,
        sub: sk.description,
        keywords: sk.name,
        icon: 'skill',
        tone: SKILL_TONE,
        run: () => focusComposer(`${opts.caps!.skillTrigger}${label(sk.name)} `),
      });
    }
  }

  return items;
}

// ── recently used ──

const RECENT_KEY = 'sable.palette.recent.v1';

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function pushRecent(id: string) {
  try {
    const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, 12);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}
