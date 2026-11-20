import { memo, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { DropdownMenu as RM } from 'radix-ui';
import { fieldBeat } from '@/art/events';
import { Roll } from '@/features/composer/Roll';
import { Icon } from '@/icons';
import { discardReview, sendReview } from '@/state/actions';
import { useStore } from '@/state/store';
import { Menu, MenuTrigger, Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/ui';
import { jumpToComment } from './jump';
import { keepReviews } from './keep';
import { orderComments, rangeLabel, type ReviewComment } from './model';
import '@/features/composer/until.css';
import './review.css';

keepReviews();

const NONE: ReviewComment[] = [];

const rise = {
  initial: { opacity: 0, y: 10, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 4, transition: { duration: 0.14, ease: [0.5, 0, 0.9, 0.4] as const } },
  transition: { type: 'spring' as const, stiffness: 460, damping: 36 },
};

const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const firstLine = (t: string) => t.split('\n').find((l) => l.trim())?.trim() ?? '';

function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

/**
 * The chat's pending review, above the composer: "3 comments" (a list that jumps to each), Discard
 * and Send review. Send review sends one message: what is typed in the composer, then every comment
 * with its file, lines and quote.
 */
export const ReviewBar = memo(function ReviewBar({ sessionId }: { sessionId: string }) {
  const comments = useStore((s) => s.reviews[sessionId] ?? NONE);
  const count = comments.length;
  const ordered = useMemo(() => orderComments(comments), [comments]);
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const jumped = useRef(false);
  const label = count === 1 ? 'comment' : 'comments';

  const send = async (el: HTMLElement) => {
    if (sending) return;
    setSending(true);
    fieldBeat('send', el, 0.7);
    await sendReview(sessionId);
    setSending(false);
  };

  return (
    <AnimatePresence initial={false}>
      {count > 0 && (
        <motion.div key="review" className="us-slot" {...rise}>
          <section className="us rv-bar" data-spot aria-label="Review">
            <Menu>
              <MenuTrigger asChild>
                <button type="button" className="rv-count" aria-label={`${count} review ${label}, show the list`}>
                  <Icon name="comment" size={15} />
                  <span>
                    <Roll value={count} className="num" /> {label}
                  </span>
                  <Icon name="caret-up" size={10} weight="bold" className="rv-count-caret" />
                </button>
              </MenuTrigger>
              <RM.Portal>
                <RM.Content
                  className="pop rv-pop"
                  data-spot=""
                  side="top"
                  align="start"
                  sideOffset={10}
                  collisionPadding={10}
                  style={{ width: 340 }}
                  // A jump puts the keyboard on the comment it lands on, not back on this button.
                  onCloseAutoFocus={(e) => {
                    if (jumped.current) e.preventDefault();
                    jumped.current = false;
                  }}
                >
                  {/* The rows scroll inside the glass: the rim and the shadow stay with the pane. */}
                  <div className="rv-list scroll">
                    {ordered.map((c) => {
                      const [dir, base] = splitPath(c.path);
                      const range = rangeLabel(c.lines);
                      return (
                        <RM.Item
                          key={c.id}
                          className="menu-item rv-item"
                          onSelect={() => {
                            jumped.current = true;
                            jumpToComment(sessionId, c);
                          }}
                        >
                          <span className="rv-item-where">
                            <span className="rv-item-path truncate">
                              {dir && <span className="rv-item-dir">{dir}</span>}
                              {base}
                            </span>
                            {range && <span className="rv-item-range num">{upper(range)}</span>}
                          </span>
                          <span className="rv-item-text truncate">{firstLine(c.text)}</span>
                        </RM.Item>
                      );
                    })}
                  </div>
                </RM.Content>
              </RM.Portal>
            </Menu>
            <span className="us-actions">
              {count === 1 ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => discardReview(sessionId)}>
                  Discard
                </button>
              ) : (
                <Popover open={confirm} onOpenChange={setConfirm}>
                  <PopoverTrigger asChild>
                    <button type="button" className="btn btn-ghost btn-sm">
                      Discard
                    </button>
                  </PopoverTrigger>
                  <PopoverContent side="top" align="end" width={232} sideOffset={10} className="rv-confirm">
                    <div className="rv-confirm-title">Discard {count} comments</div>
                    <div className="rv-confirm-foot">
                      <PopoverClose asChild>
                        <button type="button" className="btn btn-ghost btn-sm">
                          Cancel
                        </button>
                      </PopoverClose>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => {
                          setConfirm(false);
                          discardReview(sessionId);
                        }}
                      >
                        Discard
                      </button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}
              <button type="button" className="btn btn-sm" data-busy={sending || undefined} onClick={(e) => void send(e.currentTarget)}>
                <Icon name="arrow-up" size={13} />
                Send review
              </button>
            </span>
          </section>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
