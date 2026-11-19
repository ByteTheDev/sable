import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState } from 'react';
import type { Attachment, Effort, ModeTone, QueuedMessage } from '@shared/protocol';
import { effortName, modelName, modelNameById, visibleModels } from '@desk/lib/models';
import { conn } from '@m/lib/conn';
import { launchFlight } from '@m/lib/flight';
import { haptic } from '@m/lib/native';
import { sessionData, setState, useStore } from '@m/lib/store';
import { fieldBeat } from '@m/ui/Field';
import { Icon, type IconName } from '@m/ui/icons';
import { Choice, Sheet } from '@m/ui/Sheet';

const MODE_ICON: Record<ModeTone, IconName> = { ask: 'hand', edit: 'edit', plan: 'plan', auto: 'bolt', danger: 'shield' };

const drafts = new Map<string, string>();

/**
 * The composer: a frosted bar at the bottom, as on the desktop. Send (an ivory disc), stop while a
 * turn runs, messages sent mid-turn wait in the queue above it (steer one in with its arrow).
 * Model, mode and effort open as sheets; photos come from the camera or files.
 */
export function Composer({ sid }: { sid: string }) {
  const s = useStore((st) => st.sessions[sid]);
  const caps = useStore((st) => sessionData(st, sid).caps);
  const queue = useStore((st) => sessionData(st, sid).queue);
  const visibility = useStore((st) => st.settings?.modelVisibility);
  const sendWithEnter = useStore((st) => st.settings?.sendWithEnter !== false);
  const [text, setText] = useState(() => drafts.get(sid) ?? '');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [sheet, setSheet] = useState<'model' | 'mode' | 'effort' | null>(null);
  const [focused, setFocused] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  if (!s) return null;

  const running = s.status === 'running' || s.status === 'starting' || s.status === 'awaiting';
  const empty = !text.trim() && !files.length;
  const model = caps?.models.find((m) => m.id === s.model);
  const models = caps ? visibleModels(s.provider, caps.models, visibility, s.model) : [];
  const mode = caps?.modes.find((m) => m.id === s.mode);
  const efforts = model?.efforts ?? [];

  const update = (v: string) => {
    setText(v);
    drafts.set(sid, v);
    const el = area.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
    }
  };

  const send = async () => {
    const t = text.trim();
    if (!t && !files.length) return;
    const el = area.current;
    if (el && t) launchFlight(t, el.getBoundingClientRect());
    haptic('send');
    fieldBeat('send');
    const attachments = files.length ? files : undefined;
    update('');
    setFiles([]);
    try {
      await conn.call('session.send', { sessionId: sid, text: t, attachments });
    } catch (err) {
      haptic('deny');
      update(t);
      setFiles(attachments ?? []);
      setState({ toast: { text: (err as Error).message, level: 'error', at: Date.now() } });
    }
  };

  const stop = () => {
    haptic('warning');
    void conn.call('session.interrupt', { sessionId: sid }).catch(() => {});
  };

  const pick = async (list: FileList | null) => {
    if (!list) return;
    const next: Attachment[] = [];
    for (const f of Array.from(list).slice(0, 6)) {
      if (f.size > 8 * 1024 * 1024) continue;
      const dataUrl = await shrink(f);
      next.push({ id: crypto.randomUUID(), kind: 'image', name: f.name || 'Photo', dataUrl, mime: dataUrl.slice(5, dataUrl.indexOf(';')), size: Math.round((dataUrl.length * 3) / 4) });
    }
    setFiles((cur) => [...cur, ...next]);
  };

  return (
    <div className="composer-dock">
      <QueueTray sid={sid} queue={queue} />
      <motion.div className="composer glass" data-focus={focused || undefined} layout="position" transition={{ type: 'spring', stiffness: 460, damping: 40 }}>
        <AnimatePresence initial={false}>
          {files.length > 0 && (
            <motion.div className="attach-row" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
              {files.map((f) => (
                <span key={f.id} className="attach">
                  <img src={f.dataUrl} alt={f.name} />
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))}>
                    <Icon name="x" size={12} weight="bold" />
                  </button>
                </span>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        <textarea
          ref={area}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={running ? 'Queue a follow-up' : 'Message'}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends (the keyboard shows a send key); Shift+Enter, or Enter with "Send with Enter" off on the desktop, is a new line.
            if (e.key === 'Enter' && !e.shiftKey && sendWithEnter && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-label="Message"
          enterKeyHint="send"
        />
        <div className="composer-bar">
          {caps?.features.images !== false && (
            <>
              <button type="button" className="chip-btn round" aria-label="Add a photo" onClick={() => fileInput.current?.click()}>
                <Icon name="plus" size={18} />
              </button>
              <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => void pick(e.target.files).then(() => (e.target.value = ''))} />
            </>
          )}
          <div className="chips">
            {mode && (
              <button type="button" className="chip-btn" data-tone={mode.tone} onClick={() => (haptic('tap'), setSheet('mode'))}>
                <Icon name={MODE_ICON[mode.tone] ?? 'hand'} size={15} />
                <span>{mode.name}</span>
              </button>
            )}
            {(model || s.model) && (
              <button type="button" className="chip-btn" onClick={() => (haptic('tap'), setSheet('model'))}>
                <span>{modelName(model) ?? modelNameById(s.model, caps?.models) ?? 'Model'}</span>
              </button>
            )}
            {efforts.length > 0 && (
              <button type="button" className="chip-btn" onClick={() => (haptic('tap'), setSheet('effort'))}>
                <span>{effortName(s.effort ?? model?.defaultEffort) ?? 'Effort'}</span>
              </button>
            )}
          </div>
          <AnimatePresence mode="popLayout" initial={false}>
            {running && empty ? (
              <motion.button key="stop" type="button" className="send" aria-label="Stop" onClick={stop} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={{ type: 'spring', stiffness: 520, damping: 34 }}>
                <span className="stop-square" />
              </motion.button>
            ) : (
              <motion.button key="send" type="button" className="send" aria-label={running ? 'Queue' : 'Send'} disabled={empty} onClick={() => void send()} whileTap={{ scale: 0.92 }} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={{ type: 'spring', stiffness: 520, damping: 34 }}>
                <Icon name="up" size={18} weight="bold" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      <Sheet open={sheet === 'model'} onClose={() => setSheet(null)} title="Model">
        <div className="choices">
          {models.map((m) => (
            <Choice
              key={m.id}
              selected={m.id === s.model}
              onPick={() => {
                haptic('select');
                setSheet(null);
                void conn.call('session.setModel', { sessionId: sid, model: m.id }).catch(() => {});
              }}
            >
              {modelName(m) ?? m.name}
            </Choice>
          ))}
        </div>
      </Sheet>
      <Sheet open={sheet === 'mode'} onClose={() => setSheet(null)} title="Permissions">
        <div className="choices">
          {caps?.modes.map((m) => (
            <Choice
              key={m.id}
              selected={m.id === s.mode}
              icon={<Icon name={MODE_ICON[m.tone] ?? 'hand'} size={17} />}
              onPick={() => {
                haptic('select');
                setSheet(null);
                void conn.call('session.setMode', { sessionId: sid, mode: m.id }).catch(() => {});
              }}
            >
              {m.name}
            </Choice>
          ))}
        </div>
      </Sheet>
      <Sheet open={sheet === 'effort'} onClose={() => setSheet(null)} title="Effort">
        <div className="choices">
          {efforts.map((e: Effort) => (
            <Choice
              key={e}
              selected={e === (s.effort ?? model?.defaultEffort)}
              onPick={() => {
                haptic('select');
                setSheet(null);
                void conn.call('session.setEffort', { sessionId: sid, effort: e }).catch(() => {});
              }}
            >
              {effortName(e)}
            </Choice>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

/** Messages sent while the agent works: they go out when the turn ends, or now with the arrow (steered in). */
function QueueTray({ sid, queue }: { sid: string; queue: QueuedMessage[] }) {
  return (
    <div className="queue">
      <AnimatePresence initial={false}>
        {queue.map((q) => (
          <motion.div
            key={q.id}
            className="queued glass"
            layout
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
            transition={{ type: 'spring', stiffness: 460, damping: 38 }}
          >
            <span className="queued-text">{q.text || 'Photo'}</span>
            <button
              type="button"
              className="icon-btn sm"
              aria-label="Send now"
              onClick={() => {
                haptic('send');
                void conn.call('queue.sendNow', { sessionId: sid, id: q.id }).catch(() => {});
              }}
            >
              <Icon name="steer" size={17} />
            </button>
            <button
              type="button"
              className="icon-btn sm"
              aria-label="Remove"
              onClick={() => {
                haptic('tap');
                void conn.call('queue.remove', { sessionId: sid, id: q.id }).catch(() => {});
              }}
            >
              <Icon name="x" size={15} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Photos go to the desktop as data URLs: at most 1600 px on the long side, JPEG. */
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}
