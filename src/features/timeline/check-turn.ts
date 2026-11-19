import type { ProviderId, ProviderInfo, TimelineItem, ToolItem } from '@shared/protocol';
import type { FileLinks } from '@/lib/file-links';

/**
 * "Check with Codex" in the window: which agent checks a chat's turns, when it can, and what its
 * findings become. The bridge runs the check (server/core/check.ts); the block is `Check.tsx`.
 */

/** The agent that checks a turn of `provider`: the other one. A Demo chat checks with Demo. */
export function checkerOf(provider: ProviderId | undefined): ProviderId | undefined {
  if (provider === 'claude') return 'codex';
  if (provider === 'codex') return 'claude';
  if (provider === 'demo') return 'demo';
  return undefined;
}

/** Installed and signed in, as last known (the bridge decides the same way). */
export const canCheckWith = (info: ProviderInfo | undefined) => !!info?.installed && !!info.auth?.loggedIn;

export const NO_PROBLEMS = 'No problems found.';

/** Whether the findings name a problem (anything but "No problems found."). */
export const hasFindings = (text: string) => !!text.trim() && !/^no problems found\.?$/i.test(text.trim());

/** Whether any check of the turn is running or has its findings: then the turn offers no new one. */
export function checkedAlready(items: Record<string, TimelineItem | undefined> | undefined, checks: readonly string[] | undefined): boolean {
  if (!items || !checks?.length) return false;
  return checks.some((id) => {
    const it = items[id];
    return it?.type === 'tool' && (it.status === 'running' || it.status === 'pending' || it.status === 'done');
  });
}

/** The message the findings make for the chat's own agent: put in the composer, never sent by itself. */
export function findingsMessage(checker: string, findings: string): string {
  return `${checker} reviewed your changes and found:\n\n${findings.trim()}\n\nLook into each finding and fix the ones that hold.`;
}

/** Why a check could not finish, in one line: the reason without the runner's own wording around it. */
export function checkFailure(item: ToolItem): string {
  const text = (item.result?.stderr || item.result?.text || '').trim();
  const line = text
    .replace(/^the sub-agent (could not run|stopped):\s*/i, '')
    .split('\n')
    .find((l) => l.trim());
  return line?.trim() ?? '';
}

const LINE_REF = /(?:[A-Za-z]:[\\/])?[\w@.+\-/\\]+\.[A-Za-z][A-Za-z0-9]{0,7}:\d+(?::\d+)?/g;

/**
 * The findings' `path:line` references link to their files: the file words resolve as in any answer
 * (`useResolvedFiles` drops the line), and each reference is added under its own word.
 */
export function withLineRefs(links: FileLinks | null, text: string): FileLinks | null {
  if (!links) return null;
  let files: Record<string, string> | null = null;
  for (const m of text.matchAll(LINE_REF)) {
    const ref = m[0];
    const path = ref.replace(/(?::\d+){1,2}$/, '');
    const file = links.files[path];
    if (!file || links.files[ref]) continue;
    files ??= { ...links.files };
    files[ref] = file;
  }
  return files ? { ...links, files } : links;
}
