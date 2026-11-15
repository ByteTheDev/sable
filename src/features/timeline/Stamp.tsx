import { memo } from 'react';
import { stampParts } from './util';

/**
 * When something was said, shown on hover or focus of its row. Absolutely placed by the row's
 * CSS, so it never moves the layout; it appears in the same frame as the hover.
 */
export const Stamp = memo(function Stamp({ ts, prefix, className }: { ts: number; prefix?: string; className?: string }) {
  if (!ts) return null;
  const { day, time } = stampParts(ts);
  return (
    <time className={`stamp num ${className ?? ''}`} dateTime={new Date(ts).toISOString()}>
      {prefix && <span className="stamp-prefix">{prefix} </span>}
      {day && <span className="stamp-day">{day}</span>}
      <span className="stamp-time">{time}</span>
    </time>
  );
});
