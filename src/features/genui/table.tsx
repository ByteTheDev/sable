import { useCopy } from '@/lib/view-hooks';
import { Icon } from '@/icons';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/ui';

/**
 * Tables in answers: which columns hold figures (they align right, in tabular digits), and the two
 * copies people want (Markdown back, CSV for a spreadsheet). Pure helpers are tested.
 */

export interface PlainTable {
  header: string[];
  rows: string[][];
}

/** A figure: optional sign and currency, digits with separators, an optional unit or percent. */
const FIGURE = /^[-+−±~≈]?\s?[$€£¥]?\s?\d[\d,.\s']*(\s?(%|‰|[kKmMbBtT]|ms|µs|ns|s|m|h|d|x|×|pts?|KB|MB|GB|TB|kb|mb|gb|rps|req\/s|\/s))?$/;

/** Inline markdown marks dropped for copies and figure checks. */
export function plainCell(text: string): string {
  return text
    .replace(/\\\|/g, '|')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\W)[*_](\S[^*_]*)[*_](?=\W|$)/g, '$1$2')
    .replace(/<br\s*\/?>/gi, ' ')
    .trim();
}

export function isFigure(text: string): boolean {
  const t = plainCell(text);
  return !!t && FIGURE.test(t);
}

/** Columns where at least four in five filled cells are figures. */
export function numericColumns(t: PlainTable): boolean[] {
  return t.header.map((_, i) => {
    let filled = 0;
    let figures = 0;
    for (const row of t.rows) {
      const cell = plainCell(row[i] ?? '');
      if (!cell || cell === '-' || cell === '—' || cell === '–' || /^n\/?a$/i.test(cell)) continue;
      filled++;
      if (FIGURE.test(cell)) figures++;
    }
    return filled > 0 && figures / filled >= 0.8;
  });
}

/** Columns of prose (long cells on average): they get room to read instead of a narrow, tall stack. */
export function wideColumns(t: PlainTable): boolean[] {
  return t.header.map((_, i) => {
    let n = 0;
    let len = 0;
    for (const row of t.rows) {
      const cell = plainCell(row[i] ?? '');
      if (!cell) continue;
      n++;
      len += cell.length;
    }
    return n > 0 && len / n > 28;
  });
}

const csvCell =(s: string) => (/[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function tableToCsv(t: PlainTable): string {
  return [t.header, ...t.rows].map((r) => t.header.map((_, i) => csvCell(plainCell(r[i] ?? ''))).join(',')).join('\n');
}

/** The hover control on a table: copy it as Markdown or as CSV. */
export function TableCopy({ markdown, table }: { markdown: string; table: PlainTable }) {
  const [copied, copy] = useCopy();
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <button type="button" className="md-table-copy" aria-label="Copy table" data-copied={copied || undefined}>
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </MenuTrigger>
      <MenuContent align="end" width={190}>
        <MenuItem icon="text" onSelect={() => copy(markdown.trim())}>
          Copy as Markdown
        </MenuItem>
        <MenuItem icon="grid" onSelect={() => copy(tableToCsv(table))}>
          Copy as CSV
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
