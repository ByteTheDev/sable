import { forwardRef, memo, useMemo, type ReactNode } from 'react';
import type { Capabilities } from '@shared/protocol';
import { appCommandsFor } from './commands';

export type PillKind = 'command' | 'mention' | 'skill' | 'shell';

/** Quick test: does the text contain anything that could become a pill? Ordinary text skips all work. */
export const mayHavePills = (text: string) => text.startsWith('/') || text.startsWith('!') || text.includes('@') || text.includes('$');

/** Splits the draft into plain runs and recognised tokens. Exported for tests. */
export function tokenize(text: string, known: { commands: Set<string>; skills: Set<string>; dollar: boolean; shell: boolean }): { text: string; kind?: PillKind }[] {
  const out: { text: string; kind?: PillKind }[] = [];
  let i = 0;
  const push = (to: number, kind?: PillKind) => {
    if (to > i) out.push({ text: text.slice(i, to), kind });
    i = to;
  };
  if (known.shell && text.startsWith('!')) push(1, 'shell');
  else if (text.startsWith('/')) {
    const m = /^\/([\w:.-]+)/.exec(text);
    if (m && (known.commands.has(m[1]) || known.skills.has(m[1]))) push(m[0].length, 'command');
  }
  if (known.shell) {
    push(text.length);
    return out;
  }
  const re = known.dollar ? /(^|\s)([@$])([^\s@$]+)/g : /(^|\s)(@)([^\s@]+)/g;
  re.lastIndex = i;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[1].length;
    const isSkill = m[2] === '$';
    // Punctuation that ends the sentence is not part of the token ("@a.ts," or "@README.md.").
    const body = m[3].replace(/(?:[,;:!?)\]'"]|\.(?=[,;:!?)\]'"]*$))+$/, '');
    if (!body || (isSkill && known.skills.size && !known.skills.has(body))) continue;
    push(start);
    push(start + 1 + body.length, isSkill ? 'skill' : 'mention');
  }
  push(text.length);
  return out;
}

/**
 * Draws soft pills behind recognised tokens in the composer. It sits under the textarea
 * with identical metrics (same font, padding, width and wrapping) and transparent text, so
 * the pills track wrapping, scrolling and auto-grow exactly; the real text stays the
 * textarea's own.
 */
export const Highlight = memo(
  forwardRef<HTMLDivElement, { text: string; caps: Capabilities | undefined; sessionId: string | null; shell: boolean }>(function Highlight({ text, caps, sessionId, shell }, ref) {
    const known = useMemo(
      () => ({
        commands: new Set([...appCommandsFor(sessionId).map((c) => c.name), ...(caps?.commands ?? []).map((c) => c.name)]),
        skills: new Set((caps?.skills ?? []).map((s) => s.name)),
        dollar: caps?.skillTrigger === '$',
      }),
      [caps, sessionId],
    );
    const parts = useMemo(() => (mayHavePills(text) ? tokenize(text, { ...known, shell }) : null), [text, known, shell]);
    if (!parts || !parts.some((p) => p.kind)) return null;
    const nodes: ReactNode[] = parts.map((p, i) =>
      p.kind ? (
        <mark key={i} className="cmp-pill" data-kind={p.kind}>
          {p.text}
        </mark>
      ) : (
        p.text
      ),
    );
    return (
      <div ref={ref} className="cmp-input cmp-hl" aria-hidden>
        {nodes}
        {/* A trailing line break needs a character after it to take up its line. */}
        {'​'}
      </div>
    );
  }),
);
