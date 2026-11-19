import { useSyncExternalStore } from 'react';

/** Screens over home: a chat, or settings. Home stays mounted underneath (its scroll is kept). */
export type Route = { name: 'chat'; id: string } | { name: 'settings' };

let stack: Route[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

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
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const useNav = () => useSyncExternalStore(subscribe, () => stack);
