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
        { label: 'Everything waiting on you', keys: k('mod+i') },
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
        { label: 'Earlier messages of yours', keys: k('up') },
        { label: 'Accept the suggestion', keys: k('tab') },
        { label: 'Focus the composer', keys: k('mod+l') },
      ],
    },
    {
      title: 'Session',
      items: [
        { label: 'Stop the agent', keys: k('esc') },
        { label: 'Find in conversation', keys: k('mod+f') },
        {
          label: 'Jump between your messages',
          keys: (
            <span className="kbd-range">
              {k('alt+up')}
              {k('down')}
            </span>
          ),
        },
        {
          label: 'Back to the last session',
          // Ctrl on every platform (not the platform's command key).
          keys: (
            <span className="kbds">
              <kbd className="kbd">Ctrl</kbd>
              <kbd className="kbd">Tab</kbd>
            </span>
          ),
        },
        {
          label: 'Panel tabs',
          keys: (
            <span className="kbd-range">
              {k('alt+1')}
              <span className="faint">to</span>
              {k('7')}
            </span>
          ),
        },
      ],
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
    {
      title: 'Waiting on you',
      items: [
        { label: 'Allow', keys: k('enter') },
        { label: 'Always allow', keys: k('shift+enter') },
        { label: 'Deny', keys: k('d') },
        {
          label: 'Next and previous',
          keys: (
            <span className="kbd-range">
              {k('j')}
              {k('k')}
            </span>
          ),
        },
        { label: 'Open the chat', keys: k('o') },
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

  // Two balanced columns: the app, the session and the deck on one side, the composer and the prompts on the other.
  return (
    <div className="keys-grid">
      <div className="set-stack">{[groups[0], groups[2], groups[4]].map(render)}</div>
      <div className="set-stack">{[groups[1], groups[3]].map(render)}</div>
    </div>
  );
}
