import { useMemo, useState } from 'react';
import { PROVIDER_NAME } from '@/art/Logo';
import { Icon } from '@/icons';
import { modelNameById } from '@/lib/models';
import { useStore } from '@/state/store';
import { Card, Empty, SearchField, Skeleton, useContextTarget, useProviderCaps, Scope } from './parts';
import { rank, UseList, type UseItem } from './UseList';

export function Agents() {
  const { provider, cwd, sessionId } = useContextTarget();
  const caps = useProviderCaps(provider, cwd, sessionId);
  const [query, setQuery] = useState('');
  // What the agent said about its own setup in this run (Codex: unknown config keys), once, quietly.
  const warnings = useStore((s) => s.providers[provider]?.warnings);

  const agents = useMemo<UseItem[]>(
    () =>
      (caps?.agents ?? []).map((a) => ({
        key: a.name,
        title: a.name,
        description: a.description,
        // An alias ("sonnet") or an id reads as the model's name, as everywhere else.
        meta: a.model && a.model !== 'inherit' ? modelNameById(a.model, caps?.models) : undefined,
        // Sub-agents are not slash commands: ask for one by name.
        insert: `Use the ${a.name} agent to `,
      })),
    [caps],
  );
  const shown = rank(agents, query);

  return (
    <div className="set-stack">
      <div className="set-toolbar">
        {agents.length > 5 ? <SearchField value={query} onChange={setQuery} placeholder="Search agents" count={shown.length} /> : <span className="grow" />}
        <Scope provider={provider} cwd={cwd} />
      </div>
      {!caps ? (
        <Card>
          <Skeleton rows={3} />
        </Card>
      ) : !agents.length ? (
        <Card>
          <Empty>{PROVIDER_NAME[provider]} reported no sub-agents here.</Empty>
        </Card>
      ) : !shown.length ? (
        <Card>
          <Empty>No agent matches “{query}”.</Empty>
        </Card>
      ) : (
        <UseList items={shown} icon="robot" />
      )}
      {warnings?.map((w) => (
        <p key={w.text} className="set-foot-note set-agent-warning">
          <Icon name="info" size={14} />
          <span title={w.detail}>
            {w.text}
            {w.detail && <span className="set-agent-warning-detail">{w.detail}</span>}
          </span>
        </p>
      ))}
    </div>
  );
}
