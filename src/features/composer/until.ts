import { bridge } from '@/lib/bridge';
import { useStore } from '@/state/store';

/** Until green from the composer: `/until <check>`, `/until off`, and the strip's Stop and Check now. */

const fail = (err: unknown) => useStore.getState().toast((err as Error)?.message ?? String(err), 'error');

/** What follows `/until`: arms the session's loop (replacing one already armed), or stops it with `off`. */
export async function untilCommand(sessionId: string, arg: string) {
  const s = useStore.getState();
  if (!arg.trim()) {
    s.toast('Add a check after /until, like /until pnpm test');
    return;
  }
  try {
    const r = await bridge.call('until.set', { sessionId, text: arg });
    if (r.error) s.toast(r.error);
    else if (!r.ok && /^(off|stop)$/i.test(arg.trim())) s.toast('No loop runs in this chat');
  } catch (err) {
    fail(err);
  }
}

export const stopUntil = (sessionId: string) => bridge.call('until.stop', { sessionId }).catch(fail);

export const checkUntilNow = (sessionId: string) => bridge.call('until.check', { sessionId }).catch(fail);
