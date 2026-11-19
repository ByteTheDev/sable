import { useSyncExternalStore } from 'react';

/** Screens over home: a chat, or settings. Home stays mounted underneath (its scroll is kept). */
export type Route = { name: 'chat'; id: string } | { name: 'settings' };

// The open screens survive Android closing the app in the background: the next start opens them again.
const KEY = 'sable.nav';
const load = (): Route[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Route[];
    return Array.isArray(v) ? v.filter((r) => r && (r.name === 'settings' || (r.name === 'chat' && typeof r.id === 'string'))).slice(-3) : [];
  } catch {
    return [];
  }
};

let stack: Route[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(stack));
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l());
};

export const nav = {
  get stack() {
    return stack;
  },
  push(r: Route) {
    const top = stack[stack.length - 1];
    if (top && top.name === r.name && (r.name !== 'chat' || (top as { id: string }).id === r.id)) return;
    stack = [...stack.filter((x) => !(x.name === r.name && (r.name !== 'chat' || (x as { id: string }).id === (r as { id: string }).id))), r];
    emit();
  },
  /** Opens a chat on top of home (replacing any other open chat). */
  chat(id: string) {
    stack = [...stack.filter((x) => x.name !== 'chat'), { name: 'chat', id }];
    emit();
  },
  pop(): boolean {
    if (!stack.length) return false;
    stack = stack.slice(0, -1);
    emit();
    return true;
  },
  reset() {
    stack = [];
    emit();
  },
  /** Puts back what was open when the app last ran (once, at start). */
  restore() {
    if (stack.length) return;
    const saved = load();
    if (!saved.length) return;
    stack = saved;
    listeners.forEach((l) => l());
  },
  /** Drops chats the desktop no longer has. */
  prune(exists: (id: string) => boolean) {
    const next = stack.filter((r) => r.name !== 'chat' || exists(r.id));
    if (next.length !== stack.length) {
      stack = next;
      emit();
    }
  },
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const useNav = () => useSyncExternalStore(subscribe, () => stack);
