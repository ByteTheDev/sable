import { Marked, type Tokens } from 'marked';

/**
 * Markdown for answers. Raw HTML is shown as text (answers come from agents: nothing in them may
 * run in the app that holds the desktop's token); links open outside the app; widget and mermaid
 * blocks become a line pointing to the desktop.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const safeHref = (href: string) => (/^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : '');

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return esc(text);
    },
    link({ href, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      const h = safeHref(href);
      return h ? `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : `<span class="md-link">${inner}</span>`;
    },
    image({ href, text }: Tokens.Image) {
      const h = safeHref(href);
      return h ? `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(text || 'Image')}</a>` : esc(text || '');
    },
    code({ text, lang }: Tokens.Code) {
      const l = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
      if (l === 'widget' || l === 'mermaid') return `<div class="md-widget">${l === 'mermaid' ? 'Diagram' : 'Widget'} <span>Open on the desktop to see it</span></div>`;
      return `<pre class="md-pre"><code>${esc(text)}</code></pre>`;
    },
  },
});

const cache = new Map<string, string>();

export function renderMarkdown(text: string, streaming = false): string {
  if (!streaming) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
  }
  let html: string;
  try {
    html = md.parse(text, { async: false }) as string;
  } catch {
    html = `<p>${esc(text)}</p>`;
  }
  if (!streaming) {
    if (cache.size > 300) cache.clear();
    cache.set(text, html);
  }
  return html;
}
