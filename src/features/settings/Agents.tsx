import { useMemo, useState } from 'react';
import { PROVIDER_NAME } from '@/art/Logo';
import { baseName } from '@/lib/format';
import { Card, Empty, SearchField, Skeleton, useContextTarget, useProviderCaps } from './parts';
import { rank, UseList, type UseItem } from './UseList';

export function Agents() {
  const { provider, cwd, sessionId } = useContextTarget();
  const caps = useProviderCaps(provider, cwd, sessionId);
  const [query, setQuery] = useState('');

  const agents = useMemo<UseItem[]>(
    () =>
      (caps?.agents ?? []).map((a) => ({
        key: a.name,
        title: a.name,
        description: a.description,
        meta: a.model && a.model !== 'inherit' ? a.model : undefined,
        // Sub-agents are not slash commands: ask for one by name.
        insert: `Use the ${a.name} agent to `,
      })),
    [caps],
  );
  const shown = rank(agents, query);

  return (
    <div className="set-stack">
      <div className="set-toolbar">
        <span className="set-context">
          {PROVIDER_NAME[provider]}
          {cwd && <span className="faint"> in {baseName(cwd)}</span>}
        </span>
      </div>
      {agents.length > 5 && <SearchField value={query} onChange={setQuery} placeholder="Search agents" count={shown.length} />}
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
    </div>
  );
}
