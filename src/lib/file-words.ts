/** A word that reads as a file: an optional folder path, a name, and an extension that starts with a letter. */
const FILE_WORD = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w@+-][\w@.+-]*[\\/])*[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,7}/g;
/** Common words with a dot that are never files here. */
const NOT_FILES = /^(?:e\.g|i\.e|etc|vs|a\.m|p\.m|node\.js|next\.js|vue\.js|react\.js|three\.js|d3\.js|chart\.js|socket\.io)$/i;
const DOMAIN = /^[\w-]+\.(com|org|net|io|dev|app|ai|co|so|sh)$/i;

/** File-like words in markdown text (not in URLs or code fences), at most `max`. */
export function fileCandidates(text: string, max = 40): string[] {
  const out = new Set<string>();
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  for (const m of plain.matchAll(FILE_WORD)) {
    const w = m[0].replace(/\.+$/, '');
    if (!/\.[A-Za-z]/.test(w) || NOT_FILES.test(w) || DOMAIN.test(w)) continue;
    out.add(w);
    if (out.size >= max) break;
  }
  return [...out];
}
