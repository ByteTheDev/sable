/**
 * Text fields grow with their words up to a height. Where the WebView sizes them itself
 * (`field-sizing: content`, Chrome 123 and later, set in CSS) nothing is measured here: setting the
 * height to auto and reading it back made the WebView lay out the whole conversation again on every
 * key (the thread shares the column with the prompt bar). Older WebViews still measure.
 */
export const autoSized = typeof CSS !== 'undefined' && !!CSS.supports?.('field-sizing', 'content');

export function fit(el: HTMLTextAreaElement | null | undefined, max: number) {
  if (!el || autoSized) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}
