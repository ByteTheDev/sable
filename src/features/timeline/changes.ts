import type { TimelineItem } from '@shared/protocol';

export interface Changes {
  files: number;
  add: number;
  del: number;
}

/** What a segment's edits changed, sub-agents' edits included: distinct files, lines added and removed. */
export function changesOf(items: Record<string, TimelineItem | undefined>, children: Record<string, string[] | undefined>, ids: readonly string[]): Changes {
  const files = new Set<string>();
  let add = 0;
  let del = 0;
  const walk = (list: readonly string[], depth: number) => {
    for (const id of list) {
      const it = items[id];
      if (it?.type !== 'tool') continue;
      if ((it.kind === 'edit' || it.kind === 'write') && it.status === 'done') {
        for (const d of it.result?.diff ?? []) {
          files.add(d.path);
          add += d.additions;
          del += d.deletions;
        }
      } else if (it.kind === 'agent' && depth < 4) walk(children[id] ?? [], depth + 1);
    }
  };
  walk(ids, 0);
  return { files: files.size, add, del };
}
