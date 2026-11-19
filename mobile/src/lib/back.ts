/**
 * Android's back button: the newest handler that takes it wins (an open sheet, then a screen).
 * `pushBack` returns its own removal.
 */
const stack: (() => boolean)[] = [];

export function pushBack(fn: () => boolean) {
  stack.push(fn);
  return () => {
    const i = stack.lastIndexOf(fn);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Runs the newest handler; false when nothing took it (the app goes to the background). */
export function goBack(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]()) return true;
  return false;
}
