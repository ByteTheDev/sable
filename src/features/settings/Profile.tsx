import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ProfileEntry, UserProfile } from '@shared/protocol';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '@/icons';
import { bridge } from '@/lib/bridge';
import { setSettings } from '@/state/actions';
import { useStore } from '@/state/store';
import { IconButton, Switch } from '@/ui';
import { Card, CodeChip, Row, Skeleton } from './parts';
import './profile.css';

/**
 * Settings › Profile: `<home>/profile.md`, what agents know about the user. The user's own part in a
 * calm editor (saved when it loses focus, or with Ctrl+S), the facts agents added below it, newest
 * first, each removable, and the switch that keeps it out of every agent. The bridge pushes
 * `profile.updated` when an agent adds a fact while this is open.
 */

/** Unsaved text, kept while Settings switches sections. */
let draft: string | undefined;

/** "Today", "Yesterday", "12 Nov" for a YYYY-MM-DD date. */
function dayText(day: string, now = new Date()): string {
  const [y, m, d] = day.split('-').map(Number);
  const at = new Date(y, (m || 1) - 1, d || 1);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today.getTime() - at.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(at.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

export function Profile() {
  const on = useStore((s) => s.settings.userProfile !== false);
  const toast = useStore((s) => s.toast);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [text, setText] = useState('');
  const [state, setState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const saved = useRef('');

  useEffect(() => {
    let live = true;
    void bridge.call('profile.read', {}).then(
      (p) => {
        if (!live) return;
        setProfile(p);
        saved.current = p.text;
        setText(draft ?? p.text);
        setState(draft !== undefined && draft !== p.text ? 'dirty' : 'saved');
      },
      (err: Error) => toast(err.message, 'error'),
    );
    const off = bridge.on((e) => {
      if (e.type !== 'profile.updated') return;
      setProfile(e.profile);
      // The user's own part changed elsewhere: take it unless there are edits here.
      if (e.profile.text !== saved.current && draft === undefined) setText(e.profile.text);
      saved.current = e.profile.text;
    });
    return () => {
      live = false;
      off();
      // Settings closed or moved on with edits still in the field: they are saved all the same.
      const value = draft;
      if (value !== undefined && value !== saved.current)
        void bridge.call('profile.write', { text: value }).then(() => {
          if (draft === value) draft = undefined;
        });
    };
  }, [toast]);

  const save = async () => {
    if (draft === undefined || draft === saved.current) {
      draft = undefined;
      setState('saved');
      return;
    }
    const value = draft;
    setState('saving');
    try {
      const p = await bridge.call('profile.write', { text: value });
      saved.current = p.text;
      setProfile(p);
      if (draft === value) {
        draft = undefined;
        // The file keeps the text tidy (no trailing blank lines): show what was kept.
        setText(p.text);
      }
      setState(draft === undefined ? 'saved' : 'dirty');
    } catch (err) {
      setState('dirty');
      toast((err as Error).message, 'error');
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    }
  };

  const remove = async (entry: ProfileEntry) => {
    try {
      setProfile(await bridge.call('profile.forget', { id: entry.id }));
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className="set-stack prof">
      <Card>
        <Row label="Use profile" help={on ? 'Every new chat reads it, and agents add what they learn about you' : 'Agents neither read it nor add to it'}>
          <Switch label="Use profile" checked={on} onChange={(v) => void setSettings({ userProfile: v })} />
        </Row>
      </Card>

      <section className="set-group">
        <header className="set-group-head">
          <h3 className="set-group-title">About you</h3>
          {profile && (
            <div className="set-group-aside">
              <CodeChip text={profile.path} label="Copy path" />
            </div>
          )}
        </header>
        {profile ? (
          <div className="prof-editor-wrap">
            <textarea
              className="prof-editor well scroll"
              value={text}
              spellCheck
              aria-label="About you"
              placeholder={'## How I like answers\n- Short, with the result first'}
              onChange={(e) => {
                draft = e.target.value;
                setText(e.target.value);
                setState(e.target.value === saved.current ? 'saved' : 'dirty');
              }}
              onBlur={() => void save()}
              onKeyDown={onKeyDown}
            />
            <div className="prof-bar" aria-live="polite">
              <span className="prof-state" data-state={state}>
                {state === 'saved' ? (
                  <>
                    <Icon name="check" size={13} />
                    Saved
                  </>
                ) : state === 'saving' ? (
                  'Saving'
                ) : (
                  'Edited'
                )}
              </span>
              <span className="grow" />
              <span className="prof-words num">About {profile.promptWords} words go to each agent</span>
            </div>
          </div>
        ) : (
          <div className="card set-card">
            <Skeleton rows={2} />
          </div>
        )}
      </section>

      {profile && (
        <section className="set-group">
          <header className="set-group-head">
            <h3 className="set-group-title">Learned</h3>
          </header>
          <div className="card set-card prof-learned" data-spot>
            {profile.entries.length ? (
              <ul className="prof-list" aria-label="Learned about you">
                <AnimatePresence initial={false}>
                  {profile.entries.map((e) => (
                    <motion.li
                      key={e.id}
                      className="prof-row"
                      layout="position"
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0 }}
                      transition={{ type: 'spring', stiffness: 460, damping: 38 }}
                    >
                      <span className="prof-fact">{e.text}</span>
                      <span className="prof-date num">{dayText(e.date)}</span>
                      <IconButton icon="x" label="Remove" size={13} className="prof-remove" onClick={() => void remove(e)} />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            ) : (
              <p className="prof-empty">Agents add what they learn about you here.</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
