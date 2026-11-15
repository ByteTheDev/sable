import { expect, it } from 'vitest';
import { tokenize } from '../src/features/composer/Highlight';
it('tok', () => {
  const k = { commands: new Set(['review']), skills: new Set(['deploy']), dollar: true, shell: false };
  const r = tokenize('/review @a/b.ts, and @README.md. $deploy, $nope @x', k).filter((p) => p.kind).map((p) => p.text);
  expect(r).toEqual(['/review', '@a/b.ts', '@README.md', '$deploy', '@x']);
  expect(tokenize('!ls', { ...k, shell: true })).toEqual([{ text: '!', kind: 'shell' }, { text: 'ls', kind: undefined }]);
  expect(tokenize('/unknown x', k).some((p) => p.kind)).toBe(false);
});
