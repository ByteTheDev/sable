import { createSession, homeChoice, spareSend } from '@/state/actions';
import { useStore } from '@/state/store';

/**
 * `/spare <message>`: the message waits in the chat's queue and starts by itself when an account of
 * its agent has weekly quota that would otherwise go unused (server/core/spare.ts). From home it
 * starts a new chat with the home choices, which then waits.
 */
export async function spareCommand(sessionId: string | null, arg: string) {
  const s = useStore.getState();
  const text = arg.trim();
  if (!text) {
    s.toast('Add a message after /spare');
    return;
  }
  let id = sessionId;
  if (!id) {
    const choice = homeChoice();
    if (!choice) {
      s.setUi({ projectPicker: true });
      return;
    }
    const made = await createSession(choice.chat ? { ...choice, chat: { text } } : choice);
    if (!made) return;
    id = made.id;
  }
  await spareSend(id, text);
}
