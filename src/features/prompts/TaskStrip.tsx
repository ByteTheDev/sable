import { useState } from 'react';
import type { Todo } from '@shared/protocol';
import { Ring as Spinner } from '@/art/Logo';
import { Collapse } from '@/components/Collapse';
import { Icon } from '@/icons';

/** Expanded/collapsed per session while the app is open. */
const openBySession = new Map<string, boolean>();

function Ring({ done, total }: { done: number; total: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const p = total ? done / total : 0;
  return (
    <svg className="ts-ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r={r} className="ts-ring-track" />
      <circle cx="9" cy="9" r={r} className="ts-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - p)} transform="rotate(-90 9 9)" />
    </svg>
  );
}

/** One slim row of progress over the composer; opens into the checklist. */
export function TaskStrip({ sessionId, todos, running }: { sessionId: string; todos: Todo[]; running: boolean }) {
  const [open, setOpenState] = useState(() => openBySession.get(sessionId) ?? false);
  const setOpen = (v: boolean) => {
    openBySession.set(sessionId, v);
    setOpenState(v);
  };
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending');
  // "Running the tests" only while the agent is at it: a turn that stopped halfway names the task.
  const label = current ? (current.status === 'in_progress' && running ? (current.activeForm ?? current.content) : current.content) : 'All tasks done';
  const listId = `tasks-${sessionId}`;

  return (
    <section className="ts glass-card" data-spot data-open={open || undefined}>
      <button type="button" className="ts-row" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        <Ring done={done} total={todos.length} />
        <span className="ts-count num">
          {done} of {todos.length}
        </span>
        <span key={label} className={running && current?.status === 'in_progress' ? 'ts-label truncate shimmer' : 'ts-label truncate'}>
          {label}
        </span>
        <Icon name="caret-up" size={12} className="ts-caret" />
      </button>
      <Collapse open={open}>
        <ul className="ts-list scroll" id={listId}>
          {todos.map((t, i) => (
            <li key={t.id ?? i} className="ts-item" data-status={t.status}>
              <span className="ts-mark" aria-hidden>
                {t.status === 'completed' ? <Icon name="check" size={11} /> : t.status === 'in_progress' ? <Spinner size={10} active={running} label={null} /> : <i />}
              </span>
              <span className="ts-text">{t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}</span>
              <span className="sr-only">{t.status === 'completed' ? 'Done' : t.status === 'in_progress' ? 'In progress' : 'Pending'}</span>
            </li>
          ))}
        </ul>
      </Collapse>
    </section>
  );
}
