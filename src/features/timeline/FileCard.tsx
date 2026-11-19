import { memo } from 'react';
import type { SharedFile, ToolItem } from '@shared/protocol';
import { CopyButton } from '@/components/CopyButton';
import { Markdown } from '@/components/Markdown';
import { fileIcon } from '@/features/composer/file-icon';
import { Icon } from '@/icons';
import { bridge } from '@/lib/bridge';
import { formatBytes, relPath } from '@/lib/format';
import { useStore } from '@/state/store';
import { IconButton, PathLabel } from '@/ui';
import { useTimeline } from './ctx';
import { isActive } from './util';
import './files.css';

/** Opens a file with the system's app for it, or shows it in the file manager. */
function openFile(path: string, reveal = false) {
  bridge.call('fs.open', { path, reveal }).catch((err: unknown) => useStore.getState().toast((err as Error)?.message ?? String(err), 'error'));
}

/** Where a file lies, as the card names it: relative to the session's folder, the folder's own name when it lies right there. */
export function folderOf(file: string, cwd: string, home: string): string {
  const norm = file.replace(/\\/g, '/');
  const dir = norm.slice(0, Math.max(0, norm.lastIndexOf('/')));
  if (!dir) return '';
  const rel = relPath(dir, cwd || null, home || null);
  if (rel !== '.') return rel;
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return root.slice(root.lastIndexOf('/') + 1) || rel;
}

/**
 * Files the agent hands over (Claude Code's SendUserFile), always in view like a widget: its caption
 * as a quiet line, then one card per file. The card is the button that opens the file with its app;
 * Show in folder and Copy path sit at its end.
 */
export const FileShare = memo(function FileShare({ item }: { item: ToolItem }) {
  const files = item.detail.files ?? [];
  const caption = item.detail.caption?.trim();
  const failed = item.status === 'error';
  if (!files.length) {
    // The call is still arriving: one card's room, so nothing jumps when the files are named.
    return isActive(item) ? (
      <div className="fshare">
        <div className="fcard fcard-wait" aria-busy>
          <span className="fcard-tile skel" />
          <span className="fcard-text">
            <span className="fcard-name shimmer">Sharing files</span>
          </span>
        </div>
      </div>
    ) : null;
  }
  return (
    <div className="fshare">
      {caption && <Markdown text={caption} className="fshare-caption" />}
      <div className="fshare-list" role="list" aria-label={files.length === 1 ? 'Shared file' : 'Shared files'}>
        {files.map((f, i) => (
          <FileCard key={`${i}:${f.path}`} file={f} failed={failed} />
        ))}
      </div>
    </div>
  );
});

/**
 * One file as a large button: its kind, its name, where it lies and its size. A click anywhere on
 * it opens the file with its app (Open is the same for the keyboard); Show in folder and Copy path
 * come forward on hover or focus, beside Open.
 */
const FileCard = memo(function FileCard({ file, failed }: { file: SharedFile; failed: boolean }) {
  const { cwd, home } = useTimeline();
  const folder = folderOf(file.path, cwd, home);
  const size = formatBytes(file.size);
  return (
    <div
      className="fcard"
      role="listitem"
      data-spot
      data-failed={failed || undefined}
      // The whole card opens the file for the pointer; its buttons do their own thing.
      onClick={(e) => !(e.target as HTMLElement).closest('button') && openFile(file.path)}
    >
      <span className="fcard-tile" aria-hidden>
        <Icon name={fileIcon(file.name)} size={20} />
      </span>
      <span className="fcard-text">
        <span className="fcard-name truncate" title={file.path}>
          {file.name}
        </span>
        <span className="fcard-meta">
          {folder && <PathLabel path={folder} className="fcard-folder" />}
          {size && <span className="fcard-size num">{size}</span>}
          {failed && <span className="fcard-fail">Not shared</span>}
        </span>
      </span>
      <span className="fcard-acts">
        <IconButton icon="folder-open" label="Show in folder" size={15} tipSide="top" className="fcard-act" onClick={() => openFile(file.path, true)} />
        <CopyButton text={file.path} label="Copy path" size={15} className="fcard-act" />
      </span>
      <button type="button" className="fcard-open" onClick={() => openFile(file.path)} aria-label={`Open ${file.name}`}>
        Open
      </button>
    </div>
  );
});
