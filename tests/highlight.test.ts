import { expect, it } from 'vitest';
import type { Capabilities } from '../shared/protocol';
import { expandCommand, knownTokens, mentionRows } from '../src/features/composer/commands';
import { fileIcon } from '../src/features/composer/file-icon';
import { tokenize } from '../src/features/composer/Highlight';
it('tok', () => {
  const k = { commands: new Set(['review']), skills: new Set(['deploy']), dollar: true, shell: false };
  const r = tokenize('/review @a/b.ts, and @README.md. $deploy, $nope @x', k).filter((p) => p.kind).map((p) => p.text);
  expect(r).toEqual(['/review', '@a/b.ts', '@README.md', '$deploy', '@x']);
  expect(tokenize('!ls', { ...k, shell: true })).toEqual([{ text: '!', kind: 'shell' }, { text: 'ls', kind: undefined }]);
  expect(tokenize('/unknown x', k).some((p) => p.kind)).toBe(false);
});

const caps = (over: Partial<Capabilities>): Capabilities =>
  ({ models: [], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '/', features: {}, ...over }) as Capabilities;

it('short names of plugin commands and skills count as tokens and go out in full', () => {
  const claude = caps({
    commands: [
      { name: 'compact', description: '', kind: 'builtin' },
      { name: 'cinetic:cinetic', description: '', kind: 'skill' },
      { name: 'a:deploy', description: '', kind: 'skill' },
      { name: 'b:deploy', description: '', kind: 'skill' },
    ],
    skills: [
      { name: 'cinetic:cinetic', description: '' },
      { name: 'a:deploy', description: '' },
      { name: 'b:deploy', description: '' },
    ],
  });
  const known = { ...knownTokens(claude, 's1'), shell: false };
  expect(tokenize('/cinetic make a sting', known)[0]).toEqual({ text: '/cinetic', kind: 'command' });
  expect(tokenize('/deploy now', known).some((p) => p.kind)).toBe(false);

  expect(expandCommand('/cinetic make a sting', claude)).toBe('/cinetic:cinetic make a sting');
  expect(expandCommand('/cinetic', claude)).toBe('/cinetic:cinetic');
  expect(expandCommand('/cinetic:cinetic go', claude)).toBe('/cinetic:cinetic go');
  expect(expandCommand('/compact', claude)).toBe('/compact');
  expect(expandCommand('/deploy', claude)).toBe('/deploy');
  expect(expandCommand('see /cinetic', claude)).toBe('see /cinetic');

  const codex = caps({ skillTrigger: '$', skills: [{ name: 'pdf:pdf', description: '' }] });
  const k2 = { ...knownTokens(codex, 's1'), shell: false };
  expect(tokenize('use $pdf here, costs $20', k2).filter((p) => p.kind).map((p) => p.text)).toEqual(['$pdf']);
});

it('mentions list files with their type and the agent\'s sub-agents', () => {
  const files = [
    { path: '/r/src/a.ts', rel: 'src/a.ts', dir: false },
    { path: '/r/src', rel: 'src', dir: true },
  ];
  const withAgents = caps({ agents: [{ name: 'Explore', description: '' }, { name: 'p:code-reviewer', description: '' }] });
  const rows = mentionRows(files, '', withAgents);
  expect(rows.map((r) => [r.kind, r.label, r.value, r.icon, r.group])).toEqual([
    ['file', 'a.ts', 'src/a.ts', 'file-ts', 'Files'],
    ['dir', 'src', 'src/', 'folder', 'Files'],
    ['agent', 'Explore', 'agent-Explore', 'robot', 'Agents'],
    ['agent', 'code-reviewer', 'agent-p:code-reviewer', 'robot', 'Agents'],
  ]);
  expect(mentionRows(files, 'agent-exp', withAgents).filter((r) => r.kind === 'agent').map((r) => r.label)).toEqual(['Explore']);
  expect(mentionRows(files, 'src/', withAgents).some((r) => r.kind === 'agent')).toBe(false);
  expect(mentionRows(files, '', caps({})).every((r) => !r.group)).toBe(true);
  expect([fileIcon('README.md'), fileIcon('pnpm-lock.yaml'), fileIcon('.env.local'), fileIcon('notes'), fileIcon('App.TSX')]).toEqual(['file-md', 'file-lock', 'file-ini', 'file', 'file-tsx']);
});
