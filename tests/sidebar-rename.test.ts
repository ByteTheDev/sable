import { afterEach, describe, expect, it, vi } from 'vitest';
import { toggleCollapsed, unfoldKeys } from '@/features/sidebar/groups';
import { cleanName, editStep, focusAfterMenu, holdFocus, movesFocus, onCloseAutoFocus } from '@/features/sidebar/rename';

describe('sidebar folder toggle', () => {
  it('flips on every call, however quick: an even number of clicks ends where it began', () => {
    let s = new Set<string>(['other']);
    const seen: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      s = toggleCollapsed(s, 'app');
      seen.push(s.has('app'));
    }
    expect(seen).toEqual([true, false, true, false]);
    expect([...s]).toEqual(['other']);
  });

  it('never changes the set it was given', () => {
    const prev = new Set(['app']);
    const next = toggleCollapsed(prev, 'app');
    expect(prev.has('app')).toBe(true);
    expect(next.has('app')).toBe(false);
  });

  it('unfolds the folders of an opened session, the same set when they are open already', () => {
    const prev = new Set(['app', 'group:1', 'other']);
    const next = unfoldKeys(prev, ['app', 'group:1']);
    expect([...next]).toEqual(['other']);
    expect(unfoldKeys(next, ['app'])).toBe(next);
  });
});

describe('sidebar rename', () => {
  it('ends on Enter (keeping the name) and Escape (the old one), focus back to the row', () => {
    expect(editStep({ type: 'key', key: 'Enter' })).toEqual({ end: true, save: true, back: true });
    expect(editStep({ type: 'key', key: 'Escape' })).toEqual({ end: true, save: false, back: true });
    expect(editStep({ type: 'key', key: 'a' })).toEqual({ end: false });
  });

  it('keeps the name on a press outside (or a right press on its row, for the menu), and leaves focus to the press', () => {
    expect(editStep({ type: 'press', at: 'outside', primary: true })).toEqual({ end: true, save: true, back: false });
    expect(editStep({ type: 'press', at: 'outside', primary: false })).toEqual({ end: true, save: true, back: false });
    expect(editStep({ type: 'press', at: 'row', primary: false })).toEqual({ end: true, save: true, back: false });
    expect(editStep({ type: 'press', at: 'field', primary: false })).toEqual({ end: false });
  });

  it('stays open on a press on the field, beside it on its own row, or on the resize edge', () => {
    expect(editStep({ type: 'press', at: 'field', primary: true })).toEqual({ end: false });
    expect(editStep({ type: 'press', at: 'row', primary: true })).toEqual({ end: false, hold: 'press' });
    expect(editStep({ type: 'press', at: 'edge', primary: true })).toEqual({ end: false });
  });

  it('stays open when focus goes nowhere (the window, a moved row), into the closing menu, or to what the app focused on its own', () => {
    expect(editStep({ type: 'blur', to: 'nowhere' })).toEqual({ end: false, hold: 'focus' });
    expect(editStep({ type: 'blur', to: 'menu' })).toEqual({ end: false, hold: 'focus' });
    expect(editStep({ type: 'blur', to: 'taken' })).toEqual({ end: false, hold: 'focus' });
  });

  it('keeps the name when the person moves on to another control', () => {
    expect(editStep({ type: 'blur', to: 'control' })).toEqual({ end: true, save: true, back: false });
  });

  it('tells keys that move focus on purpose from typing', () => {
    const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => movesFocus({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    expect(k('Tab')).toBe(true);
    expect(k('k', { ctrlKey: true })).toBe(true);
    expect(k('l', { metaKey: true })).toBe(true);
    expect(k('F6')).toBe(true);
    expect(k('a')).toBe(false);
    expect(k('F')).toBe(false);
    expect(k('Backspace')).toBe(false);
    expect(k('ArrowLeft')).toBe(false);
  });

  it('keeps names tidy', () => {
    expect(cleanName('  Client   work \n')).toBe('Client work');
    expect(cleanName('   ')).toBe('');
  });
});

describe('sidebar rename focus after a menu', () => {
  afterEach(() => vi.useRealTimers());

  it('focuses at once when no menu asked for the field', () => {
    const focus = vi.fn();
    focusAfterMenu(focus);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('a field from a menu focuses at once, in the frame it appears (no dead field while the menu fades)', () => {
    const rename = vi.fn();
    holdFocus(rename)();
    expect(rename).toHaveBeenCalledTimes(1);
    const focus = vi.fn();
    const keep = vi.fn();
    focusAfterMenu(focus, keep);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(keep).not.toHaveBeenCalled();
    // The menu's close: Radix must not focus the trigger; the field keeps (or gets back) its focus.
    const e = { preventDefault: vi.fn() };
    onCloseAutoFocus(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(keep).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    // The next menu that closes on its own hands focus back to its trigger as usual.
    const next = { preventDefault: vi.fn() };
    onCloseAutoFocus(next);
    expect(next.preventDefault).not.toHaveBeenCalled();
  });

  it('a field that went away before the close is left alone; a close that never comes is forgotten', () => {
    vi.useFakeTimers();
    holdFocus(() => {})();
    const keepGone = vi.fn();
    focusAfterMenu(() => {}, keepGone)();
    onCloseAutoFocus({ preventDefault() {} });
    expect(keepGone).not.toHaveBeenCalled();

    holdFocus(() => {})();
    const keep = vi.fn();
    focusAfterMenu(() => {}, keep, 600);
    vi.advanceTimersByTime(600);
    // Nothing left waiting: the next menu's close returns focus to its own trigger.
    const next = { preventDefault: vi.fn() };
    onCloseAutoFocus(next);
    expect(next.preventDefault).not.toHaveBeenCalled();
    expect(keep).not.toHaveBeenCalled();
  });
});

describe('sidebar rename: the switch from name to field is one step', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the menu Rename came from is made inert as it closes, so nothing in it can take the field\'s focus', () => {
    const menus = [{ inert: false }, { inert: false }];
    vi.stubGlobal('document', { querySelectorAll: (sel: string) => (sel === '.side-pop' ? menus : []) });
    const rename = vi.fn(() => expect(menus.every((m) => m.inert)).toBe(true));
    holdFocus(rename)();
    expect(rename).toHaveBeenCalledTimes(1);
    onCloseAutoFocus({ preventDefault() {} });
  });

  it("a renamed row keeps its menu's trigger in place (hidden, not removed), so the closing menu never jumps", async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../src/features/sidebar/sidebar.css', import.meta.url), 'utf8');
    const rule = (sel: string) => {
      const at = css.indexOf(`${sel} {`);
      expect(at, sel).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf('}', at));
    };
    // display: none took the "…" out of layout: the menu fading out followed it to the window's corner.
    for (const sel of ['.sgroup-head[data-renaming] .sgroup-tools', '.srow-end[hidden]']) {
      expect(rule(sel)).not.toMatch(/display:\s*none/);
      expect(rule(sel)).toMatch(/visibility:\s*hidden/);
    }
  });
});
