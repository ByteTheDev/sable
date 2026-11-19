import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TextItem, TimelineItem } from '../shared/protocol';
import { SessionFiles, SMALL_BASE, TAIL_MAX, type SessionSave } from '../server/core/session-file';
import { SessionRuntime } from '../server/core/runtime';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sable-session-file-'));
  dirs.push(dir);
  const pathOf = (id: string) => path.join(dir, `${id}.json`);
  return { dir, pathOf, files: new SessionFiles(pathOf), tail: (id: string) => path.join(dir, `${id}.tail.json`) };
}

let n = 0;
const text = (t: string, id = `i${n++}`): TextItem => ({ id, type: 'text', ts: 1, text: t }) as TextItem;
/** A timeline bigger than SMALL_BASE, so the base/tail rule applies. */
const big = () => [text('x'.repeat(SMALL_BASE + 1024), 'big'), text('a', 'a'), text('b', 'b')];
const save = (items: TimelineItem[], dirty: SessionSave['dirty']): (() => SessionSave) => () => ({ items, todos: [], queue: [], dirty });

describe('session files: a base and a small tail', () => {
  it('writes a small timeline whole, in the same shape as before', async () => {
    const { files, pathOf, tail } = setup();
    const items = [text('hello', 'h')];
    await files.save('s', save(items, 'all'));
    const raw = JSON.parse(readFileSync(pathOf('s'), 'utf8'));
    expect(raw.items).toEqual(items);
    expect(raw.todos).toEqual([]);
    expect(existsSync(tail('s'))).toBe(false);
    expect(new SessionFiles(pathOf).load('s').items).toEqual(items);
  });

  it('reads a file written before the base had a generation', () => {
    const { pathOf } = setup();
    writeFileSync(pathOf('old'), JSON.stringify({ items: [text('old', 'o')], todos: [{ content: 't', status: 'pending' }] }));
    const f = new SessionFiles(pathOf).load('old');
    expect(f.items.map((i) => i.id)).toEqual(['o']);
    expect(f.todos).toHaveLength(1);
  });

  it('writes only the tail while a long chat grows, and reads base and tail together', async () => {
    const { files, pathOf, tail } = setup();
    const items = big();
    await files.save('s', save(items, 'all'));
    const baseBefore = readFileSync(pathOf('s'), 'utf8');
    const mtime = statSync(pathOf('s')).mtimeMs;

    // A new answer streams in after the base.
    const answer = text('Hel', 'ans');
    items.push(answer);
    await files.save('s', save(items, new Set(['ans'])));
    answer.text += 'lo there';
    await files.save('s', save(items, new Set(['ans'])));

    expect(readFileSync(pathOf('s'), 'utf8')).toBe(baseBefore);
    expect(statSync(pathOf('s')).mtimeMs).toBe(mtime);
    const t = JSON.parse(readFileSync(tail('s'), 'utf8'));
    expect(t.items).toEqual([answer]);

    const back = new SessionFiles(pathOf).load('s');
    expect(back.items.map((i) => i.id)).toEqual(['big', 'a', 'b', 'ans']);
    expect((back.items[3] as TextItem).text).toBe('Hello there');
  });

  it('writes the base again when one of its items changes, moves or goes, and drops the tail', async () => {
    const { files, pathOf, tail } = setup();
    const items = big();
    await files.save('s', save(items, 'all'));
    items.push(text('new', 'n'));
    await files.save('s', save(items, new Set(['n'])));
    expect(existsSync(tail('s'))).toBe(true);

    // A late patch to an old step.
    (items[1] as TextItem).text = 'a, patched';
    await files.save('s', save(items, new Set(['a'])));
    expect(existsSync(tail('s'))).toBe(false);
    let raw = JSON.parse(readFileSync(pathOf('s'), 'utf8'));
    expect(raw.gen).toBe(2);
    expect(raw.items.map((i: TimelineItem) => i.id)).toEqual(['big', 'a', 'b', 'n']);
    expect(raw.items[1].text).toBe('a, patched');

    // A rewind removes items.
    items.splice(2);
    await files.save('s', save(items, new Set()));
    raw = JSON.parse(readFileSync(pathOf('s'), 'utf8'));
    expect(raw.items.map((i: TimelineItem) => i.id)).toEqual(['big', 'a']);

    // A queued message moves from inside the base to the end.
    items.push(text('c', 'c'));
    await files.save('s', save(items, new Set(['c'])));
    const [moved] = items.splice(1, 1);
    items.push(moved);
    await files.save('s', save(items, new Set(['a'])));
    expect(new SessionFiles(pathOf).load('s').items.map((i) => i.id)).toEqual(['big', 'c', 'a']);
  });

  it('ignores a tail left from an older base (a crash between the new base and removing the tail)', async () => {
    const { files, pathOf, tail } = setup();
    const items = big();
    await files.save('s', save(items, 'all'));
    items.push(text('t1', 't1'));
    await files.save('s', save(items, new Set(['t1'])));
    const staleTail = readFileSync(tail('s'), 'utf8');
    // The base is written again (it now holds t1 and t2), then the old tail comes back.
    items.push(text('t2', 't2'));
    (items[0] as TextItem).text += '!';
    await files.save('s', save(items, new Set(['big', 't2'])));
    writeFileSync(tail('s'), staleTail);
    expect(new SessionFiles(pathOf).load('s').items.map((i) => i.id)).toEqual(['big', 'a', 'b', 't1', 't2']);
  });

  it('folds a tail that grew past its limit into the base', async () => {
    const { files, pathOf, tail } = setup();
    const items = big();
    await files.save('s', save(items, 'all'));
    items.push(text('y'.repeat(TAIL_MAX + 1), 'huge'));
    await files.save('s', save(items, new Set(['huge'])));
    expect(existsSync(tail('s'))).toBe(false);
    expect(JSON.parse(readFileSync(pathOf('s'), 'utf8')).items.map((i: TimelineItem) => i.id)).toEqual(['big', 'a', 'b', 'huge']);
  });

  it('runs saves for one session one after another and keeps the last state', async () => {
    const { files, pathOf } = setup();
    const items = big();
    const writes = [files.save('s', save(items.slice(), 'all'))];
    for (let i = 0; i < 5; i++) {
      items.push(text(`m${i}`, `m${i}`));
      writes.push(files.save('s', save(items.slice(), new Set([`m${i}`]))));
    }
    await Promise.all(writes);
    expect(new SessionFiles(pathOf).load('s').items.map((i) => i.id)).toEqual(['big', 'a', 'b', 'm0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('gets what changed from the runtime: added, streamed, patched and moved items', () => {
    const rt = new SessionRuntime({ id: 's' } as never, () => {}, () => {});
    rt.load([text('one', 'one')]);
    expect(rt.takeDirty()).toBe('all');
    rt.markSaved();
    const t = rt.add<TextItem>({ type: 'text', text: '' } as never);
    rt.delta(t.id, 'text', 'hi');
    rt.patch('one', { text: 'one!' } as never);
    expect([...(rt.takeDirty() as Set<string>)].sort()).toEqual([t.id, 'one'].sort());
    expect(rt.takeDirty()).toEqual(new Set());
    rt.reset([text('r', 'r')]);
    expect(rt.takeDirty()).toBe('all');
  });
});
