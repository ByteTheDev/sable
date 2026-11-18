import { createContext, useContext, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { bridge } from '@/lib/bridge';
import { fileCandidates } from '@/lib/file-words';
import { openInBrowserTab } from '@/lib/links';
import { useStore } from '@/state/store';

/**
 * Files named in an answer, made clickable. Once an answer has settled, its file-like words
 * (`src/app.ts`, `Rangefinder-Cinematic.mp4`) are checked against the session's folder in one
 * bridge call; the ones that exist render as links (see `components/Markdown.tsx`):
 * - click: a page, image, video, audio file or PDF opens in the Browser tab, anything else in the
 *   side panel's file preview;
 * - Ctrl/Cmd+click: the system's default app;
 * - Ctrl/Cmd+Shift+click: shown in the file manager.
 */

export interface FileLinks {
  /** Word as written → absolute path. */
  files: Record<string, string>;
  cwd: string;
}

const Ctx = createContext<FileLinks | null>(null);
export const FileLinksProvider = ({ value, children }: { value: FileLinks | null; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export const useFileLinks = () => useContext(Ctx);

const cache = new Map<string, Record<string, string>>();
const CACHE_MAX = 300;

/** The files a settled answer names, resolved once per text and folder. */
export function useResolvedFiles(text: string, cwd: string | undefined, enabled: boolean): FileLinks | null {
  const key = cwd ? `${cwd}\n${text}` : '';
  const [files, setFiles] = useState<Record<string, string> | null>(() => (key ? (cache.get(key) ?? null) : null));
  useEffect(() => {
    if (!enabled || !cwd) return;
    const hit = cache.get(key);
    if (hit) return void setFiles(hit);
    const names = fileCandidates(text);
    if (!names.length) return;
    let live = true;
    bridge
      .call('fs.resolve', { cwd, names })
      .then((found) => {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.set(key, found);
        if (live) setFiles(found);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return enabled && cwd && files && Object.keys(files).length ? { files, cwd } : null;
}

const BROWSER_VIEW = /\.(html?|svg|png|jpe?g|gif|webp|avif|ico|mp4|m4v|webm|mov|mp3|wav|ogg|m4a|flac|pdf)$/i;

const fail = (err: unknown) => useStore.getState().toast((err as Error)?.message ?? String(err), 'error');

/** What a click on a file link does (see the module comment). */
export function openFileLink(e: MouseEvent, file: string, cwd: string) {
  e.preventDefault();
  e.stopPropagation();
  const mod = e.ctrlKey || e.metaKey;
  if (mod) return void bridge.call('fs.open', { path: file, reveal: e.shiftKey }).catch(fail);
  if (BROWSER_VIEW.test(file)) {
    void bridge
      .call('fs.share', { path: file, root: cwd })
      .then(({ url }) => {
        if (!openInBrowserTab(url)) window.open(url, '_blank', 'noopener,noreferrer');
      })
      .catch(fail);
    return;
  }
  useStore.getState().setUi({ railOpen: true, railTab: 'files', railFile: file });
}

/** A file named in prose: the word as written, clickable when it is a real file. */
export function FileWord({ word, children, code }: { word: string; children: ReactNode; code?: boolean }) {
  const links = useFileLinks();
  const file = links?.files[word];
  if (!file || !links) return code ? <code className="md-code">{children}</code> : <>{children}</>;
  return (
    <a
      className={code ? 'md-code md-file' : 'md-link md-file'}
      href={`file:///${file.replace(/\\/g, '/')}`}
      title={file}
      onClick={(e) => openFileLink(e, file, links.cwd)}
      onAuxClick={(e) => e.preventDefault()}
    >
      {children}
    </a>
  );
}

/** Plain prose with the files it names made clickable (unchanged when none are known). */
export function FileProse({ text }: { text: string }) {
  const links = useFileLinks();
  if (!links) return <>{text}</>;
  const words = Object.keys(links.files).filter((w) => text.includes(w));
  if (!words.length) return <>{text}</>;
  // Longest first, so `src/app.ts` wins over `app.ts`.
  const re = new RegExp(words.sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    const before = text[m.index - 1];
    const after = text[m.index + m[0].length];
    // Whole words only (not the end of a longer path).
    if ((before && /[\w/\\.-]/.test(before)) || (after && /[\w/\\-]/.test(after))) continue;
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push(
      <FileWord key={m.index} word={m[0]}>
        {m[0]}
      </FileWord>,
    );
    at = m.index + m[0].length;
  }
  if (!out.length) return <>{text}</>;
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
