import { highlightRuns } from '@/lib/fuzzy';
import './palette.css';

/** Text with fuzzy-matched characters lit. */
export function Highlight({ text, indices }: { text: string; indices?: number[] }) {
  if (!indices?.length) return <>{text}</>;
  return (
    <>
      {highlightRuns(text, indices).map((r, i) =>
        r.hit ? (
          <mark key={i} className="hl">
            {r.text}
          </mark>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </>
  );
}
