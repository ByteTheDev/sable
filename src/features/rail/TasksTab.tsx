import type { CSSProperties } from 'react';
import type { Todo } from '@shared/protocol';
import { Ring } from '@/art/Logo';
import { Icon } from '@/icons';
import { useStore } from '@/state/store';

const NO_TODOS: Todo[] = [];

export function useOpenTaskCount(sessionId: string): number {
  return useStore((s) => (s.data[sessionId]?.todos ?? NO_TODOS).filter((t) => t.status !== 'completed').length);
}

/** The agent's task list for this session. Sub-agents have their own tab (Agents). */
export function TasksTab({ sessionId }: { sessionId: string }) {
  const todos = useStore((s) => s.data[sessionId]?.todos) ?? NO_TODOS;

  if (!todos.length) {
    return (
      <div className="rail-scroll scroll">
        <p className="rail-empty">No tasks in this session yet.</p>
      </div>
    );
  }

  const done = todos.filter((t) => t.status === 'completed').length;

  return (
    <div className="rail-col">
      <div className="rail-bar">
        <span className="rail-bar-title num">
          {done} of {todos.length} done
        </span>
        <span className="tk-progress meter" role="progressbar" aria-valuemin={0} aria-valuemax={todos.length} aria-valuenow={done} aria-label="Tasks done">
          <span className="meter-fill" style={{ '--p': done / todos.length } as CSSProperties} />
        </span>
      </div>
      <div className="rail-scroll scroll">
        <div className="rail-stack tk-stack">
          <section className="tk-section" aria-label="Tasks">
            <ol className="tk-list">
              {todos.map((t, i) => (
                <li key={t.id ?? i} className="tk-item" data-status={t.status}>
                  <span className="tk-mark" aria-hidden>
                    {t.status === 'completed' ? <Icon name="check" size={10} /> : t.status === 'in_progress' ? <Ring size={10} /> : null}
                  </span>
                  <span className="tk-text">{t.status === 'in_progress' ? <span className="shimmer">{t.activeForm || t.content}</span> : t.content}</span>
                  <span className="sr-only">{t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'in progress' : 'pending'}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
