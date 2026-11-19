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
      const body = l === 'diff' || l === 'patch' ? diffLines(text) : esc(text);
      // A named language heads the block (its copy key beside it); a nameless block keeps the key in its corner.
      const head = l && /^[\w+#.-]{1,20}$/.test(l) ? `<div class="md-code-head"><span>${esc(l)}</span></div>` : '';
      return `<div class="md-code${head ? ' md-code-named' : ''}">${head}<pre class="md-pre no-drag"><code>${body}</code></pre><button type="button" class="md-copy" aria-label="Copy">${COPY}</button></div>`;
    },
  },
});

// Phosphor's Copy (regular), drawn inline in the rendered HTML.
const COPY =
  '<svg viewBox="0 0 256 256" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>';

/** Diff lines with their colour: additions green, removals red, hunk headers dim. */
export function diffLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const c = line.startsWith('+') && !line.startsWith('+++') ? 'dl-add' : line.startsWith('-') && !line.startsWith('---') ? 'dl-del' : line.startsWith('@@') ? 'dl-hunk' : '';
      return c ? `<span class="${c}">${esc(line)}</span>` : esc(line);
    })
    .join('\n');
}

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
