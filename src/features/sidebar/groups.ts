import type { Project, SessionMeta } from '@shared/protocol';
import { baseName } from '@/lib/format';

/** Case- and slash-insensitive key for a folder path. */
export const pathKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export interface ProjectGroup {
  key: string;
  path: string;
  name: string;
  pinned: boolean;
  /** Most recent activity in the group, for sorting. */
  last: number;
  sessions: SessionMeta[];
  archived: SessionMeta[];
}

export interface SidebarGroups {
  pinned: SessionMeta[];
  projects: ProjectGroup[];
}

/**
 * Pinned sessions float to their own group; everything else is grouped by folder.
 * Known projects without sessions still appear so they can be started from.
 * Pinned projects first, then by most recent activity.
 */
export function buildGroups(sessions: Record<string, SessionMeta>, projects: Project[]): SidebarGroups {
  const byKey = new Map<string, ProjectGroup>();
  const ensure = (path: string) => {
    const key = pathKey(path);
    let g = byKey.get(key);
    if (!g) {
      g = { key, path, name: baseName(path) || path, pinned: false, last: 0, sessions: [], archived: [] };
      byKey.set(key, g);
    }
    return g;
  };

  for (const p of projects) {
    const g = ensure(p.path);
    g.path = p.path;
    g.name = p.name || g.name;
    g.pinned = !!p.pinned;
    g.last = Math.max(g.last, p.lastOpened);
  }

  const pinned: SessionMeta[] = [];
  for (const s of Object.values(sessions)) {
    if (s.pinned && !s.archived) {
      pinned.push(s);
      continue;
    }
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
  }
  list.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.last - a.last));
  return { pinned, projects: list };
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
