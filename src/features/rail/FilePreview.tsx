import { useEffect, useRef, useState } from 'react';
import { CodeBlock } from '@/components/CodeBlock';
import { CopyButton } from '@/components/CopyButton';
import { Markdown } from '@/components/Markdown';
import { Icon } from '@/icons';
import { bridge } from '@/lib/bridge';
import { formatBytes, langFromPath, relPath } from '@/lib/format';
import { focusComposer } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton, Segmented, Spinner } from '@/ui';
import { StatusLetter } from './ChangesTab';
import { isImagePath } from './util';

type Loaded = { content: string; truncated: boolean; size: number; binary: boolean };

const MAX_READ = 512 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;

/** A read-only look at one file inside the panel: code with colours, markdown rendered, small images shown. */
export function FilePreview({ path, cwd, status, onBack }: { path: string; cwd: string; status?: string; onBack: () => void }) {
  const home = useStore((s) => s.home);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mdView, setMdView] = useState<'rendered' | 'source'>('rendered');
  const rootRef = useRef<HTMLDivElement>(null);
  const rel = relPath(path, cwd, home);
  const lang = langFromPath(path);
  const image = isImagePath(path);
  const svg = /\.svg$/i.test(path);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    bridge
      .call('fs.read', { path, maxBytes: MAX_READ })
      .then((r) => live && setData(r))
      .catch((err: Error) => live && setError(err.message || String(err)));
    return () => {
      live = false;
    };
  }, [path]);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const segments = rel.split('/');

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="rail-col fp"
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'ArrowLeft' && e.altKey)) {
          e.preventDefault();
          e.stopPropagation();
          onBack();
        }
      }}
    >
      <div className="rail-bar rail-bar-field fp-head">
        <IconButton icon="arrow-left" label="Back to files" size={14} onClick={onBack} />
        <nav className="fp-crumbs" aria-label="Path">
          {segments.map((seg, i) => (
            <span key={i} className={i === segments.length - 1 ? 'fp-crumb fp-crumb-last' : 'fp-crumb'}>
              {seg}
            </span>
          ))}
        </nav>
        {status && <StatusLetter status={status} small />}
      </div>
      <div className="fp-actions">
        <button type="button" className="btn btn-sm" onClick={() => focusComposer('@' + relPath(path, cwd) + ' ', { append: true })}>
          <Icon name="at" size={14} />
          Mention in chat
        </button>
        <CopyButton text={path} label="Copy path" size={14} tipSide="bottom" />
        <span className="grow" />
        {data && !data.binary && lang === 'markdown' && (
          <Segmented
            id="fp-md"
            value={mdView}
            onChange={setMdView}
            options={[
              { value: 'rendered', label: 'Preview' },
              { value: 'source', label: 'Source' },
            ]}
          />
        )}
        {data && (
          <span className="fp-size num">{formatBytes(data.size)}</span>
        )}
      </div>
      <div className="rail-scroll scroll fp-body">
        {error ? (
          <p className="rail-empty">{error}</p>
        ) : !data ? (
          <div className="rail-loading">
            <Spinner />
            Opening
          </div>
        ) : image && (data.binary || svg) ? (
          <ImagePreview path={path} size={data.size} svgText={svg && !data.truncated ? data.content : undefined} />
        ) : data.binary ? (
          <p className="rail-empty">This is a binary file, so there is nothing to preview.</p>
        ) : !data.content ? (
          <p className="rail-empty">This file is empty.</p>
        ) : (
          <>
            {data.truncated && <p className="fp-trunc">Showing the first {formatBytes(MAX_READ)} of {formatBytes(data.size)}.</p>}
            {lang === 'markdown' && mdView === 'rendered' ? (
              <div className="fp-md">
                <Markdown text={data.content} />
              </div>
            ) : (
              // The name is already in the path above: the block's header names the language instead.
              <CodeBlock code={data.content} lang={lang} maxHeight={Infinity} startLine={1} className="fp-code" />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ImagePreview({ path, size, svgText }: { path: string; size: number; svgText?: string }) {
  const [failed, setFailed] = useState(false);
  const [dims, setDims] = useState<[number, number] | null>(null);
  if (size > MAX_IMAGE) return <p className="rail-empty">This image is {formatBytes(size)}, too large to preview here.</p>;
  // SVG arrives as text; other images are served by the dev server from disk.
  const src = svgText !== undefined ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}` : `/@fs/${path.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  if (failed) return <p className="rail-empty">This image cannot be shown here.</p>;
  return (
    <figure className="fp-image">
      <div className="fp-image-frame">
        <img src={src} alt="" onError={() => setFailed(true)} onLoad={(e) => setDims([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])} />
      </div>
      {dims && (
        <figcaption className="num">
          {dims[0]} × {dims[1]}
        </figcaption>
      )}
    </figure>
  );
}
