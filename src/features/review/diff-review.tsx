import { useCallback, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { addReviewComment, editReviewComment, removeReviewComment } from '@/state/actions';
import { useStore } from '@/state/store';
import { keepReviews } from './keep';
import { clampToHunk, hunksOf, linesOf, locate, newCommentId, rangeLabel, type DiffRowLike, type ReviewComment, type ReviewLine } from './model';
import { CommentCard, DraftField, Grow } from './Thread';
import './review.css';

keepReviews();

/** Which chat a diff's comments go to, which diff it is (see `ReviewComment.scope`) and its file as the agent knows it. */
export interface ReviewTarget {
  sessionId: string;
  scope: string;
  path: string;
}

interface Draft {
  a: number;
  b: number;
  /** The comment being edited, if any. */
  edit?: string;
  /** Opened from the keyboard: closing it gives the keyboard back to the lines. */
  keys?: boolean;
  /** Came back with its diff (the file row was closed and opened): shown without the reveal. */
  restored?: boolean;
  n: number;
}

interface Leaving {
  b: number;
  n: number;
  text: string;
  edit?: string;
}

/** The words of an open field per diff, so closing a file row and opening it again keeps them. */
const openFields = new Map<string, { lines: ReviewLine[]; text: string; edit?: string }>();
let drafts = 0;
const NONE: ReviewComment[] = [];

const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Review comments on one diff (DiffView with a `review` target): click the "+" in a line's gutter
 * or drag across line numbers to pick lines, type in the field that opens under them, and the
 * comment joins the chat's pending review as a quiet card under its lines. From the keyboard the
 * lines are one stop: arrows move, Shift+arrows pick a range, Enter comments.
 *
 * Picking, the keyboard line and the lit range are painted as attributes on the rows (`paint`), so
 * a drag across a long diff never renders its rows again.
 */
export function useDiffReview(target: ReviewTarget | undefined, rows: readonly DiffRowLike[], numbered: boolean, name: string) {
  const on = !!target;
  const key = target ? `${target.sessionId}\u0000${target.scope}` : '';
  const sessionId = target?.sessionId ?? '';
  const all = useStore((s) => (target ? s.reviews[target.sessionId] : undefined));
  const scope = target?.scope;
  const comments = useMemo(() => (all && scope ? all.filter((c) => c.scope === scope) : NONE), [all, scope]);
  const linesRef = useRef<HTMLDivElement>(null);
  const born = useRef(Date.now());

  // Comments that just left (deleted, sent, discarded) close where they were before they go.
  const [ghosts, setGhosts] = useState<ReviewComment[]>(NONE);

  const [draft, setDraft] = useState<Draft | null>(() => {
    const kept = key ? openFields.get(key) : undefined;
    const at = kept ? locate(rows, kept.lines) : null;
    if (!kept || !at) return null;
    if (kept.edit && !comments.some((c) => c.id === kept.edit)) return null;
    return { a: at[0], b: at[1], edit: kept.edit, restored: true, n: ++drafts };
  });
  const [leaving, setLeaving] = useState<Leaving[]>([]);
  /** Lines being picked (a drag, or Shift+arrows). */
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  /** The keyboard's line. */
  const [cursor, setCursor] = useState<number | null>(null);
  /** The lines of the card under the pointer or the keyboard. */
  const [peek, setPeek] = useState<{ a: number; b: number } | null>(null);

  // What this diff showed last: another chat's comments on the same diff start clean; comments that
  // left this one become ghosts.
  const [seen, setSeen] = useState({ key, comments });
  if (seen.key !== key) {
    setSeen({ key, comments });
    setGhosts(NONE);
    setDraft(null);
    setLeaving([]);
    setSel(null);
    setCursor(null);
    setPeek(null);
  } else if (seen.comments !== comments) {
    setSeen({ key, comments });
    const gone = seen.comments.filter((c) => !comments.some((x) => x.id === c.id));
    if (gone.length) setGhosts((g) => [...g.filter((x) => !gone.some((y) => y.id === x.id)), ...gone]);
  }

  // Gaps between hunks are only shown with real line numbers; a range never crosses one shown.
  const hunks = useMemo(() => (numbered ? hunksOf(rows) : rows.map((r) => (r.t === 'sep' ? -1 : 0))), [rows, numbered]);

  /** Comments by the row they hang under, with the rows they cover. */
  const placed = useMemo(() => {
    const out = new Map<number, { c: ReviewComment; a: number; b: number; ghost?: boolean }[]>();
    if (!on) return out;
    const live = new Set(comments.map((c) => c.id));
    for (const [list, ghost] of [
      [comments, false],
      [ghosts.filter((g) => !live.has(g.id)), true],
    ] as const) {
      for (const c of list) {
        const at = locate(rows, c.lines);
        if (!at) continue;
        const slot = out.get(at[1]) ?? [];
        slot.push({ c, a: at[0], b: at[1], ghost });
        out.set(at[1], slot);
      }
    }
    for (const slot of out.values()) slot.sort((x, y) => x.c.at - y.c.at);
    return out;
  }, [on, rows, comments, ghosts]);

  const live = useRef({ draft, sel, rows, hunks, numbered, key });
  live.current = { draft, sel, rows, hunks, numbered, key };

  const close = useCallback((d: Draft, focusLines: boolean) => {
    const kept = openFields.get(live.current.key);
    openFields.delete(live.current.key);
    setLeaving((l) => [...l, { b: d.b, n: d.n, text: kept?.text ?? '', edit: d.edit }]);
    setDraft((cur) => (cur?.n === d.n ? null : cur));
    if (focusLines) {
      setCursor(d.b);
      linesRef.current?.focus({ preventScroll: true });
    }
  }, []);

  /** Opens the field under lines `a`..`b`; an open field moves there with its words. */
  const open = useCallback(
    (a: number, b: number, keys = false) => {
      const { rows, numbered, key, draft } = live.current;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const lines = linesOf(rows, lo, hi, numbered);
      if (!lines.length) return;
      const kept = openFields.get(key);
      const text = kept && !kept.edit ? kept.text : '';
      if (draft && (draft.edit || draft.b !== hi)) close(draft, false);
      openFields.set(key, { lines, text });
      setDraft(draft && !draft.edit && draft.b === hi ? { ...draft, a: lo, keys } : { a: lo, b: hi, keys, n: ++drafts });
      setSel(null);
    },
    [close],
  );

  const edit = useCallback(
    (c: ReviewComment, a: number, b: number) => {
      const { draft, key } = live.current;
      if (draft) close(draft, false);
      setPeek(null);
      openFields.set(key, { lines: c.lines, text: c.text, edit: c.id });
      setDraft({ a, b, edit: c.id, n: ++drafts });
    },
    [close],
  );

  const submit = (d: Draft, text: string) => {
    if (!target) return;
    if (d.edit) editReviewComment(sessionId, d.edit, text);
    else {
      const lines = linesOf(rows, d.a, d.b, numbered);
      addReviewComment(sessionId, { id: newCommentId(), scope: target.scope, path: target.path, lines, text, at: Date.now() });
    }
    close(d, !!d.keys);
  };

  // ── pointer: the "+" or a drag across line numbers ──

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const host = linesRef.current;
    const gutter = (e.target as Element).closest('.dv-gutter');
    const row = gutter?.closest<HTMLElement>('.dv-row');
    if (!host || !row || !host.contains(row)) return;
    const i = Number(row.dataset.i);
    if (!Number.isFinite(i)) return;
    e.preventDefault();
    const d = live.current.draft;
    // Shift extends the open field's lines to this one.
    const from = e.shiftKey && d && !d.edit ? (i >= d.a ? d.a : d.b) : i;
    let cur = { a: from, b: clampToHunk(live.current.hunks, from, i) };
    setSel(cur);
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.dv-row');
      if (!el || !host.contains(el)) return;
      const j = Number(el.dataset.i);
      if (!Number.isFinite(j)) return;
      const b = clampToHunk(live.current.hunks, cur.a, j);
      if (b !== cur.b) setSel((cur = { a: cur.a, b }));
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', esc, true);
      if (ev.type === 'pointercancel') setSel(null);
      else open(cur.a, cur.b);
    };
    const esc = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', esc, true);
      setSel(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('keydown', esc, true);
  };

  // ── keyboard: the lines are one stop ──

  const shownRows = () => [...(linesRef.current?.querySelectorAll<HTMLElement>(':scope > .dv-row') ?? [])];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return;
    const els = shownRows();
    if (!els.length) return;
    const order = els.map((el) => Number(el.dataset.i));
    const at = Math.max(0, order.indexOf(cursor ?? order[0]));
    const go = (pos: number, extend: boolean) => {
      const to = order[Math.max(0, Math.min(order.length - 1, pos))];
      if (extend) {
        const a = sel?.a ?? order[at];
        const b = clampToHunk(hunks, a, to);
        setSel({ a, b });
        setCursor(b);
        els[order.indexOf(b)]?.scrollIntoView({ block: 'nearest' });
      } else {
        setSel(null);
        setCursor(to);
        els[order.indexOf(to)]?.scrollIntoView({ block: 'nearest' });
      }
    };
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        go(at + (e.key === 'ArrowDown' ? 1 : -1), e.shiftKey);
        return;
      case 'Home':
      case 'End':
        e.preventDefault();
        go(e.key === 'Home' ? 0 : order.length - 1, e.shiftKey);
        return;
      case 'Enter':
        e.preventDefault();
        if (sel) open(sel.a, sel.b, true);
        else open(order[at], order[at], true);
        return;
      case 'Escape':
        if (sel) {
          e.preventDefault();
          setSel(null);
        }
        return;
    }
  };

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || cursor != null) return;
    // The first changed line, where a reviewer starts.
    const els = shownRows();
    const first = els.find((el) => el.dataset.t) ?? els[0];
    if (first) setCursor(Number(first.dataset.i));
  };

  // ── what the rows show: the picked or lit range, the keyboard's line, lines with a comment ──

  const lit = sel ?? (draft ? { a: draft.a, b: draft.b } : null) ?? peek;
  useLayoutEffect(() => {
    const host = linesRef.current;
    if (!host || !on) return;
    for (const el of host.querySelectorAll('[data-sel], [data-noted], [data-cursor]')) {
      el.removeAttribute('data-sel');
      el.removeAttribute('data-noted');
      el.removeAttribute('data-cursor');
    }
    const byIndex = new Map<number, HTMLElement>();
    for (const el of host.querySelectorAll<HTMLElement>(':scope > .dv-row')) byIndex.set(Number(el.dataset.i), el);
    const mark = (a: number, b: number, attr: string) => {
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) byIndex.get(i)?.setAttribute(attr, '');
    };
    for (const slot of placed.values()) for (const p of slot) if (!p.ghost) mark(p.a, p.b, 'data-noted');
    if (lit) mark(lit.a, lit.b, 'data-sel');
    if (cursor != null) byIndex.get(cursor)?.setAttribute('data-cursor', '');
  });

  // ── the slots under rows: comment cards and the field ──

  const slot = (i: number): ReactNode => {
    if (!target) return null;
    const here = placed.get(i);
    const field = draft && !draft.edit && draft.b === i ? draft : null;
    const gone = leaving.filter((l) => l.b === i);
    if (!here && !field && !gone.length) return null;
    const placeholderFor = (a: number, b: number) => {
      const r = rangeLabel(linesOf(rows, a, b, numbered));
      return r ? `Comment on ${r}` : a === b ? 'Comment on this line' : 'Comment on these lines';
    };
    const fieldFor = (d: Draft) => {
      const kept = openFields.get(key);
      return (
        <Grow key={`d${d.n}`} open appear={!d.restored}>
          <DraftField
            placeholder={placeholderFor(d.a, d.b)}
            initial={kept?.text ?? ''}
            editing={!!d.edit}
            focus={!d.restored}
            onText={(text) => {
              const k = openFields.get(key);
              if (k) k.text = text;
            }}
            onSubmit={(text) => submit(d, text)}
            onCancel={() => close(d, !!d.keys)}
          />
        </Grow>
      );
    };
    const leavingFor = (l: Leaving) => (
      <Grow key={`d${l.n}`} open={false} onClosed={() => setLeaving((all) => all.filter((x) => x.n !== l.n))}>
        <DraftField placeholder="" initial={l.text} editing={!!l.edit} onText={() => {}} onSubmit={() => {}} onCancel={() => {}} />
      </Grow>
    );
    // One flat keyed list, so a field that closes stays the same element while it folds away.
    const items: ReactNode[] = [];
    for (const p of here ?? []) {
      const editing = draft?.edit === p.c.id ? draft : null;
      const multi = p.b > p.a ? rangeLabel(p.c.lines) : undefined;
      items.push(
        <Grow
          key={p.c.id}
          open={!p.ghost && !editing}
          appear={p.c.at > born.current}
          onClosed={p.ghost ? () => setGhosts((g) => g.filter((x) => x.id !== p.c.id)) : undefined}
        >
          <CommentCard
            comment={p.c}
            range={multi ? upper(multi) : undefined}
            onEdit={() => edit(p.c, p.a, p.b)}
            onDelete={() => {
              setPeek(null);
              removeReviewComment(sessionId, p.c.id);
            }}
            onPeek={(lit) => setPeek(lit ? { a: p.a, b: p.b } : null)}
          />
        </Grow>,
      );
      if (editing) items.push(fieldFor(editing));
      for (const l of gone) if (l.edit === p.c.id) items.push(leavingFor(l));
    }
    for (const l of gone) if (!l.edit || !here?.some((p) => p.c.id === l.edit)) items.push(leavingFor(l));
    if (field) items.push(fieldFor(field));
    return (
      <div className="rv-slot" key={`rv${i}`}>
        <div className="rv-pin">{items}</div>
      </div>
    );
  };

  /** The last row a comment or the field hangs under: a diff cut at "Show more" shows at least that far. */
  let reach = draft?.b ?? -1;
  for (const i of placed.keys()) reach = Math.max(reach, i);

  return {
    on,
    reach,
    slot,
    linesProps: on
      ? {
          ref: linesRef,
          tabIndex: 0,
          role: 'group',
          'aria-label': `${name}. Arrow keys move between lines, Shift picks several, Enter comments`,
          onPointerDown,
          onKeyDown,
          onFocus,
        }
      : {},
  };
}
