import { useMemo, useState } from 'react';
import { PROVIDER_NAME } from '@/art/Logo';
import { baseName } from '@/lib/format';
import { skillLabeller } from '@/lib/skills';
import { Card, Empty, SearchField, Skeleton, useContextTarget, useProviderCaps } from './parts';
import { rank, UseList, type UseItem } from './UseList';

export function Skills() {
  const { provider, cwd, sessionId } = useContextTarget();
  const caps = useProviderCaps(provider, cwd, sessionId);
  const [query, setQuery] = useState('');

  const { skills, custom, builtin } = useMemo(() => {
    const out = { skills: [] as UseItem[], custom: [] as UseItem[], builtin: [] as UseItem[] };
    if (!caps) return out;
    const trigger = caps.skillTrigger;
    const label = skillLabeller([...caps.skills.map((s) => s.name), ...caps.commands.map((c) => c.name)]);
    const seen = new Set<string>();
    const add = (name: string, description: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      out.skills.push({ key: `s:${name}`, title: `${trigger}${label(name)}`, description, insert: `${trigger}${label(name)} ` });
    };
    for (const sk of caps.skills) if (sk.enabled !== false) add(sk.name, sk.description);
    for (const c of caps.commands) if (c.kind === 'skill') add(c.name, c.description);
    for (const c of caps.commands) {
      if ((c.kind !== 'builtin' && c.kind !== 'command') || seen.has(c.name)) continue;
      seen.add(c.name);
      (c.kind === 'builtin' ? out.builtin : out.custom).push({
        key: `c:${c.name}`,
        title: `/${label(c.name)}${c.argumentHint ? ` ${c.argumentHint}` : ''}`,
        description: c.description,
        insert: `/${label(c.name)} `,
      });
    }
    return out;
  }, [caps]);

  const s = rank(skills, query);
  const cu = rank(custom, query);
  const bi = rank(builtin, query);
  const total = skills.length + custom.length + builtin.length;
  const shown = s.length + cu.length + bi.length;

  return (
    <div className="set-stack">
      <div className="set-toolbar">
        <span className="set-context">
          {PROVIDER_NAME[provider]}
          {cwd && <span className="faint"> in {baseName(cwd)}</span>}
        </span>
      </div>
      {caps && total > 0 && <SearchField value={query} onChange={setQuery} placeholder="Search skills and commands" count={shown} />}
      {!caps ? (
        <Card>
          <Skeleton rows={4} />
        </Card>
      ) : !total ? (
        <Card>
          <Empty>{PROVIDER_NAME[provider]} reported no skills or commands here.</Empty>
        </Card>
      ) : !shown ? (
        <Card>
          <Empty>Nothing matches “{query}”.</Empty>
        </Card>
      ) : (
        <>
          {s.length > 0 && <UseList title="Skills" count={s.length} items={s} icon="skill" />}
          {cu.length > 0 && <UseList title="Your commands" count={cu.length} items={cu} icon="prompt" />}
          {bi.length > 0 && <UseList title="Built-in commands" count={bi.length} items={bi} icon="command" />}
        </>
      )}
    </div>
  );
}
