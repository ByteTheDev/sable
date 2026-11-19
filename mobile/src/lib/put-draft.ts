/**
 * Words put into a chat's composer from elsewhere in the chat (a check's findings: "Fix these"),
 * never sent by themselves. The composer of that chat takes them and focuses its field.
 */
const listeners = new Map<string, (text: string) => void>();

export function putDraft(sid: string, text: string) {
  listeners.get(sid)?.(text);
}

export function onPutDraft(sid: string, fn: (text: string) => void) {
  listeners.set(sid, fn);
  return () => {
    if (listeners.get(sid) === fn) listeners.delete(sid);
  };
}
