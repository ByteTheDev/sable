import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { baseName } from '@desk/lib/format';
import { pushBack } from '@m/lib/back';
import { conn } from '@m/lib/conn';
import { launchFlight } from '@m/lib/flight';
import { onKeyboard } from '@m/lib/keyboard';
import { haptic } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { openFrom } from '@m/lib/open';
import { applySnapshot, setState, useStore } from '@m/lib/store';
import { fieldBeat } from '@m/ui/Field';
import { Icon } from '@m/ui/icons';
import { ProviderMark, SHORT_NAME } from '@m/ui/marks';
import { SNAP } from '@m/ui/motion';
import { AgentSheet, createChat, FolderSheet, ModelSheet, useNewChat } from './NewChat';

const DRAFT = 'sable.newdraft';

/**
 * New chat, as on the desktop's home: the prompt bar itself. At rest one line of frosted glass over
 * the field; touched, it opens (the agent, the folder and the model as chips over the words) and
 * rides up with the keyboard. Send starts the chat on the desktop, and the bar becomes the chat:
 * the conversation opens out of it and the words fly to their place.
 */
export function HomeDock({ covered }: { covered: boolean }) {
  const online = useStore((s) => s.conn === 'open');
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(DRAFT) ?? '';
    } catch {
      return '';
    }
  });
  const [focused, setFocused] = useState(false);
  const [sheet, setSheet] = useState<'agent' | 'folder' | 'model' | null>(null);
  const [busy, setBusy] = useState(false);
  const c = useNewChat(focused || !!sheet || !!text);
  const dock = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const sendKey = useRef<HTMLButtonElement>(null);
  const open = focused || !!text.trim() || !!sheet;

  const fit = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  };
  useEffect(fit, []);
  const update = (v: string) => {
    setText(v);
    try {
      if (v.trim()) localStorage.setItem(DRAFT, v);
      else localStorage.removeItem(DRAFT);
    } catch {
      /* private mode */
    }
    requestAnimationFrame(fit);
  };

  // The keyboard put away: the field lets go too.
  useEffect(() => onKeyboard((lift, prev) => lift === 0 && prev > 0 && document.activeElement === area.current && area.current?.blur()), []);
  useEffect(() => (focused ? pushBack(() => (area.current?.blur(), true)) : undefined), [focused]);

  const send = async () => {
    const t = text.trim();
    if (!t || !online || busy || !c.agent) return;
    setBusy(true);
    haptic('send');
    fieldBeat('send', sendKey.current);
    const rect = area.current?.getBoundingClientRect();
    try {
      const snap = await createChat(c, t);
      applySnapshot(snap);
      // The bar becomes the chat; the words fly from where they were written.
      if (rect) launchFlight(t, rect);
      openFrom(snap.session.id, dock.current, 26);
      update('');
      area.current?.blur();
      nav.chat(snap.session.id);
      // The message goes once the chat is there (it may have opened in a fresh folder named after it).
      await conn.call('session.send', { sessionId: snap.session.id, text: t });
    } catch (err) {
      haptic('deny');
      setState({ toast: { text: (err as Error).message, level: 'error', at: Date.now() } });
    } finally {
      setBusy(false);
    }
  };

  const folderLabel = c.folder === null ? 'No folder' : c.folder ? baseName(c.folder) : 'Folder';
  const modelLabel = c.models.find((m) => m.id === c.model)?.name;

  return (
    <>
      <AnimatePresence>
        {focused && (
          <motion.div
            className="dock-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onPointerDown={(e) => {
              e.preventDefault();
              area.current?.blur();
            }}
          />
        )}
      </AnimatePresence>
      <div className="home-dock" ref={dock} data-open={open || undefined} data-focus={focused || undefined} data-covered={covered || undefined} onClick={() => area.current?.focus()}>
        <AnimatePresence initial={false}>
          {open && c.agent && (
            <motion.div className="dock-chips" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SNAP}>
              <div className="chips no-drag">
                <button type="button" className="chip-btn" onPointerDown={(e) => e.preventDefault()} onClick={(e) => (e.stopPropagation(), haptic('tap'), setSheet('agent'))}>
                  <ProviderMark provider={c.agent} size={15} />
                  <span>{SHORT_NAME[c.agent]}</span>
                </button>
                <button type="button" className="chip-btn" onPointerDown={(e) => e.preventDefault()} onClick={(e) => (e.stopPropagation(), haptic('tap'), setSheet('folder'))}>
                  <Icon name={c.folder === null ? 'chat' : 'folder'} size={15} />
                  <span>{folderLabel}</span>
                </button>
                {modelLabel && (
                  <button type="button" className="chip-btn" onPointerDown={(e) => e.preventDefault()} onClick={(e) => (e.stopPropagation(), haptic('tap'), setSheet('model'))}>
                    <span>{modelLabel}</span>
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="dock-line">
          {!open && c.agent && <ProviderMark provider={c.agent} size={17} className="dock-mark" />}
          <textarea
            ref={area}
            className="dock-input"
            rows={1}
            value={text}
            placeholder="New chat"
            disabled={!online && !text}
            onChange={(e) => update(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            aria-label="New chat"
            enterKeyHint="send"
          />
          <motion.button
            ref={sendKey}
            type="button"
            className="send"
            aria-label={open ? 'Start chat' : 'New chat'}
            disabled={open && (!text.trim() || !online || busy || !c.agent)}
            data-busy={busy || undefined}
            data-rest={!open || undefined}
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              if (!open) return area.current?.focus();
              void send();
            }}
            whileTap={{ scale: 0.9 }}
            transition={SNAP}
          >
            {busy ? (
              <span className="send-wait" />
            ) : (
              <motion.span className="send-glyph" animate={{ rotate: open ? 0 : 90 }} transition={SNAP}>
                <Icon name={open ? 'up' : 'plus'} size={18} weight="bold" />
              </motion.span>
            )}
          </motion.button>
        </div>
      </div>
      <AgentSheet open={sheet === 'agent'} onClose={() => setSheet(null)} c={c} />
      <FolderSheet open={sheet === 'folder'} onClose={() => setSheet(null)} c={c} />
      <ModelSheet open={sheet === 'model'} onClose={() => setSheet(null)} c={c} />
    </>
  );
}
