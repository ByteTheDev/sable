/** Claude Code tool calls and results normalized into Sable's display model. */
import { describe, expect, it } from 'vitest';
import { describeTool, flattenContent, mapResult, normalizeQuestions, normalizeTodos, peekPartialInput, previewDiff, shortCommand } from '../server/providers/claude-tools';

describe('describeTool', () => {
  it('Bash uses the description, else the first line of the command', () => {
    expect(describeTool('Bash', { command: 'npm test', description: 'Run the test suite' })).toEqual({
      kind: 'bash',
      title: 'Run the test suite',
      detail: { command: 'npm test', description: 'Run the test suite', background: false },
    });
    expect(describeTool('Bash', { command: 'git status\ngit diff', run_in_background: true })).toMatchObject({ title: 'git status', detail: { background: true } });
    expect(shortCommand('x'.repeat(100))).toHaveLength(71);
    expect(shortCommand(undefined)).toBe('Run command');
  });

  it('Read, Edit, Write name the file', () => {
    expect(describeTool('Read', { file_path: 'C:\\repo\\src\\session.ts', offset: 40, limit: 20 })).toEqual({
      kind: 'read',
      title: 'Read session.ts',
      detail: { path: 'C:\\repo\\src\\session.ts', range: [40, 60] },
    });
    expect(describeTool('Read', { file_path: '/repo/a.ts' }).detail.range).toBeUndefined();
    expect(describeTool('Edit', { file_path: '/repo/src/auth.ts', old_string: 'a', new_string: 'b' })).toEqual({
      kind: 'edit',
      title: 'Edit auth.ts',
      detail: { path: '/repo/src/auth.ts', oldText: 'a', newText: 'b' },
    });
    expect(describeTool('Write', { file_path: '/repo/notes.md', content: '# Notes' })).toEqual({
      kind: 'write',
      title: 'Write notes.md',
      detail: { path: '/repo/notes.md', content: '# Notes' },
    });
    expect(describeTool('Edit', {}).title).toBe('Edit file');
  });

  it('Glob, Grep, WebSearch and WebFetch', () => {
    expect(describeTool('Glob', { pattern: '**/*.ts', path: 'src' })).toEqual({ kind: 'glob', title: 'Find **/*.ts', detail: { pattern: '**/*.ts', path: 'src' } });
    expect(describeTool('Grep', { pattern: 'expiresAt', glob: '*.ts' })).toMatchObject({ kind: 'search', title: 'Search for “expiresAt”', detail: { pattern: 'expiresAt', glob: '*.ts' } });
    expect(describeTool('Grep', { pattern: 'a'.repeat(60) }).title).toBe(`Search for “${'a'.repeat(39)}…”`);
    expect(describeTool('WebSearch', { query: 'vite 8 release notes' })).toEqual({ kind: 'websearch', title: 'Search the web for “vite 8 release notes”', detail: { query: 'vite 8 release notes' } });
    expect(describeTool('WebSearch', {}).title).toBe('Search the web');
    expect(describeTool('WebFetch', { url: 'https://www.example.com/docs', prompt: 'Summarise' })).toEqual({
      kind: 'fetch',
      title: 'Fetch example.com',
      detail: { url: 'https://www.example.com/docs', description: 'Summarise' },
    });
    expect(describeTool('WebFetch', { url: 'not a url' }).title).toBe('Fetch not a url');
  });

  it('Agent, TodoWrite, AskUserQuestion, plans and skills', () => {
    expect(describeTool('Agent', { description: 'Audit auth tests', subagent_type: 'Explore', prompt: 'Look at tests/' })).toEqual({
      kind: 'agent',
      title: 'Audit auth tests',
      detail: { subagent: 'Explore', description: 'Audit auth tests', prompt: 'Look at tests/' },
    });
    expect(describeTool('Task', {}).title).toBe('Run a subagent');
    const todo = describeTool('TodoWrite', { todos: [{ content: 'Find checks', activeForm: 'Finding checks', status: 'in_progress' }] });
    expect(todo).toEqual({ kind: 'todo', title: 'Update the task list', detail: { todos: [{ id: undefined, content: 'Find checks', activeForm: 'Finding checks', status: 'in_progress' }] } });
    const q = describeTool('AskUserQuestion', { questions: [{ question: 'Which logger?', header: 'Logger', multiSelect: false, options: [{ label: 'pino', description: 'Fast' }] }] });
    expect(q.kind).toBe('question');
    expect(q.detail.questions).toEqual([{ question: 'Which logger?', header: 'Logger', multiSelect: false, options: [{ label: 'pino', description: 'Fast' }] }]);
    expect(describeTool('ExitPlanMode', { plan: '1. Do it' })).toEqual({ kind: 'plan', title: 'Propose a plan', detail: { plan: '1. Do it' } });
    expect(describeTool('Skill', { skill: 'pdf' }).title).toBe('Use the pdf skill');
    expect(describeTool('Skill', {}).title).toBe('Use the skill');
    expect(describeTool('TaskUpdate', { status: 'in_progress' }).title).toBe('Mark task in progress');
  });

  it('mcp__ tools split server and tool; unknown tools get spaced names', () => {
    expect(describeTool('mcp__github__create_issue', { title: 'x' })).toEqual({ kind: 'mcp', title: 'create issue', detail: { server: 'github', tool: 'create_issue' } });
    expect(describeTool('mcp__srv__ns__deep-tool')).toEqual({ kind: 'mcp', title: 'ns deep tool', detail: { server: 'srv', tool: 'ns__deep-tool' } });
    expect(describeTool('SlashCommand')).toEqual({ kind: 'other', title: 'Slash Command', detail: {} });
  });
});

describe('normalizers', () => {
  it('normalizeTodos coerces fields and unknown statuses', () => {
    expect(normalizeTodos(undefined)).toEqual([]);
    expect(normalizeTodos([{ subject: 'From TaskCreate', status: 'weird', id: 7 }, { content: 'Done', status: 'completed' }])).toEqual([
      { id: '7', content: 'From TaskCreate', activeForm: undefined, status: 'pending' },
      { id: undefined, content: 'Done', activeForm: undefined, status: 'completed' },
    ]);
  });

  it('normalizeQuestions tolerates missing options', () => {
    expect(normalizeQuestions('nope')).toEqual([]);
    expect(normalizeQuestions([{ question: 'Proceed?', multiSelect: 1 }])).toEqual([{ question: 'Proceed?', header: undefined, multiSelect: true, options: [] }]);
  });

  it('flattenContent joins text blocks and collects images', () => {
    expect(flattenContent('plain')).toEqual({ text: 'plain', images: [] });
    expect(
      flattenContent([
        { type: 'text', text: 'one' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: 'two' },
        { type: 'tool_reference' },
      ]),
    ).toEqual({ text: 'one\ntwo', images: ['data:image/png;base64,AAAA'] });
  });
});

describe('mapResult', () => {
  it('Bash: stdout, stderr and a zero exit code', () => {
    expect(mapResult('Bash', { command: 'npm test' }, { stdout: 'ok\n', stderr: 'warn', interrupted: false }, 'ok\n', false)).toEqual({ text: 'ok\n', stderr: 'warn', exitCode: 0 });
    expect(mapResult('Bash', {}, undefined, [{ type: 'text', text: 'from content' }], false)).toMatchObject({ text: 'from content', exitCode: 0 });
  });

  it('errors keep the text and pull out the exit code', () => {
    expect(mapResult('Bash', { command: 'npm test' }, undefined, 'Exit code 1\nFAIL tests/a.test.ts', true)).toEqual({
      isError: true,
      text: 'Exit code 1\nFAIL tests/a.test.ts',
      exitCode: 1,
    });
    expect(mapResult('Read', {}, 'File does not exist.', '', true)).toEqual({ isError: true, text: 'File does not exist.' });
  });

  it('Read: the structured file wins over the content text', () => {
    const r = mapResult('Read', { file_path: '/r/a.ts' }, { type: 'text', file: { filePath: '/r/a.ts', content: 'line', startLine: 1, numLines: 1, totalLines: 1 } }, '     1→line', false);
    expect(r).toEqual({ file: { path: '/r/a.ts', content: 'line', startLine: 1, numLines: 1, totalLines: 1 } });
    expect(mapResult('Read', {}, undefined, 'raw', false)).toEqual({ text: 'raw' });
  });

  it('Edit with a structuredPatch becomes a modified diff with counts', () => {
    const r = mapResult(
      'Edit',
      { file_path: '/r/src/auth.ts', old_string: 'a', new_string: 'b' },
      {
        filePath: '/r/src/auth.ts',
        structuredPatch: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [' keep', '-const ttl = 30;', '+const ttl = 15;', ' keep'] }],
      },
      'The file has been updated.',
      false,
    );
    expect(r.diff).toHaveLength(1);
    expect(r.diff![0]).toMatchObject({ path: '/r/src/auth.ts', status: 'modified', additions: 1, deletions: 1 });
    expect(r.diff![0].hunks[0]).toMatchObject({ oldStart: 10, newStart: 10 });
  });

  it('Write that creates a file becomes an added diff from its content', () => {
    const r = mapResult('Write', { file_path: '/r/notes.md', content: '# Notes\n\n- one\n' }, { type: 'create', filePath: '/r/notes.md', content: '# Notes\n\n- one\n', structuredPatch: [] }, '', false);
    expect(r.diff![0]).toMatchObject({ path: '/r/notes.md', status: 'added', additions: 3, deletions: 0 });
  });

  it('Edit without a structured result falls back to a diff from the input', () => {
    const r = mapResult('Edit', { file_path: '/r/a.ts', old_string: 'x = 1', new_string: 'x = 2' }, undefined, 'ok', false);
    expect(r.diff![0]).toMatchObject({ path: '/r/a.ts', additions: 1, deletions: 1 });
  });

  it('Glob and the three Grep modes', () => {
    expect(mapResult('Glob', {}, { filenames: ['a.ts', 'b.ts'], numFiles: 2, truncated: false }, '', false)).toEqual({ files: ['a.ts', 'b.ts'], count: 2 });
    expect(mapResult('Glob', {}, undefined, 'No files found', false)).toEqual({ count: 0, text: 'No files found' });
    // files_with_matches
    expect(mapResult('Grep', {}, { mode: 'files_with_matches', filenames: ['src/a.ts'], numFiles: 1 }, '', false)).toEqual({ files: ['src/a.ts'], count: 1 });
    // content
    expect(mapResult('Grep', {}, { mode: 'content', filenames: [], content: 'src/a.ts:3:expiresAt', numLines: 1 }, '', false)).toEqual({ text: 'src/a.ts:3:expiresAt', count: 1 });
    // count
    expect(mapResult('Grep', {}, { mode: 'count', filenames: [], content: 'src/a.ts:4', numMatches: 4, numFiles: 1 }, '', false)).toEqual({ text: 'src/a.ts:4', count: 4 });
    expect(mapResult('Grep', {}, undefined, 'No matches found', false)).toEqual({ count: 0, text: 'No matches found' });
  });

  it('WebSearch collects links; WebFetch keeps the result text', () => {
    const r = mapResult(
      'WebSearch',
      { query: 'vite' },
      { query: 'vite', results: [{ tool_use_id: 'x', content: [{ title: 'Vite', url: 'https://vite.dev' }, { url: 'https://github.com/vitejs/vite' }] }, 'Summary text'] },
      '',
      false,
    );
    expect(r).toEqual({ links: [{ title: 'Vite', url: 'https://vite.dev' }, { title: 'https://github.com/vitejs/vite', url: 'https://github.com/vitejs/vite' }], count: 2 });
    expect(mapResult('WebSearch', {}, {}, 'nothing', false)).toEqual({ text: 'nothing', count: 0 });
    expect(mapResult('WebFetch', { url: 'https://x.dev' }, { result: 'Page summary', code: 200 }, 'ignored', false)).toEqual({ text: 'Page summary' });
  });

  it('Agent reads its structured content; AskUserQuestion its answers; mcp tools their text', () => {
    expect(mapResult('Agent', {}, { content: [{ type: 'text', text: 'Found 2 gaps' }], totalToolUseCount: 4 }, '', false)).toEqual({ text: 'Found 2 gaps', agent: { steps: 4 } });
    expect(mapResult('AskUserQuestion', {}, { answers: { 'Which logger?': 'pino', 'Extras?': ['a', 'b'] } }, '', false)).toEqual({
      answers: { 'Which logger?': ['pino'], 'Extras?': ['a', 'b'] },
    });
    expect(mapResult('TodoWrite', {}, { newTodos: [] }, 'ok', false)).toEqual({});
    expect(mapResult('mcp__github__create_issue', {}, undefined, [{ type: 'text', text: 'Created #12' }], false)).toEqual({ text: 'Created #12' });
  });

  it('clips very long text', () => {
    const r = mapResult('Bash', {}, { stdout: 'x'.repeat(90_000) }, '', false);
    expect(r.text).toHaveLength(80_000);
    expect(r.truncated).toBe(true);
  });
});

describe('previewDiff', () => {
  it('Edit places the hunk at the line where the old text sits in the current file', () => {
    const file = 'one\ntwo\nconst ttl = 30;\nfour\n';
    const [d] = previewDiff('Edit', { file_path: '/r/a.ts', old_string: 'const ttl = 30;', new_string: 'const ttl = 15;' }, file)!;
    expect(d).toMatchObject({ path: '/r/a.ts', additions: 1, deletions: 1 });
    expect(d.hunks[0].oldStart).toBe(3);
  });

  it('Write against an existing file is a modification, without one an addition', () => {
    expect(previewDiff('Write', { file_path: '/r/n.md', content: 'new\n' }, 'old\n')![0]).toMatchObject({ status: 'modified', additions: 1, deletions: 1 });
    expect(previewDiff('Write', { file_path: '/r/n.md', content: 'new\n' })![0]).toMatchObject({ status: 'added', additions: 1 });
  });

  it('MultiEdit uses its edits: titled Edit, applied in order against the file, one hunk each without it', () => {
    const input = {
      file_path: '/r/a.ts',
      edits: [
        { old_string: 'const ttl = 30;', new_string: 'const ttl = 15;' },
        { old_string: 'ttl = 15', new_string: 'ttl = 10' },
        { old_string: 'four', new_string: 'FOUR' },
      ],
    };
    const view = describeTool('MultiEdit', input);
    expect(view).toMatchObject({ kind: 'edit', title: 'Edit a.ts', detail: { path: '/r/a.ts' } });
    expect(view.detail.oldText).toContain('const ttl = 30;');
    expect(view.detail.newText).toContain('FOUR');

    const file = 'one\ntwo\nconst ttl = 30;\nfour\n';
    const [whole] = previewDiff('MultiEdit', input, file)!;
    expect(whole).toMatchObject({ path: '/r/a.ts', additions: 2, deletions: 2 });
    expect(whole.hunks.flatMap((h) => h.lines)).toContain('+const ttl = 10;');

    const [loose] = previewDiff('MultiEdit', input)!;
    expect(loose.hunks).toHaveLength(3);
    expect(loose).toMatchObject({ status: 'modified', additions: 3, deletions: 3 });
    expect(previewDiff('MultiEdit', { file_path: '/r/a.ts' })).toBeUndefined();
  });

  it('other tools have no preview', () => {
    expect(previewDiff('Bash', { command: 'rm -rf x' })).toBeUndefined();
    expect(previewDiff('Edit', {})).toBeUndefined();
  });
});

describe('peekPartialInput', () => {
  it('reads finished string fields from incomplete JSON, unescaping them', () => {
    expect(peekPartialInput('{"file_path":"C:\\\\repo\\\\a.ts","old_str')).toEqual({ file_path: 'C:\\repo\\a.ts' });
    expect(peekPartialInput('{"command":"echo \\"hi\\"","description":"Say h')).toEqual({ command: 'echo "hi"' });
    expect(peekPartialInput('{"description":"Audit","subagent_type":"Explore","prompt":"long')).toEqual({ description: 'Audit', subagent_type: 'Explore' });
  });

  it('ignores fields that have not finished arriving', () => {
    expect(peekPartialInput('{"pattern":"exp')).toEqual({});
    expect(peekPartialInput('')).toEqual({});
  });
});
