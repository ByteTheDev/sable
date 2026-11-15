import type { ReactNode } from 'react';
import { useStore } from '@/state/store';
import { Kbd } from '@/ui';

interface Item {
  label: string;
  keys: ReactNode;
}

const k = (combo: string) => <Kbd combo={combo} />;

export function Shortcuts() {
  const sendWithEnter = useStore((s) => s.settings.sendWithEnter);

  const groups: { title: string; items: Item[] }[] = [
    {
      title: 'General',
      items: [
        { label: 'Search and commands', keys: k('mod+k') },
        { label: 'New session', keys: k('mod+shift+o') },
        { label: 'Open a folder', keys: k('mod+o') },
        { label: 'Show or hide the sidebar', keys: k('mod+b') },
        { label: 'Show or hide the panel', keys: k('mod+j') },
        { label: 'Settings', keys: k('mod+,') },
      ],
    },
    {
      title: 'Composer',
      items: [
        { label: 'Send', keys: k(sendWithEnter ? 'enter' : 'mod+enter') },
        { label: 'New line', keys: k(sendWithEnter ? 'shift+enter' : 'enter') },
        { label: 'Switch permission mode', keys: k('shift+tab') },
        { label: 'Commands and skills', keys: k('/') },
        { label: 'Mention a file', keys: k('@') },
        { label: 'Run a shell command', keys: k('!') },
        { label: 'Recall your last message', keys: k('up') },
        { label: 'Accept the suggestion', keys: k('tab') },
        { label: 'Focus the composer', keys: k('mod+l') },
      ],
    },
    {
      title: 'Session',
      items: [{ label: 'Stop the agent', keys: k('esc') }],
    },
    {
      title: 'Prompts from the agent',
      items: [
        {
          label: 'Choose an option',
          keys: (
            <span className="kbd-range">
              {k('1')}
              <span className="faint">to</span>
              {k('3')}
            </span>
          ),
        },
        { label: 'Confirm', keys: k('enter') },
        { label: 'Decline', keys: k('esc') },
      ],
    },
  ];

  const render = (g: (typeof groups)[number]) => (
    <section key={g.title} className="set-group">
      <header className="set-group-head">
        <h3 className="set-group-title">{g.title}</h3>
      </header>
      <div className="card set-card">
        {g.items.map((it) => (
          <div key={it.label} className="key-row">
            <span className="key-label">{it.label}</span>
            {it.keys}
          </div>
        ))}
      </div>
    </section>
  );

  // Two balanced columns: the composer's long list on its own side.
  return (
    <div className="keys-grid">
      <div className="set-stack">{[groups[0], groups[2], groups[3]].map(render)}</div>
      <div className="set-stack">{render(groups[1])}</div>
    </div>
  );
}
