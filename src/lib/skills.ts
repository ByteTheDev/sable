/**
 * Display names for commands and skills. Plugin skills arrive namespaced as `plugin:skill`
 * (often `cinetic:cinetic`); people know them by the part after the last colon. The full name
 * is kept only where two entries would otherwise read the same.
 */

const short = (name: string) => {
  const i = name.lastIndexOf(':');
  return i >= 0 && i < name.length - 1 ? name.slice(i + 1) : name;
};

/** Counts short names once per distinct full name. */
function shortCounts(allNames: Iterable<string>): Map<string, number> {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const n of allNames) {
    if (seen.has(n)) continue;
    seen.add(n);
    const s = short(n);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
}

/** The short name of `name`, or the full one when another entry in `allNames` shares that short name. */
export function skillLabel(name: string, allNames: Iterable<string>): string {
  const s = short(name);
  if (s === name) return name;
  return (shortCounts(allNames).get(s) ?? 0) > 1 ? name : s;
}

/** Labels for a whole list at once (one pass instead of one per entry). */
export function skillLabeller(allNames: Iterable<string>): (name: string) => string {
  const counts = shortCounts(allNames);
  return (name) => {
    const s = short(name);
    return s !== name && (counts.get(s) ?? 0) > 1 ? name : s;
  };
}
