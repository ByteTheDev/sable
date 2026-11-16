import { useState } from 'react';
import type { UserItem } from '@shared/protocol';
import { rewindTo, sendMessage } from '@/state/actions';
import { useStore } from '@/state/store';
import { IconButton, Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/ui';
import { useTimeline } from './ctx';

/** Whether this is the last message of yours that the agent has taken. */
function useIsLast(sessionId: string, id: string): boolean {
  return useStore((s) => {
    const data = s.data[sessionId];
    if (!data) return false;
    for (let i = data.roots.length - 1; i >= 0; i--) {
      const it = data.items[data.roots[i]];
      if (it?.type === 'user' && it.state !== 'queued') return it.id === id;
    }
    return false;
  });
}

/**
 * Two things people do with a message all day, beside copy and rewind (hover tools of a message):
 * - Edit and send again: the conversation goes back to before the message and its text returns to
 *   the composer. One click on your last message; an older one asks first, since everything after
 *   it goes.
 * - Retry, on your last message: the same message is sent again in place of the answer.
 * Both use the existing rewind and leave files as they are.
 */
export function MessageAgain({ item }: { item: UserItem }) {
  const { sessionId } = useTimeline();
  const canRewind = useStore((s) => !!s.data[sessionId]?.caps?.features.rewind);
  const idle = useStore((s) => {
    const st = s.sessions[sessionId]?.status;
    return st === 'idle' || st === 'error';
  });
  const last = useIsLast(sessionId, item.id);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!canRewind || !idle || item.state === 'queued' || !item.text) return null;

  const edit = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await rewindTo(sessionId, item.id, false);
    setBusy(false);
    if (!ok) return;
    setOpen(false);
    const st = useStore.getState();
    // Something already typed is kept under the message, not replaced by it.
    const typed = st.drafts[sessionId]?.text.trim() ? `\n\n${st.drafts[sessionId]?.text}` : '';
    st.setDraft(sessionId, { text: item.text + typed, attachments: [...(item.attachments ?? []), ...(st.drafts[sessionId]?.attachments ?? [])] });
    requestAnimationFrame(() => {
      const field = document.querySelector<HTMLTextAreaElement>('.dock textarea');
      field?.focus();
      field?.setSelectionRange(item.text.length, item.text.length);
    });
  };

  const retry = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await rewindTo(sessionId, item.id, false);
    if (ok) await sendMessage(sessionId, item.text, item.attachments ?? []);
    setBusy(false);
  };

  return (
    <>
      {last ? (
        <IconButton icon="pencil" label="Edit and send again" size={14} tipSide="top" disabled={busy} onClick={edit} />
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <IconButton icon="pencil" label="Edit and send again" size={14} tipSide="top" />
          </PopoverTrigger>
          <PopoverContent align="end" side="bottom" width={288} className="pop-pad rewind">
            <div className="rewind-title">Edit and send again</div>
            <p className="rewind-desc">The message returns to the composer. Everything after it is removed from the conversation.</p>
            <div className="rewind-foot">
              <PopoverClose asChild>
                <button type="button" className="btn btn-sm btn-ghost">
                  Cancel
                </button>
              </PopoverClose>
              <button type="button" className="btn btn-sm" onClick={edit} disabled={busy}>
                Rewind and edit
              </button>
            </div>
          </PopoverContent>
        </Popover>
      )}
      {last && <IconButton icon="reload" label="Retry" size={14} tipSide="top" disabled={busy} onClick={retry} />}
    </>
  );
}
