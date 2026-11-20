/**
 * A file by its kind, for the cards of files the agent hands over: a page with a folded corner (a
 * hair of light on its fold) and the kind's emblem on it, drawn as one family in the ink and ivory of
 * the app (no colour, no letters). 40 x 48, drawn at the size asked.
 */
export type FileKind = 'apk' | 'image' | 'archive' | 'pdf' | 'text' | 'code' | 'video' | 'audio' | 'data' | 'file';

const CODE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'cs', 'rb', 'php', 'sh', 'ps1', 'html', 'css', 'scss', 'vue', 'svelte', 'sql', 'lua', 'dart']);
const DATA = new Set(['json', 'yml', 'yaml', 'toml', 'xml', 'csv', 'tsv', 'ini', 'env', 'lock']);

export function kindOfFile(name: string): FileKind {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (ext === 'apk' || ext === 'aab' || ext === 'xapk') return 'apk';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'avif', 'bmp', 'ico'].includes(ext)) return 'image';
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'xz', 'bz2', 'zst'].includes(ext)) return 'archive';
  if (ext === 'pdf') return 'pdf';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'].includes(ext)) return 'audio';
  if (CODE.has(ext)) return 'code';
  if (DATA.has(ext)) return 'data';
  if (['md', 'mdx', 'txt', 'log', 'rtf', 'doc', 'docx'].includes(ext)) return 'text';
  return 'file';
}

/** What a person calls the kind, for the line under the name. */
export function kindName(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const k = kindOfFile(name);
  if (k === 'apk') return 'Android app';
  if (k === 'pdf') return 'PDF document';
  if (k === 'archive') return `${ext.toUpperCase()} archive`;
  if (k === 'image') return `${ext === 'jpg' ? 'JPEG' : ext.toUpperCase()} image`;
  if (k === 'video') return 'Video';
  if (k === 'audio') return 'Audio';
  if (ext === 'md' || ext === 'mdx') return 'Markdown';
  if (k === 'text') return 'Text';
  if (k === 'data') return ext.toUpperCase();
  if (k === 'code') return ext === 'ts' || ext === 'tsx' ? 'TypeScript' : ext === 'js' || ext === 'jsx' || ext === 'mjs' ? 'JavaScript' : ext === 'py' ? 'Python' : 'Source';
  return ext ? ext.toUpperCase() : 'File';
}

const EMBLEM: Record<FileKind, React.ReactNode> = {
  apk: (
    <>
      <path d="M12.6 34.6a7.4 7.4 0 0 1 14.8 0Z" fill="currentColor" fillOpacity="0.16" />
      <path d="M12.6 34.6a7.4 7.4 0 0 1 14.8 0Z" />
      <path d="M15 26.4l-1.7-2.5M25 26.4l1.7-2.5" />
      <circle cx="16.9" cy="31.2" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="23.1" cy="31.2" r="1.05" fill="currentColor" stroke="none" />
    </>
  ),
  image: (
    <>
      <circle cx="25.4" cy="23.6" r="2.4" fill="currentColor" fillOpacity="0.16" />
      <path d="M10.5 37.5l6.4-7.2 4.4 4.6 2.9-3 5.3 5.6" />
    </>
  ),
  archive: (
    <>
      <path d="M18.6 6.5h2.8M20.6 10h2.8M18.6 13.5h2.8M20.6 17h2.8M18.6 20.5h2.8" />
      <rect x="16.5" y="25" width="7" height="11.5" rx="2.2" fill="currentColor" fillOpacity="0.16" />
      <path d="M20 29.2v3.6" />
    </>
  ),
  pdf: (
    <>
      <rect x="11" y="18" width="9" height="6" rx="1.4" fill="currentColor" fillOpacity="0.16" />
      <path d="M11 29h18M11 33.2h18M11 37.4h11" />
    </>
  ),
  text: <path d="M11 21.5h13M11 25.8h18M11 30.1h18M11 34.4h18M11 38.7h9" />,
  code: <path d="M15.6 27.6l-4.1 4.1 4.1 4.1M24.4 27.6l4.1 4.1-4.1 4.1M21.6 25.6l-3.2 12.2" />,
  video: (
    <>
      <rect x="10.5" y="23" width="19" height="14" rx="3" />
      <path d="M18.2 27.3v5.4l4.6-2.7Z" fill="currentColor" stroke="none" />
    </>
  ),
  audio: <path d="M11.5 30v2M15.2 26.5v9M18.9 23.5v15M22.6 27v8M26.3 25v12M30 29.5v3" />,
  data: (
    <>
      <path d="M15.5 22.5c-2 0-2.6.9-2.6 2.4v2.4c0 1.3-.7 2.2-2 2.2 1.3 0 2 .9 2 2.2v2.4c0 1.5.6 2.4 2.6 2.4" />
      <path d="M24.5 22.5c2 0 2.6.9 2.6 2.4v2.4c0 1.3.7 2.2 2 2.2-1.3 0-2 .9-2 2.2v2.4c0 1.5-.6 2.4-2.6 2.4" />
    </>
  ),
  file: <path d="M11 30.5h18M11 34.8h12" />,
};

export function FileGlyph({ name, size = 36 }: { name: string; size?: number }) {
  const k = kindOfFile(name);
  return (
    <svg className="file-glyph" data-kind={k} width={size} height={(size * 48) / 40} viewBox="0 0 40 48" fill="none" aria-hidden>
      <path className="file-page" d="M9 3H25.5L35 12.5V41A4 4 0 0 1 31 45H9A4 4 0 0 1 5 41V7A4 4 0 0 1 9 3Z" />
      <path className="file-fold" d="M25.5 3V9.5A3 3 0 0 0 28.5 12.5H35Z" />
      <g className="file-emblem" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {EMBLEM[k]}
      </g>
    </svg>
  );
}
