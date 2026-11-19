import type { IconName } from '@/icons';
import type { RailTab } from '@/state/store';

/**
 * The side panel's tabs, in the order of their shortcuts (Alt+1 to Alt+8). The panel's header shows
 * the first four (as many as fit); the rest, and any that do not fit, are in its More menu. Kept free
 * of the panel's own code, so the app shell and the palette can list them without loading it.
 */
export const RAIL_TABS: readonly { id: RailTab; label: string; icon: IconName; more?: boolean }[] = [
  { id: 'changes', label: 'Changes', icon: 'diff' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'browser', label: 'Browser', icon: 'globe' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', more: true },
  { id: 'context', label: 'Context', icon: 'context', more: true },
  { id: 'agents', label: 'Agents', icon: 'robot', more: true },
  { id: 'device', label: 'Device', icon: 'device', more: true },
];

/** The tab's shortcut, `alt+N`. */
export const railTabKeys = (id: RailTab): string => `alt+${RAIL_TABS.findIndex((t) => t.id === id) + 1}`;

/** The tab for Alt+`n` (1-based), if there is one. */
export const railTabAt = (n: number): RailTab | undefined => RAIL_TABS[n - 1]?.id;
