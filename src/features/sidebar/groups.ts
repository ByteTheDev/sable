import type { FolderOrder, Project, SessionMeta } from '@shared/protocol';
import { baseName } from '@/lib/format';

/** Case- and slash-insensitive key for a folder path. */
export const pathKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Whether a folder's sessions differ by agent or by account (rows then name who in their tooltip), or are all alike. */
export type Mix = 'agent' | 'account' | undefined;

/** What a collapsed folder shows in place of its count: the most pressing state inside it. */
export type Attention = 'awaiting' | 'error' | 'working' | 'unread' | undefined;

export interface ProjectGroup {
  key: string;
  path: string;
  name: string;
  pinned: boolean;
  /** Most recent activity in the group, for sorting. */
  last: number;
  /** Place in the manual folder order (Infinity: none yet). */
  order: number;
  sessions: SessionMeta[];
  archived: SessionMeta[];
  mix: Mix;
  attention: Attention;
}

export interface SidebarGroups {
  pinned: SessionMeta[];
  pinnedMix: Mix;
  projects: ProjectGroup[];
}

function mixOf(list: SessionMeta[]): Mix {
  if (list.length < 2) return undefined;
  const p = list[0].provider;
  const a = list[0].accountId ?? 'default';
  let accounts = false;
  for (const s of list) {
    if (s.provider !== p) return 'agent';
    if ((s.accountId ?? 'default') !== a) accounts = true;
  }
  return accounts ? 'account' : undefined;
}

const RANK: Record<Exclude<Attention, undefined>, number> = { awaiting: 4, error: 3, working: 2, unread: 1 };

function attentionOf(list: SessionMeta[]): Attention {
  let best: Attention;
  for (const s of list) {
    const a: Attention =
      s.status === 'awaiting' ? 'awaiting' : s.status === 'error' ? 'error' : s.status === 'running' || s.status === 'starting' ? 'working' : s.unread ? 'unread' : undefined;
    if (a && (!best || RANK[a] > RANK[best])) best = a;
  }
  return best;
}

/**
 * Pinned sessions float to their own group; everything else is grouped by folder.
 * Known projects without sessions still appear so they can be started from; a removed folder
 * (`hidden`) and its sessions do not. Pinned projects first, then in the chosen folder order:
 * manual (dragged; folders without a place yet go last, newest first), most recent activity, or
 * name. Chats inside a folder are always newest first.
 */
export function buildGroups(sessions: Record<string, SessionMeta>, projects: Project[], sort: FolderOrder = 'manual'): SidebarGroups {
  const byKey = new Map<string, ProjectGroup>();
  const hidden = new Set<string>();
  const ensure = (path: string) => {
    const key = pathKey(path);
    let g = byKey.get(key);
    if (!g) {
      g = { key, path, name: baseName(path) || path, pinned: false, last: 0, order: Infinity, sessions: [], archived: [], mix: undefined, attention: undefined };
      byKey.set(key, g);
    }
    return g;
  };

  for (const p of projects) {
    if (p.hidden) {
      hidden.add(pathKey(p.path));
      continue;
    }
    const g = ensure(p.path);
    g.path = p.path;
    g.name = p.name || g.name;
    g.pinned = !!p.pinned;
    g.last = Math.max(g.last, p.lastOpened);
    if (typeof p.order === 'number') g.order = p.order;
  }

  const pinned: SessionMeta[] = [];
  for (const s of Object.values(sessions)) {
    if (s.pinned && !s.archived) {
      pinned.push(s);
      continue;
    }
    if (hidden.has(pathKey(s.cwd))) continue;
    const g = ensure(s.cwd);
    if (s.archived) g.archived.push(s);
    else {
      g.sessions.push(s);
      g.last = Math.max(g.last, s.updatedAt);
    }
  }

  const recent = (a: SessionMeta, b: SessionMeta) => b.updatedAt - a.updatedAt;
  pinned.sort(recent);
  const list = [...byKey.values()];
  for (const g of list) {
    g.sessions.sort(recent);
    g.archived.sort(recent);
    if (!g.last) g.last = g.archived[0]?.updatedAt ?? 0;
    g.mix = mixOf(g.sessions);
    g.attention = attentionOf(g.sessions);
  }
  const within =
    sort === 'recent'
      ? (a: ProjectGroup, b: ProjectGroup) => b.last - a.last
      : sort === 'name'
        ? (a: ProjectGroup, b: ProjectGroup) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || b.last - a.last
        : (a: ProjectGroup, b: ProjectGroup) => (a.order === b.order ? b.last - a.last : a.order - b.order);
  list.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : within(a, b)));
  return { pinned, pinnedMix: mixOf(pinned), projects: list };
}

export const idsOf = (list: SessionMeta[]) => list.map((s) => s.id).join(' ');

/** Everything the list's structure shows: order, membership, names, marks. Rows show the rest themselves. */
export function groupsSignature(g: SidebarGroups): string {
  let sig = `P${g.pinnedMix ?? ''}:${idsOf(g.pinned)}`;
  for (const p of g.projects) sig += `\n${p.key}|${p.name}|${p.path}|${p.pinned ? 1 : 0}|${p.mix ?? ''}|${p.attention ?? ''}|${idsOf(p.sessions)}|${idsOf(p.archived)}`;
  return sig;
}

/**
 * The groups, as the same object until their structure changes. A session's activity, time or
 * usage ticking (several times a second while it streams) leaves the list alone: rows update
 * themselves. Rebuilt only when the sessions map or the projects change identity.
 */
export function createGroupsSelector() {
  let seenSessions: Record<string, SessionMeta> | undefined;
  let seenProjects: Project[] | undefined;
  let seenSort: FolderOrder | undefined;
  let sig = '';
  let groups: SidebarGroups = { pinned: [], pinnedMix: undefined, projects: [] };
  return (s: { sessions: Record<string, SessionMeta>; projects: Project[]; settings?: { folderOrder?: FolderOrder } }): SidebarGroups => {
    const sort = s.settings?.folderOrder ?? 'manual';
    if (s.sessions === seenSessions && s.projects === seenProjects && sort === seenSort) return groups;
    seenSessions = s.sessions;
    seenProjects = s.projects;
    seenSort = sort;
    const next = buildGroups(s.sessions, s.projects, sort);
    const nextSig = groupsSignature(next);
    if (nextSig !== sig) {
      sig = nextSig;
      groups = next;
    }
    return groups;
  };
}

// ── collapsed folders, remembered per machine ──

const COLLAPSED_KEY = 'sable.sidebar.collapsed.v1';

export function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

export function saveCollapsed(set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    /* private mode */
  }
}
