import { useSyncExternalStore } from 'react';
import type { ProjectScript, ProjectScripts } from '@shared/protocol';
import { bridge } from '@/lib/bridge';
import { useStore } from '@/state/store';
import { gitKey } from './git-state';
import { runScript } from './term-store';

/**
 * Each folder's scripts as the bridge read them (`project.scripts`), kept outside React for the
 * Terminal tab's Run control and the palette. Asked again whenever the list is about to be seen
 * (the tab shows, the menu or the palette opens, the window comes back, a turn or a command ends):
 * the bridge answers from a few stats when nothing changed, and the list re-renders only when the
 * files did (`sig`).
 */

const byCwd = new Map<string, ProjectScripts>();
const inflight = new Map<string, Promise<void>>();
const again = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export const getScripts = (cwd: string): ProjectScripts | undefined => (cwd ? byCwd.get(gitKey(cwd)) : undefined);

/** Reads the folder's scripts again; a call while one is under way runs once more after it. Never throws. */
export function refreshScripts(cwd: string): Promise<void> {
  if (!cwd) return Promise.resolve();
  const k = gitKey(cwd);
  const running = inflight.get(k);
  if (running) {
    again.add(k);
    return running;
  }
  const p = bridge
    .call('project.scripts', { cwd }, 15_000)
    .then((next) => {
      if (byCwd.get(k)?.sig === next.sig) return;
      byCwd.set(k, next);
      emit();
    })
    .catch(() => {
      /* the list keeps what it had */
    })
    .finally(() => {
      inflight.delete(k);
      if (again.delete(k)) void refreshScripts(cwd);
    });
  inflight.set(k, p);
  return p;
}

/** The folder's scripts, re-rendering the caller when they change. */
export function useScripts(cwd: string): ProjectScripts | undefined {
  useSyncExternalStore(subscribe, () => version);
  return getScripts(cwd);
}

/** For the palette: re-renders when any folder's list changes (its items are built from `getScripts`). */
export function useScriptsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** A typed command that is one of the folder's scripts ("pnpm run dev", "pnpm dev", "make test"), so its run carries the script's name. */
export function scriptForCommand(list: ProjectScripts | undefined, command: string): ProjectScript | undefined {
  if (!list) return undefined;
  const norm = command.trim().replace(/\s+/g, ' ');
  return list.scripts.find((s) => {
    if (s.run === norm) return true;
    if (s.source !== 'package' || !list.manager) return false;
    const word = s.run.slice(`${list.manager} run `.length);
    // pnpm, yarn and bun run a script without "run"; npm only its own start and test.
    if (list.manager !== 'npm') return norm === `${list.manager} ${word}`;
    return (s.name === 'start' || s.name === 'test') && norm === `npm ${s.name}`;
  });
}

/** Runs a script in a session's Terminal tab, bringing the panel to it (the palette's "Run dev"). */
export function runScriptInPanel(sessionId: string, cwd: string, script: ProjectScript) {
  const st = useStore.getState();
  st.setUi({ railOpen: true, railTab: 'terminal' });
  runScript(sessionId, cwd, script);
}
