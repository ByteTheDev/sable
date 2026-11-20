import { memo } from 'react';
import { Icon } from '@/icons';
import type { ParsedReview } from './model';
import './review.css';

const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

/**
 * A review sent from the review bar, as the person's message shows it: their comments as a short
 * list (file and lines over the words), not the quoted lines the agent gets. Copy gives it all.
 */
export const ReviewComments = memo(function ReviewComments({ review }: { review: ParsedReview }) {
  const n = review.comments.length;
  return (
    <ul className="rv-msg" aria-label={`Review, ${n} ${n === 1 ? 'comment' : 'comments'}`}>
      {review.comments.map((c, i) => {
        const [dir, base] = splitPath(c.path);
        return (
          <li key={i} className="rv-msg-item">
            <div className="rv-msg-where">
              <Icon name="comment" size={13} />
              <span className="rv-msg-path truncate" title={c.path}>
                {dir && <span className="rv-msg-dir">{dir}</span>}
                {base}
              </span>
              {c.range && <span className="num">{upper(c.range)}</span>}
            </div>
            <div className="rv-msg-text">{c.text}</div>
          </li>
        );
      })}
    </ul>
  );
});
