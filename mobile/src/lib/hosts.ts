/** How many of the desktop's addresses a phone keeps. */
export const MAX_HOSTS = 6;

const valid = (h: unknown): h is string => typeof h === 'string' && /^[\w.:-]{1,64}$/.test(h);

/**
 * The addresses a phone tries for its desktop: the one that answered last first, then the
 * desktop's addresses now (its `welcome` lists them: a new network, Tailscale), then those it
 * kept before; no repeats, at most `MAX_HOSTS`.
 */
export function mergeHosts(saved: string[], offered: unknown, last?: string): string[] {
  const now = Array.isArray(offered) ? offered.filter(valid) : [];
  return [...new Set([...(last ? [last] : []), ...now, ...saved.filter(valid)])].slice(0, MAX_HOSTS);
}

export const sameHosts = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
