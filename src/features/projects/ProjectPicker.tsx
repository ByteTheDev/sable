import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { DirEntry } from '@shared/protocol';
import { Highlight } from '@/features/palette/Highlight';
import { Icon, type IconName } from '@/icons';
import { bridge } from '@/lib/bridge';
import { desktop, hasNativeFolderPicker } from '@/lib/desktop';
import { baseName, dirName } from '@/lib/format';
import { fuzzy } from '@/lib/fuzzy';
import { addProject } from '@/state/actions';
import { useStore } from '@/state/store';
import { IconButton, Modal, Spinner, Tip, cx } from '@/ui';
import './picker.css';

/**
 * Open a folder as a project. In the desktop app every way of opening a folder (ui.projectPicker)
 * shows the system's own folder dialog; the in-app folder browser is for the browser build only.
 */
export function ProjectPicker() {
  return hasNativeFolderPicker ? <NativeFolderDialog /> : <FolderBrowser />;
}

/** The folder a dialog starts in: the open session's, else the one the home screen is on, else home. */
function currentFolder(): string | undefined {
  const s = useStore.getState();
  const active = s.ui.activeSessionId ? s.sessions[s.ui.activeSessionId] : undefined;
  return active?.cwd || s.ui.homeCwd || s.home || undefined;
}

function NativeFolderDialog() {
  const open = useStore((s) => s.ui.projectPicker);
  const showing = useRef(false);

  useEffect(() => {
    if (!open || showing.current) return;
    showing.current = true;
    void (async () => {
      try {
        const path = await desktop!.pickFolder!(currentFolder());
        if (path) await addProject(path);
      } catch {
        /* the shell refused or the window is closing: nothing was chosen */
      } finally {
        showing.current = false;
        useStore.getState().setUi({ projectPicker: false });
      }
    })();
  }, [open]);

  return null;
}

function FolderBrowser() {
  const open = useStore((s) => s.ui.projectPicker);
  const setUi = useStore((s) => s.setUi);
  // A fresh browser every time the dialog opens.
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (open) setNonce((n) => n + 1);
  }, [open]);

  return (
    <Modal open={open} onOpenChange={(o) => setUi({ projectPicker: o })} title="Open a folder" bare className="picker">
      <PickerBody key={nonce} onClose={() => setUi({ projectPicker: false })} />
    </Modal>
  );
}

interface Listing {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
}

const PLACE_ICON: Record<string, IconName> = { Home: 'home', Desktop: 'laptop', Documents: 'file-text', Downloads: 'download' };

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const same = (a?: string | null, b?: string | null) => !!a && !!b && norm(a) === norm(b);
const looksLikePath = (s: string) => /^([a-zA-Z]:[\\/]?|[\\/]|~|\\\\)/.test(s.trim());

/** Breadcrumb segments with the absolute path each one leads to. */
function segments(p: string): { name: string; path: string }[] {
  const win = /^[a-zA-Z]:/.test(p);
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const out: { name: string; path: string }[] = [];
  if (!win) out.push({ name: '/', path: '/' });
  let acc = '';
  parts.forEach((part, i) => {
    if (win) acc = i === 0 ? `${part}\\` : acc.endsWith('\\') ? acc + part : `${acc}\\${part}`;
    else acc = `${acc}/${part}`;
    out.push({ name: part, path: acc });
  });
  return out;
}

function PickerBody({ onClose }: { onClose: () => void }) {
  const home = useStore((s) => s.home);
  const homeCwd = useStore((s) => s.ui.homeCwd);
  const projects = useStore((s) => s.projects);

  const [places, setPlaces] = useState<DirEntry[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [pathDraft, setPathDraft] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const filterRef = useRef<HTMLInputElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);
  const focusName = useRef<string | null>(null);

  const expand = useCallback((p: string) => (p.trim().startsWith('~') && home ? home + p.trim().slice(1) : p.trim()), [home]);

  /** Lists a folder. Returns false (and leaves the view alone) when it cannot be read. */
  const navigate = useCallback(
    async (target: string, opts: { fromTyped?: boolean; highlight?: string } = {}) => {
      const id = ++reqId.current;
      const slow = window.setTimeout(() => id === reqId.current && setLoading(true), 140);
      try {
        const r = await bridge.call('fs.list', { path: expand(target) });
        if (id !== reqId.current) return true;
        const dirs = r.entries
          .filter((e) => e.dir)
          .map((e) => (e.name.startsWith('.') ? { ...e, ignored: true } : e))
          .sort((a, b) => Number(!!a.ignored) - Number(!!b.ignored));
        focusName.current = opts.highlight ?? null;
        setListing({ path: r.path, parent: r.parent, dirs });
        setFilter('');
        setListError(null);
        setPathError(null);
        setEditing(false);
        // Keep the keyboard in the filter so arrows and Enter keep working after a click.
        window.setTimeout(() => filterRef.current?.focus(), 0);
        return true;
      } catch (err) {
        if (id !== reqId.current) return false;
        const msg = ((err as Error).message ?? String(err)).replace(/^Cannot read folder .*?: /, '');
        const calm = `This folder cannot be opened: ${msg}.`;
        if (opts.fromTyped) setPathError(calm);
        else setListError(calm);
        return false;
      } finally {
        window.clearTimeout(slow);
        if (id === reqId.current) setLoading(false);
      }
    },
    [expand],
  );

  // First load: places, then the parent of the current project (with it highlighted), or home.
  useEffect(() => {
    void bridge
      .call('fs.roots', {})
      .then((r) => setPlaces(r.roots))
      .catch(() => {});
    const start = homeCwd ? dirName(homeCwd) : home;
    void navigate(start || home || '/', { highlight: homeCwd ? baseName(homeCwd) : undefined }).then((ok) => {
      if (!ok && home) void navigate(home);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Branch hint for the current folder only (cheap: the branch refs, not a full status).
  useEffect(() => {
    setBranch(null);
    if (!listing) return;
    const path = listing.path;
    const t = window.setTimeout(() => {
      void bridge
        .call('git.branches', { cwd: path })
        .then((b) => {
          if ((b.current || b.branches.length) && reqIdPath.current === path) setBranch(b.current ?? 'detached');
        })
        .catch(() => {});
    }, 180);
    return () => window.clearTimeout(t);
  }, [listing]);
  const reqIdPath = useRef<string | null>(null);
  reqIdPath.current = listing?.path ?? null;

  const rows = useMemo(() => {
    const dirs = listing?.dirs ?? [];
    const q = filter.trim();
    if (!q || looksLikePath(q)) return dirs.map((d) => ({ d, indices: undefined as number[] | undefined }));
    return dirs
      .map((d) => ({ d, m: fuzzy(q, d.name) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m!.score - a.m!.score)
      .map((x) => ({ d: x.d, indices: x.m!.indices }));
  }, [listing, filter]);

  // Cursor follows the folder we came from, or resets on a new listing / filter.
  useLayoutEffect(() => {
    if (focusName.current) {
      const i = rows.findIndex((r) => r.d.name.toLowerCase() === focusName.current!.toLowerCase());
      focusName.current = null;
      setCursor(Math.max(0, i));
    } else setCursor(0);
  }, [rows]);

  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor, rows]);

  // Keep the end of a long path visible.
  useLayoutEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [listing, editing]);

  useEffect(() => {
    if (editing) {
      const el = pathRef.current;
      el?.focus();
      el?.select();
    } else filterRef.current?.focus();
  }, [editing]);

  // Escape while typing a path (or with a filter) clears that first instead of closing
  // the dialog. Window capture runs before the dialog's own document listener.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editing) {
        e.stopPropagation();
        e.preventDefault();
        setEditing(false);
        setPathError(null);
      } else if (filter && document.activeElement === filterRef.current) {
        e.stopPropagation();
        e.preventDefault();
        setFilter('');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editing, filter]);

  const goUp = () => {
    if (listing?.parent) void navigate(listing.parent, { highlight: baseName(listing.path) });
  };

  const openFolder = async (path: string) => {
    if (opening) return;
    setOpening(true);
    const p = await addProject(path);
    if (!p) setOpening(false);
  };

  const startEditing = () => {
    setPathDraft(listing?.path ?? '');
    setPathError(null);
    setEditing(true);
  };

  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = rows.length;
    if (e.metaKey || e.ctrlKey) return; // handled by the body (mod+Enter, mod+L)
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n) setCursor((c) => Math.min(n - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Home' && !filter) {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === 'End' && !filter) {
      e.preventDefault();
      setCursor(Math.max(0, n - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (looksLikePath(filter)) void navigate(filter, { fromTyped: true });
      else if (rows[cursor]) void navigate(rows[cursor].d.path);
    } else if ((e.key === 'Backspace' && !filter) || (e.key === 'ArrowLeft' && e.altKey)) {
      e.preventDefault();
      goUp();
    } else if (e.key === 'ArrowRight' && !filter && rows[cursor]) {
      e.preventDefault();
      void navigate(rows[cursor].d.path);
    }
  };

  const recent = useMemo(() => [...projects].sort((a, b) => b.lastOpened - a.lastOpened).slice(0, 8), [projects]);
  const named = places.filter((p) => !/^[a-zA-Z]:$|^\/$/.test(p.name));
  const drives = places.filter((p) => /^[a-zA-Z]:$|^\/$/.test(p.name));
  const crumbs = listing ? segments(listing.path) : [];
  const typedPath = looksLikePath(filter);

  return (
    <div
      className="picker-body"
      onKeyDown={(e) => {
        if (!(e.metaKey || e.ctrlKey)) return;
        if (e.key === 'Enter' && e.target !== pathRef.current) {
          e.preventDefault();
          if (listing) void openFolder(listing.path);
        } else if (e.key.toLowerCase() === 'l') {
          e.preventDefault();
          startEditing();
        }
      }}
    >
      <div className="picker-head">
        <h2 className="dialog-title">Open a folder</h2>
        <IconButton icon="x" label="Close" onClick={onClose} />
      </div>

      <div className="picker-main">
        <aside className="picker-side scroll" aria-label="Places">
          <div className="picker-label">Places</div>
          {named.map((p) => (
            <PlaceRow key={p.path} icon={PLACE_ICON[p.name] ?? 'folder'} label={p.name} title={p.path} active={same(p.path, listing?.path)} onClick={() => void navigate(p.path)} />
          ))}
          {drives.map((p) => (
            <PlaceRow key={p.path} icon="drives" label={p.name === '/' ? 'Computer' : `Drive ${p.name}`} title={p.path} active={same(p.path, listing?.path)} onClick={() => void navigate(p.path)} />
          ))}
          {recent.length > 0 && (
            <>
              <div className="picker-label picker-label-gap">Recent</div>
              {recent.map((p) => (
                <PlaceRow key={p.path} icon="folder" label={p.name || baseName(p.path)} title={p.path} active={same(p.path, listing?.path)} onClick={() => void navigate(p.path)} />
              ))}
            </>
          )}
        </aside>

        <section className="picker-browse" data-spot="">
          <div className="picker-bar">
            <Tip label="Up one folder" keys="Backspace">
              <button type="button" className="picker-up" aria-label="Up one folder" disabled={!listing?.parent} onClick={goUp}>
                <Icon name="arrow-left" size={14} />
              </button>
            </Tip>
            {editing ? (
              <div className="picker-path-edit">
                <input
                  ref={pathRef}
                  className="picker-path-input"
                  value={pathDraft}
                  spellCheck={false}
                  aria-label="Folder path"
                  aria-invalid={!!pathError}
                  onChange={(e) => {
                    setPathDraft(e.target.value);
                    setPathError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void navigate(pathDraft, { fromTyped: true });
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setEditing(false);
                      setPathError(null);
                    }
                  }}
                  onBlur={() => !pathError && setEditing(false)}
                />
              </div>
            ) : (
              <div className="picker-crumbs" ref={crumbsRef} onClick={(e) => e.target === e.currentTarget && startEditing()}>
                {crumbs.map((c, i) => (
                  <span key={c.path} className="crumb-wrap">
                    {i > 0 && <Icon name="caret-right" size={9} className="crumb-sep" />}
                    <button type="button" className="crumb" data-last={i === crumbs.length - 1 || undefined} onClick={() => void navigate(c.path)}>
                      {c.name}
                    </button>
                  </span>
                ))}
                <span className="crumb-fill" onClick={startEditing} />
              </div>
            )}
            <Tip label="Type a path" keys="mod+l">
              <button type="button" className="picker-up" aria-label="Type a path" data-active={editing || undefined} onClick={() => (editing ? setEditing(false) : startEditing())}>
                <Icon name="pencil" size={14} />
              </button>
            </Tip>
          </div>
          {pathError && <div className="picker-error" role="alert">{pathError}</div>}

          <div className="picker-filter">
            <Icon name={typedPath ? 'arrow-right' : 'filter'} size={14} />
            <input
              ref={filterRef}
              className="picker-filter-input"
              value={filter}
              placeholder="Filter folders, or paste a path"
              spellCheck={false}
              aria-label="Filter folders"
              aria-controls="picker-list"
              aria-activedescendant={rows[cursor] ? `picker-opt-${cursor}` : undefined}
              onChange={(e) => {
                setFilter(e.target.value);
                setPathError(null);
              }}
              onKeyDown={onFilterKey}
            />
            {!typedPath && listing && <span className="picker-filter-hint num">{filter ? `${rows.length} of ${listing.dirs.length}` : `${listing.dirs.length} folders`}</span>}
          </div>

          <div ref={listRef} id="picker-list" className="picker-list scroll" role="listbox" aria-label="Folders" aria-busy={loading}>
            {listError ? (
              <div className="picker-note is-error">{listError}</div>
            ) : !listing ? (
              <div className="picker-note">
                <Spinner />
              </div>
            ) : rows.length === 0 ? (
              <div className="picker-note">{filter && !typedPath ? `No folder here matches “${filter}”.` : typedPath ? 'Press Enter to go to this path.' : 'This folder has no sub-folders.'}</div>
            ) : (
              rows.map(({ d, indices }, i) => (
                <div
                  key={d.path}
                  id={`picker-opt-${i}`}
                  role="option"
                  aria-selected={i === cursor && !typedPath}
                  data-index={i}
                  data-active={(i === cursor && !typedPath) || undefined}
                  className={cx('picker-row', i === cursor && !typedPath && 'dither-sel', d.ignored && 'is-dim')}

                  onMouseMove={() => i !== cursor && setCursor(i)}
                  onClick={() => void navigate(d.path)}
                >
                  <Icon name="folder" size={16} className="picker-row-icon" />
                  <span className="truncate grow">
                    <Highlight text={d.name} indices={indices} />
                  </span>
                  <button
                    type="button"
                    className="picker-row-open"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      void openFolder(d.path);
                    }}
                  >
                    Open
                  </button>
                  <Icon name="caret-right" size={11} className="picker-row-chev" />
                </div>
              ))
            )}
            {loading && listing && (
              <div className="picker-loading">
                <Spinner size={12} />
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="picker-foot">
        <div className="picker-current">
          <span className="picker-current-name truncate">{listing ? baseName(listing.path) || listing.path : ''}</span>
          {branch && (
            <span className="picker-branch">
              <Icon name="branch" size={12} />
              <span className="truncate">{branch}</span>
            </span>
          )}
        </div>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={!listing || opening} onClick={() => listing && void openFolder(listing.path)}>
          {opening ? <Spinner size={13} /> : null}
          Open this folder
        </button>
      </div>
    </div>
  );
}

function PlaceRow({ icon, label, title, active, onClick }: { icon: IconName; label: string; title: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className="place" data-active={active || undefined} title={title} onClick={onClick}>
      <Icon name={icon} size={15} />
      <span className="truncate">{label}</span>
    </button>
  );
}
