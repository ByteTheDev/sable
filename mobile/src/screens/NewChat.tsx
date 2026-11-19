import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import type { Capabilities, DirEntry, ProviderId } from '@shared/protocol';
import { baseName, dirName } from '@desk/lib/format';
import { modelName, visibleModels } from '@desk/lib/models';
import { conn } from '@m/lib/conn';
import { haptic } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { applySnapshot, getState, setState, useStore } from '@m/lib/store';
import { Icon } from '@m/ui/icons';
import { ProviderMark, SHORT_NAME } from '@m/ui/marks';
import { Choice, Sheet } from '@m/ui/Sheet';

/** New chat: the agent, the folder (recent ones, or browse the desktop's folders), the model. */
export function NewChatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const agents = useMemo(
    () => (['claude', 'codex', 'demo'] as ProviderId[]).filter((id) => providers[id]?.installed && (id === 'demo' || providers[id]?.auth.loggedIn)),
    [providers],
  );
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [browse, setBrowse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const agent = provider && agents.includes(provider) ? provider : agents.includes(settings?.defaultProvider as ProviderId) ? (settings!.defaultProvider as ProviderId) : (agents[0] ?? null);

  const recent = useMemo(() => {
    const seen = new Map<string, { path: string; at: number }>();
    for (const p of projects) if (!p.hidden) seen.set(p.path.toLowerCase(), { path: p.path, at: p.lastOpened });
    for (const s of Object.values(sessions)) {
      const k = s.cwd.toLowerCase();
      const cur = seen.get(k);
      if (!cur || cur.at < s.updatedAt) seen.set(k, { path: s.cwd, at: Math.max(cur?.at ?? 0, s.updatedAt) });
    }
    return [...seen.values()].sort((a, b) => b.at - a.at).slice(0, 6);
  }, [projects, sessions]);
  const folder = cwd ?? recent[0]?.path ?? null;

  const capsKey = agent && folder ? `${agent}:${folder}` : '';
  const caps = useStore((s) => (capsKey ? s.caps[capsKey] : undefined));
  useEffect(() => {
    if (!open || !agent || !folder || getState().caps[`${agent}:${folder}`]) return;
    let live = true;
    conn
      .call('provider.caps', { provider: agent, cwd: folder })
      .then((c: Capabilities) => live && setState((s) => ({ caps: { ...s.caps, [`${agent}:${folder}`]: c } })))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, agent, folder]);

  const models = useMemo(() => (agent && caps ? visibleModels(agent, caps.models, settings?.modelVisibility) : []), [agent, caps, settings?.modelVisibility]);
  const chosenModel = model && models.some((m) => m.id === model) ? model : (settings?.defaultModels[agent ?? 'claude'] ?? models.find((m) => m.isDefault)?.id ?? models[0]?.id);

  useEffect(() => {
    if (!open) {
      setBrowse(false);
      setError(undefined);
      setBusy(false);
    }
  }, [open]);

  const start = async () => {
    if (!agent || !folder) return;
    setBusy(true);
    setError(undefined);
    haptic('send');
    try {
      const snap = await conn.call('session.create', { provider: agent, cwd: folder, ...(chosenModel ? { model: chosenModel } : {}) }, 90_000);
      applySnapshot(snap);
      onClose();
      nav.chat(snap.session.id);
    } catch (err) {
      haptic('deny');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={browse ? 'Choose a folder' : 'New chat'} tall={browse}>
      <AnimatePresence mode="wait" initial={false}>
        {browse ? (
          <motion.div key="browse" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 24 }} transition={{ type: 'spring', stiffness: 460, damping: 40 }}>
            <FolderBrowser
              start={folder}
              onPick={(p) => {
                setCwd(p);
                setBrowse(false);
              }}
              onCancel={() => setBrowse(false)}
            />
          </motion.div>
        ) : (
          <motion.div key="main" className="newchat" initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ type: 'spring', stiffness: 460, damping: 40 }}>
            {agents.length > 1 && (
              <div className="seg" role="radiogroup" aria-label="Agent">
                {agents.map((id) => (
                  <button key={id} type="button" role="radio" aria-checked={agent === id} className="seg-opt" data-on={agent === id || undefined} onClick={() => (haptic('select'), setProvider(id), setModel(null))}>
                    <ProviderMark provider={id} size={15} />
                    {SHORT_NAME[id]}
                  </button>
                ))}
              </div>
            )}

            <h3 className="sheet-sub">Folder</h3>
            <div className="choices">
              {recent.map((r) => (
                <Choice key={r.path} selected={folder === r.path} onPick={() => (haptic('select'), setCwd(r.path))} icon={<Icon name="folder" size={17} />}>
                  <span className="path">
                    <span className="path-name">{baseName(r.path)}</span>
                    <span className="path-dir">{dirName(r.path)}</span>
                  </span>
                </Choice>
              ))}
              {folder && !recent.some((r) => r.path === folder) && (
                <Choice selected onPick={() => {}} icon={<Icon name="folder" size={17} />}>
                  <span className="path">
                    <span className="path-name">{baseName(folder)}</span>
                    <span className="path-dir">{dirName(folder)}</span>
                  </span>
                </Choice>
              )}
              <button type="button" className="choice choice-quiet" onClick={() => setBrowse(true)}>
                <span className="choice-icon">
                  <Icon name="plus" size={17} />
                </span>
                <span className="choice-label">Other folder</span>
              </button>
            </div>

            {models.length > 0 && (
              <>
                <h3 className="sheet-sub">Model</h3>
                <div className="choices">
                  {models.map((m) => (
                    <Choice key={m.id} selected={chosenModel === m.id} onPick={() => (haptic('select'), setModel(m.id))}>
                      {modelName(m) ?? m.name}
                    </Choice>
                  ))}
                </div>
              </>
            )}

            {error && <p className="form-error">{error}</p>}
            <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!agent || !folder || busy} data-busy={busy || undefined} onClick={() => void start()}>
              {busy ? <span className="dots" aria-label="Starting" /> : 'Start chat'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </Sheet>
  );
}

/** The desktop's folders, one level at a time (folders only: the phone never lists files). */
function FolderBrowser({ start, onPick, onCancel }: { start: string | null; onPick: (path: string) => void; onCancel: () => void }) {
  const [here, setHere] = useState<{ path: string | null; parent: string | null; entries: DirEntry[] } | null>(null);
  const [error, setError] = useState<string>();

  const load = async (p: string | null) => {
    setError(undefined);
    try {
      if (p === null) {
        const r = await conn.call('fs.roots', {});
        setHere({ path: null, parent: null, entries: r.roots });
      } else {
        const r = await conn.call('fs.list', { path: p });
        setHere({ path: r.path, parent: r.parent, entries: r.entries.filter((e) => e.dir && !e.name.startsWith('.')) });
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void load(start ? dirName(start) || null : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="browser">
      <div className="browser-bar">
        <button type="button" className="icon-btn" aria-label="Up one folder" disabled={!here?.path} onClick={() => void load(here?.parent ?? null)}>
          <Icon name="back" size={19} />
        </button>
        <span className="browser-here">{here?.path ? baseName(here.path) || here.path : 'This computer'}</span>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="choices browser-list">
        {here?.entries.map((e) => (
          <button key={e.path} type="button" className="choice" onClick={() => void load(e.path)}>
            <span className="choice-icon">
              <Icon name="folder" size={17} />
            </span>
            <span className="choice-label">{e.name}</span>
            <Icon name="next" size={15} className="choice-caret" />
          </button>
        ))}
        {here && !here.entries.length && <p className="empty">No folders here.</p>}
      </div>
      {here?.path && (
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => (haptic('select'), onPick(here.path!))}>
          Use {baseName(here.path) || here.path}
        </button>
      )}
    </div>
  );
}
