import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Flood, HeightGuard, judgePrompt, MAX_FRAME_H, PROMPT_MAX, cleanPromptText, type PromptContext } from '@/features/genui/guard';
import { guessTitle, hasVisibleMarkup, isSvg, prepareCode, readPartialObject, slug, widgetSource } from '@/features/genui/partial';

describe('readPartialObject', () => {
  it('reads complete and incomplete string fields', () => {
    expect(readPartialObject('{"title":"Revenue","code":"<div>hi')).toEqual({
      title: { value: 'Revenue', complete: true },
      code: { value: '<div>hi', complete: false },
    });
  });

  it('decodes escapes, including ones split across chunks', () => {
    const full = JSON.stringify({ code: '<p class="a">tab\there\nline é 😀 \\ end</p>' });
    expect(readPartialObject(full).code).toEqual({ value: '<p class="a">tab\there\nline é 😀 \\ end</p>', complete: true });
    // Every prefix decodes to a prefix of the final value and never throws.
    const target = JSON.parse(full).code as string;
    for (let i = 0; i < full.length; i++) {
      const v = readPartialObject(full.slice(0, i)).code?.value ?? '';
      expect(target.startsWith(v)).toBe(true);
    }
  });

  it('skips non-string values and stops at garbage', () => {
    expect(readPartialObject('{"n": 3, "o": {"a": "}"}, "code": "x"}').code?.value).toBe('x');
    expect(readPartialObject('not json')).toEqual({});
    expect(readPartialObject(undefined)).toEqual({});
    expect(readPartialObject('{"title": "a", "code": ')).toEqual({ title: { value: 'a', complete: true } });
  });

  it('is not fooled by a key name inside a value', () => {
    const json = JSON.stringify({ title: 'say "code": "x"', code: '<b>real</b>' });
    expect(readPartialObject(json).code?.value).toBe('<b>real</b>');
    expect(readPartialObject(json.slice(0, 20)).code).toBeUndefined();
  });
});

describe('widgetSource', () => {
  it('prefers the complete input, falls back to the streaming text', () => {
    expect(widgetSource({ title: 'T', code: '<svg></svg>' }, '{"title":"x"', '')).toEqual({ title: 'T', code: '<svg></svg>', final: true });
    expect(widgetSource(undefined, '{"title":"Chart","code":"<div', 'Widget')).toEqual({ title: 'Chart', code: '<div', final: false });
    expect(widgetSource(undefined, '', 'Fallback')).toEqual({ title: 'Fallback', code: '', final: false });
  });
});

describe('prepareCode', () => {
  it('drops an unfinished tag, script and entity from a partial render', () => {
    expect(prepareCode('<div>a</div><span cla', false)).toBe('<div>a</div>');
    expect(prepareCode('<p>x</p><script>let a = 1', false)).toBe('<p>x</p>');
    expect(prepareCode('<p>x</p><script>a()</script><p>y', false)).toBe('<p>x</p><script>a()</script><p>y');
    expect(prepareCode('<p>Tom &am', false)).toBe('<p>Tom ');
  });

  it('keeps final code as it is, but capped', () => {
    expect(prepareCode('<p>x</p><span cla', true)).toBe('<p>x</p><span cla');
    expect(prepareCode('x'.repeat(400_000), true).length).toBe(300_000);
  });

  it('knows when partial markup has something to show', () => {
    expect(hasVisibleMarkup('<style>.a{color:red}</style>')).toBe(false);
    expect(hasVisibleMarkup('<style>.a{}</style><div class="a">')).toBe(false);
    expect(hasVisibleMarkup('<style>.a{}</style><h2>Title</h2>')).toBe(true);
    expect(hasVisibleMarkup('<svg><rect width="2"/>')).toBe(true);
  });
});

describe('titles and files', () => {
  it('guesses a title from the code', () => {
    expect(guessTitle('<div><h2>Latency <b>by</b> route</h2></div>')).toBe('Latency by route');
    expect(guessTitle('<svg viewBox="0 0 1 1"></svg>')).toBe('Diagram');
    expect(guessTitle('<div>x</div>')).toBe('Widget');
  });
  it('tells SVG from HTML and makes file names', () => {
    expect(isSvg('<svg viewBox="0 0 1 1"><rect/></svg>')).toBe(true);
    expect(isSvg('<div><svg></svg></div>')).toBe(false);
    expect(slug('Load test: relay-api at 1,500 rps')).toBe('load-test-relay-api-at-1-500-rps');
    expect(slug('!!!')).toBe('widget');
  });
});

describe('sendPrompt guard', () => {
  const base: PromptContext = {
    text: 'Go with option B',
    enabled: true,
    frameFocused: true,
    userActive: true,
    sessionBusy: false,
    promptOpen: false,
    inFlight: false,
    now: 10_000,
    lastSentAt: 0,
  };

  it('sends right after a click inside the frame', () => {
    expect(judgePrompt(base)).toEqual({ ok: true, text: 'Go with option B' });
  });

  it('refuses without a gesture in that frame', () => {
    expect(judgePrompt({ ...base, userActive: false })).toEqual({ ok: false, reason: 'no-gesture' });
    expect(judgePrompt({ ...base, frameFocused: false })).toEqual({ ok: false, reason: 'no-gesture' });
  });

  it('refuses while the agent works, while a prompt waits, and one at a time', () => {
    expect(judgePrompt({ ...base, sessionBusy: true })).toEqual({ ok: false, reason: 'busy' });
    expect(judgePrompt({ ...base, inFlight: true })).toEqual({ ok: false, reason: 'busy' });
    expect(judgePrompt({ ...base, promptOpen: true })).toEqual({ ok: false, reason: 'prompt-open' });
    expect(judgePrompt({ ...base, lastSentAt: 9_000 })).toEqual({ ok: false, reason: 'too-soon' });
    expect(judgePrompt({ ...base, lastSentAt: 8_000 }).ok).toBe(true);
  });

  it('refuses empty, oversized, non-string text and a disabled feature', () => {
    expect(judgePrompt({ ...base, text: '   ' })).toEqual({ ok: false, reason: 'empty' });
    expect(judgePrompt({ ...base, text: { toString: () => 'x' } })).toEqual({ ok: false, reason: 'empty' });
    expect(judgePrompt({ ...base, text: 'x'.repeat(PROMPT_MAX + 1) })).toEqual({ ok: false, reason: 'too-long' });
    expect(judgePrompt({ ...base, enabled: false })).toEqual({ ok: false, reason: 'disabled' });
  });

  it('strips control and direction characters', () => {
    expect(cleanPromptText('a\u0000b‮c\n\n\n\nd ')).toBe('abc\n\nd');
  });
});

describe('Flood', () => {
  it('allows a burst, then a steady rate, and stops a frame that keeps flooding', () => {
    const f = new Flood(60, 120, 1500, 10_000);
    let ok = 0;
    for (let i = 0; i < 800; i++) if (f.hit(1000) === 'ok') ok++;
    expect(ok).toBe(120);
    expect(f.hit(1000)).toBe('drop');
    expect(f.hit(2000)).toBe('ok');
    let last = '';
    for (let i = 0; i < 800; i++) last = f.hit(2000);
    expect(last).toBe('kill');
  });

  it('never starves unbudgeted messages (sizes, protocol steps) behind a flood of junk', () => {
    const f = new Flood(60, 120, 1500, 10_000);
    for (let i = 0; i < 800; i++) f.hit(1000);
    expect(f.hit(1000)).toBe('drop');
    expect(f.hit(1000, false)).toBe('ok');
  });
});

describe('HeightGuard', () => {
  it('clamps and ignores junk', () => {
    const g = new HeightGuard();
    expect(g.push(100000, 0, false)).toBe(MAX_FRAME_H);
    expect(g.push(-5, 0, false)).toBe(0);
    expect(g.push('300', 0, false)).toBeNull();
    expect(g.push(Number.NaN, 0, false)).toBeNull();
  });

  it('follows streaming growth, but freezes a finished widget that grows by itself', () => {
    const g = new HeightGuard(14, 3000);
    for (let i = 0; i < 40; i++) expect(g.push(100 + i * 20, i * 10, false)).not.toBeNull();
    g.settle();
    let accepted = 0;
    for (let i = 0; i < 40; i++) if (g.push(1000 + i * 32, 1000 + i * 16, true) !== null) accepted++;
    expect(g.frozen).toBe(true);
    expect(accepted).toBe(14);
    // Shrinking is still followed (it cannot loop).
    expect(g.push(400, 2000, true)).toBe(400);
    expect(g.push(900, 2100, true)).toBeNull();
  });
});

describe('frame page', () => {
  const html = readFileSync(new URL('../public/widget-frame.html', import.meta.url), 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? '';

  it('allows no network at all', () => {
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toMatch(/img-src data: blob:;/);
    expect(csp).toMatch(/font-src data:;/);
    expect(csp).not.toMatch(/https?:|\*/);
  });

  it('runs the widget in a nested frame that is sandboxed without same-origin', () => {
    expect(html).toContain("f.setAttribute('sandbox', 'allow-scripts')");
    expect(html).not.toContain('allow-same-origin');
    expect(html).not.toMatch(/allow-(top-navigation|popups|forms|modals)/);
  });

  it('runs nothing in a partial render and accepts messages from the app only', () => {
    expect(html).toContain('if (!final) inert(t.content)');
    expect(html).toContain('if (e.source !== HOST) return;');
  });
});
