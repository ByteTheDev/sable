import { memo, useEffect, useState } from 'react';
import type { SharedFile, ToolItem } from '@shared/protocol';
import { CopyButton } from '@/components/CopyButton';
import { Markdown } from '@/components/Markdown';
import { fileIcon } from '@/features/composer/file-icon';
import { Icon } from '@/icons';
import { bridge } from '@/lib/bridge';
import { formatBytes, relPath } from '@/lib/format';
import { useStore } from '@/state/store';
import { IconButton } from '@/ui';
import { useTimeline } from './ctx';
import { coverWord, sheetOf, wantsText, type Sheet } from './file-sheet';
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
 * as a quiet line, then one card per file, side by side.
 */
export const FileShare = memo(function FileShare({ item }: { item: ToolItem }) {
  const files = item.detail.files ?? [];
  const caption = item.detail.caption?.trim();
  const failed = item.status === 'error';
  if (!files.length) {
    // The call is still arriving: one card's room, so nothing jumps when the files are named.
    return isActive(item) ? (
      <div className="fshare">
        <div className="fshare-list">
          <div className="fcard fcard-wait" aria-busy>
            <span className="fcard-stage" aria-hidden>
              <span className="fcard-sheet">
                <span className="fcard-cover">
                  <span className="fcard-wait-line skel" style={{ width: '46%' }} />
                  <span className="fcard-wait-line skel" style={{ width: '78%' }} />
                  <span className="fcard-wait-line skel" style={{ width: '62%' }} />
                </span>
                <i className="fcard-fold" />
              </span>
            </span>
            <span className="fcard-foot">
              <span className="fcard-open">
                <span className="fcard-name shimmer">Sharing files</span>
              </span>
              <span className="fcard-meta">&nbsp;</span>
            </span>
          </div>
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

// ── the sheet: what the file's first page looks like ──

/** Sheets read so far, by path and size (a file handed over again with the same size is the same page). */
const sheets = new Map<string, Sheet>();
const SHEETS_MAX = 120;

/**
 * The page a card shows: for a text file its real first lines (read once, a couple of kilobytes),
 * a table for CSV, the drawing itself for an SVG; for anything else a cover with its kind.
 * The cover shows at once and the page fades in over it, so the card never changes size.
 */
function useSheet(file: SharedFile, skip: boolean): Sheet | null {
  const key = `${file.path}\n${file.size ?? ''}`;
  const want = !skip && wantsText(file.name, file.size);
  const [sheet, setSheet] = useState<Sheet | null>(() => sheets.get(key) ?? null);
  useEffect(() => {
    if (!want || sheets.has(key)) return;
    let live = true;
    bridge
      .call('fs.read', { path: file.path, maxBytes: want })
      .then((r) => {
        const s = sheetOf(file.name, r.binary ? '' : r.content, r.truncated);
        if (sheets.size >= SHEETS_MAX) sheets.delete(sheets.keys().next().value!);
        sheets.set(key, s);
        if (live) setSheet(s);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, want]); // eslint-disable-line react-hooks/exhaustive-deps
  return want ? sheet : null;
}

const Page = memo(function Page({ sheet }: { sheet: Sheet }) {
  if (sheet.kind === 'table') {
    return (
      <span className="fcard-page fcard-table">
        {sheet.rows.map((row, r) => (
          <span key={r} className="fcard-tr">
            {row.map((cell, c) => (
              <span key={c} className="fcard-td">
                {cell}
              </span>
            ))}
          </span>
        ))}
      </span>
    );
  }
  if (sheet.kind === 'image') return <img className="fcard-page fcard-img" src={sheet.src} alt="" draggable={false} decoding="async" />;
  if (sheet.kind === 'text') {
    return (
      <span className="fcard-page fcard-lines">
        {sheet.lines.map((l, i) => (
          <span key={i} className="fcard-line" data-head={l.head || undefined}>
            {l.text || ' '}
          </span>
        ))}
      </span>
    );
  }
  return null;
});

/**
 * One file as a card: a sheet of it in a small well (its first lines where it is text, a cover
 * with its kind otherwise), its name, its size and where it lies. The whole card opens the file
 * with its app; Show in folder and Copy path come forward on hover or focus.
 */
const FileCard = memo(function FileCard({ file, failed }: { file: SharedFile; failed: boolean }) {
  const { cwd, home } = useTimeline();
  const where = folderOf(file.path, cwd, home);
  // The folder by its own name (the whole path is the card's tooltip, and Show in folder goes there).
  const folder = where.slice(where.replace(/\/+$/, '').lastIndexOf('/') + 1);
  const size = formatBytes(file.size);
  const sheet = useSheet(file, failed);
  const page = sheet && sheet.kind !== 'cover' ? sheet : null;
  return (
    <div className="fcard" role="listitem" data-spot data-failed={failed || undefined}>
      <span className="fcard-stage" aria-hidden>
        <span className="fcard-sheet">
          {page ? (
            <Page sheet={page} />
          ) : (
            <span className="fcard-cover">
              <span className="fcard-ext">{coverWord(file.name)}</span>
              <span className="fcard-rule" />
              <span className="fcard-rule" />
              <span className="fcard-rule" />
            </span>
          )}
          <i className="fcard-fold" />
        </span>
      </span>
      <span className="fcard-foot">
        {/* The one button that opens the file: it covers the card, so a click anywhere on it opens. */}
        <button type="button" className="fcard-open" onClick={() => openFile(file.path)} aria-label={`Open ${file.name}`} title={file.path}>
          <Icon name={fileIcon(file.name)} size={15} className="fcard-kind" />
          <span className="fcard-name truncate">{file.name}</span>
        </button>
        <span className="fcard-meta">
          {size && <span className="fcard-size num">{size}</span>}
          {folder && <span className="fcard-folder truncate">{folder}</span>}
          {failed && <span className="fcard-fail">Not shared</span>}
        </span>
      </span>
      <span className="fcard-acts">
        <IconButton icon="folder-open" label="Show in folder" size={14} tipSide="top" className="fcard-act" onClick={() => openFile(file.path, true)} />
        <CopyButton text={file.path} label="Copy path" size={14} className="fcard-act" />
      </span>
    </div>
  );
});
