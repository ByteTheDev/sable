import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeTab,
  closeTab,
  flushSoon,
  getLog,
  getPage,
  getTabs,
  logDropped,
  logLine,
  moveTab,
  onPages,
  openTab,
  reopenTab,
  selectTab,
  setPage,
  setPageSoon,
  SOON_MS,
  stepTab,
  TABS_MAX,
} from '@/features/rail/browser-store';

let n = 0;
const session = () => `s-tabs-${++n}`;

afterEach(() => {
  vi.useRealTimers();
});

describe('browser tabs', () => {
  it('starts with one tab that carries the session id, so older keys keep working', () => {
    const s = session();
    expect(getTabs(s).ids).toEqual([s]);
    expect(activeTab(s)).toBe(s);
    // The same snapshot until something changes (useSyncExternalStore needs that).
    expect(getTabs(s)).toBe(getTabs(s));
  });

  it('opens a tab at the end and brings it to the front, with its page set to load', () => {
    const s = session();
    setPage(s, { url: 'http://localhost:5173/' });
    const id = openTab(s, 'http://localhost:3000/')!;
    expect(getTabs(s).ids).toEqual([s, id]);
    expect(activeTab(s)).toBe(id);
    expect(getPage(id)).toMatchObject({ url: 'http://localhost:3000/', loading: true, history: ['http://localhost:3000/'], index: 0 });
    // The first tab's page is untouched.
    expect(getPage(s).url).toBe('http://localhost:5173/');
  });

  it('closing the tab in front hands over to its right neighbour, else its left', () => {
    const s = session();
    const b = openTab(s)!;
    const c = openTab(s)!;
    selectTab(s, b);
    closeTab(s, b);
    expect(getTabs(s).ids).toEqual([s, c]);
    expect(activeTab(s)).toBe(c);
    closeTab(s, c);
    expect(activeTab(s)).toBe(s);
  });

  it('closing a tab in the background keeps the one in front', () => {
    const s = session();
    const b = openTab(s)!;
    closeTab(s, s);
    expect(getTabs(s).ids).toEqual([b]);
    expect(activeTab(s)).toBe(b);
  });

  it('closing the last tab leaves one empty tab', () => {
    const s = session();
    setPage(s, { url: 'http://localhost:5173/' });
    closeTab(s, s);
    const t = getTabs(s);
    expect(t.ids).toHaveLength(1);
    expect(t.ids[0]).not.toBe(s);
    expect(getPage(t.active).url).toBe('');
  });

  it('a closed tab never comes back from late reports of its view', () => {
    const s = session();
    const b = openTab(s, 'http://localhost:3000/')!;
    closeTab(s, b);
    setPage(b, { title: 'late' });
    logLine(b, { level: 'error', text: 'late' });
    expect(getPage(b).url).toBe('');
    expect(getPage(b).title).toBe('');
    expect(getLog(b).lines).toHaveLength(0);
  });

  it('reopens the last closed page where it stood, with its title', () => {
    const s = session();
    setPage(s, { url: 'http://localhost:5173/', title: 'App' });
    const b = openTab(s, 'http://localhost:3000/')!;
    openTab(s);
    closeTab(s, s);
    expect(reopenTab(s)).toBeDefined();
    const t = getTabs(s);
    expect(t.ids.indexOf(t.active)).toBe(0);
    expect(getPage(t.active)).toMatchObject({ url: 'http://localhost:5173/', title: 'App' });
    expect(t.ids[1]).toBe(b);
    expect(t.closed).toHaveLength(0);
    expect(reopenTab(s)).toBeUndefined();
  });

  it('empty tabs are not remembered as closed', () => {
    const s = session();
    const b = openTab(s)!;
    closeTab(s, b);
    expect(getTabs(s).closed).toHaveLength(0);
  });

  it('moves a tab along the strip and steps through tabs with wrap-around', () => {
    const s = session();
    const b = openTab(s)!;
    const c = openTab(s)!;
    moveTab(s, c, 0);
    expect(getTabs(s).ids).toEqual([c, s, b]);
    moveTab(s, c, 99);
    expect(getTabs(s).ids).toEqual([s, b, c]);
    expect(activeTab(s)).toBe(c);
    stepTab(s, 1);
    expect(activeTab(s)).toBe(s);
    stepTab(s, -1);
    expect(activeTab(s)).toBe(c);
  });

  it(`stops at ${TABS_MAX} tabs`, () => {
    const s = session();
    for (let i = 1; i < TABS_MAX; i++) expect(openTab(s)).toBeDefined();
    expect(openTab(s)).toBeUndefined();
    expect(getTabs(s).ids).toHaveLength(TABS_MAX);
  });

  it('keeps each tab its own page and log', () => {
    const s = session();
    const b = openTab(s, 'http://localhost:3000/')!;
    logLine(s, { level: 'error', text: 'first' });
    logLine(b, { level: 'log', text: 'second' });
    expect(getLog(s).lines.map((l) => l.text)).toEqual(['first']);
    expect(getLog(b).lines.map((l) => l.text)).toEqual(['second']);
    expect(getLog(s).console).toHaveLength(1);
    expect(getLog(b).console).toHaveLength(0);
  });
});

describe('a chatty page', () => {
  it('gathers title and address changes into one update per beat', () => {
    vi.useFakeTimers();
    const s = session();
    let changes = 0;
    const off = onPages(() => changes++);
    for (let i = 0; i < 500; i++) setPageSoon(s, { title: `t${i}`, url: `http://localhost:5173/#${i}` });
    expect(changes).toBe(0);
    vi.advanceTimersByTime(SOON_MS);
    off();
    expect(changes).toBe(1);
    expect(getPage(s)).toMatchObject({ title: 't499', url: 'http://localhost:5173/#499' });
  });

  it('applies what was gathered at once when asked (before a new document)', () => {
    vi.useFakeTimers();
    const s = session();
    setPageSoon(s, { title: 'old' });
    flushSoon();
    expect(getPage(s).title).toBe('old');
  });

  it('keeps the log bounded and counts what the shell dropped', () => {
    const s = session();
    for (let i = 0; i < 1000; i++) logLine(s, { level: 'log', text: `line ${i}` });
    logDropped(s, 5000);
    const log = getLog(s);
    expect(log.lines.length).toBeLessThanOrEqual(200);
    expect(log.feed.length).toBeLessThanOrEqual(200);
    expect(log.moreLines).toBe(800 + 5000);
    expect(log.lines.at(-1)?.text).toBe('line 999');
  });

  it('cuts very long lines', () => {
    const s = session();
    logLine(s, { level: 'error', text: 'x'.repeat(100_000) });
    expect(getLog(s).lines[0].text.length).toBe(1000);
  });
});
