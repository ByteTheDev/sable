import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '@/components/Markdown';
import { FileLinksProvider } from '@/lib/file-links';

const LINKS = { files: { 'src/app.ts': '/work/src/app.ts' }, cwd: '/work' };
const linked = (text: string, streaming = false) => renderToStaticMarkup(createElement(FileLinksProvider, { value: LINKS, children: createElement(Markdown, { text, streaming }) }));
const html = (text: string, streaming = false) => renderToStaticMarkup(createElement(Markdown, { text, streaming }));

describe('Markdown', () => {
  it('renders GitHub alerts as a callout with the kind named, the marker gone', () => {
    const out = html('> [!NOTE]\n> The key is read from `.env` on start.');
    expect(out).toContain('class="md-callout"');
    expect(out).toContain('data-kind="note"');
    expect(out).toContain('>Note</div>');
    expect(out).not.toContain('[!NOTE]');
    expect(out).not.toMatch(/<p><br\/?>/);
    expect(out).toContain('<code class="md-code">.env</code>');
    // A marker with words on its own line, and the other kinds.
    expect(html('> [!WARNING] Careful\n> with this')).toContain('>Warning</div>');
    expect(html('> [!TIP]\n> one')).toContain('data-kind="tip"');
  });

  it('keeps a plain quote a quote', () => {
    const out = html('> Every request costs one lookup.');
    expect(out).toContain('<blockquote>');
    expect(out).not.toContain('md-callout');
  });

  it('turns inline code that names a real file into a chip, and leaves other code alone', () => {
    const out = linked('See `src/app.ts` and `npm test`.');
    expect(out).toContain('class="md-fileref"');
    expect(out).toContain('<span class="md-fileref-dir">src/</span><span class="md-fileref-name">app.ts</span>');
    expect(out).toContain('title="/work/src/app.ts"');
    expect(out).toContain('<code class="md-code">npm test</code>');
  });

  it('keeps streamed text plain: no chips while it is written', () => {
    const out = linked('See `src/app.ts` now', true);
    expect(out).not.toContain('md-fileref');
    expect(out).toContain('<code class="md-code">src/app.ts</code>');
  });
});
