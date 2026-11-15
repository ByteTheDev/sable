import { memo, useState } from 'react';
import type { UserItem } from '@shared/protocol';
import { CopyButton } from '@/components/CopyButton';
import { Icon } from '@/icons';
import { formatBytes } from '@/lib/format';
import { rewindTo } from '@/state/actions';
import { useStore } from '@/state/store';
import { IconButton, Popover, PopoverClose, PopoverContent, PopoverTrigger, Switch } from '@/ui';
import { useTimeline } from './ctx';
import { Stamp } from './Stamp';

const LONG_CHARS = 1400;
const LONG_LINES = 18;

/** The person's message: an ink card on the right, with its time, copy and rewind on hover. */
export const UserMessage = memo(function UserMessage({ item }: { item: UserItem }) {
  const { sessionId } = useTimeline();
  const canRewind = useStore((s) => !!s.data[sessionId]?.caps?.features.rewind);
  const idle = useStore((s) => {
    const st = s.sessions[sessionId]?.status;
    return st === 'idle' || st === 'error';
  });
  const [open, setOpen] = useState(false);
  const [restore, setRestore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const queued = item.state === 'queued';
  const images = item.attachments?.filter((a) => a.kind === 'image' && a.dataUrl) ?? [];
  const files = item.attachments?.filter((a) => !(a.kind === 'image' && a.dataUrl)) ?? [];
  const long = item.text.length > LONG_CHARS || item.text.split('\n').length > LONG_LINES;

  const rewind = async () => {
    setBusy(true);
    const ok = await rewindTo(sessionId, item.id, restore);
    setBusy(false);
    if (ok) setOpen(false);
  };

  return (
    <div className="user" data-queued={queued || undefined} data-open={open || undefined} data-steered={item.steered || undefined}>
      <div className="user-actions">
        {!queued && <Stamp ts={item.ts} prefix={item.steered ? 'Steered' : undefined} className="user-stamp" />}
        {item.text && <CopyButton text={item.text} label="Copy message" />}
        {canRewind && idle && !queued && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <IconButton icon="rewind" label="Rewind to here" size={14} tipSide="top" />
            </PopoverTrigger>
            <PopoverContent align="end" side="bottom" width={288} className="pop-pad rewind">
              <div className="rewind-title">Rewind to here</div>
              <p className="rewind-desc">The conversation goes back to just before this message. Everything after it is removed.</p>
              <label className="rewind-opt">
                <span className="grow">
                  <span className="rewind-opt-name">Restore files</span>
                  <span className="rewind-opt-hint">Undo edits made after this point</span>
                </span>
                <Switch checked={restore} onChange={setRestore} label="Restore files" />
              </label>
              <div className="rewind-foot">
                <PopoverClose asChild>
                  <button type="button" className="btn btn-sm btn-ghost">
                    Cancel
                  </button>
                </PopoverClose>
                <button type="button" className="btn btn-sm" onClick={rewind} disabled={busy}>
                  <Icon name="rewind" size={13} />
                  Rewind
                </button>
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
      {item.steered ? (
        // Steered into a running turn: marked in place, answered right below.
        <span className="user-mark" data-waiting={queued || undefined}>
          <Icon name="enter" size={11} />
          {queued ? 'Steered, not taken yet' : 'Steered'}
        </span>
      ) : (
        queued && (
          <span className="user-mark" data-waiting>
            <Icon name="queue" size={11} />
            Queued
          </span>
        )
      )}
      <div className="user-card" data-spot>
        {images.length > 0 && (
          <div className="user-images">
            {images.map((a) => (
              <a key={a.id} className="user-thumb" href={a.dataUrl} target="_blank" rel="noopener noreferrer" title={a.name}>
                <img src={a.dataUrl} alt={a.name} loading="lazy" />
              </a>
            ))}
          </div>
        )}
        {item.text && (
          <div className="user-text" data-clipped={(long && !expanded) || undefined}>
            {item.text}
          </div>
        )}
        {long && (
          <button type="button" className="user-more" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        {files.length > 0 && (
          <div className="user-files">
            {files.map((a) => (
              <span key={a.id} className="user-file" title={a.path ?? a.name}>
                <Icon name={a.kind === 'image' ? 'image' : a.kind === 'text' ? 'clipboard' : 'file-text'} size={14} />
                <span className="truncate">{a.name}</span>
                {a.size != null && <span className="user-file-size">{formatBytes(a.size)}</span>}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
