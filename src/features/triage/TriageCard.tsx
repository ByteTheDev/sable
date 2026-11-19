import { useEffect, useImperativeHandle, useState, type Ref } from 'react';
import type { PermissionOption, PermissionRequest, QuestionRequest } from '@shared/protocol';
import { ProviderMark } from '@/art/Logo';
import { Glyph, Icon, TOOL_ICON } from '@/icons';
import { baseName, formatDuration } from '@/lib/format';
import { KeyHint, PermissionSubject, restates } from '@/features/prompts/PermissionCard';
import { QuestionHead, QuestionPage, useQuestionAnswers } from '@/features/prompts/QuestionCard';
import type { PendingPrompt } from '@/state/pending';
import { useStore } from '@/state/store';
import { optionKeys, type DeckAction } from './deck';

/** The front card's answer to a key the deck passed on: true when it was taken. */
export interface CardHandle {
  act: (a: DeckAction) => boolean;
}

export interface CardProps {
  p: PendingPrompt;
  /** In front and ready for answers (a card that has just come forward waits a moment, so a quick second key cannot answer it unseen). */
  armed: boolean;
  /** Set to the card's answer keys while it is in front. */
  handle: Ref<CardHandle> | null;
  onPermission: (p: PendingPrompt, option: PermissionOption, note?: string) => void;
  onQuestion: (p: PendingPrompt, answers: Record<string, string[]> | null) => void;
  onOpen: (p: PendingPrompt) => void;
  /** Focus back on the deck (after a field closes). */
  refocus: () => void;
}

/** How long the request has waited: seconds at first, then minutes. */
function Waited({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  const age = now - since;
  useEffect(() => {
    const t = window.setTimeout(() => setNow(Date.now()), age < 60_000 ? 1000 : 15_000);
    return () => window.clearTimeout(t);
  }, [now, age]);
  const label = age < 1000 ? 'now' : formatDuration(age < 60_000 ? Math.floor(age / 1000) * 1000 : Math.floor(age / 60_000) * 60_000);
  return (
    <span className="tri-age num" title={new Date(since).toLocaleTimeString()}>
      {label}
    </span>
  );
}

/** Where the request comes from: the agent, the chat and its folder. Opens the chat. */
function From({ p, onOpen }: { p: PendingPrompt; onOpen: (p: PendingPrompt) => void }) {
  const session = useStore((s) => s.sessions[p.sessionId]);
  if (!session) return null;
  return (
    <div className="tri-from">
      <button type="button" className="tri-from-link" onClick={() => onOpen(p)} aria-label={`Open ${session.title}`}>
        <ProviderMark provider={session.provider} size={14} />
        <span className="tri-from-title truncate">{session.title}</span>
        {!session.chat && session.cwd && (
          <span className="tri-from-folder">
            <Icon name="folder" size={13} />
            <span className="truncate">{baseName(session.cwd)}</span>
          </span>
        )}
      </button>
      <Waited since={p.since} />
    </div>
  );
}

/** The front card's contents: where it comes from, what it asks, and its answers with their keys. */
export function CardBody(props: CardProps) {
  return props.p.kind === 'permission' ? <PermissionBody {...props} req={props.p.req} /> : <QuestionBody {...props} req={props.p.req} />;
}

function PermissionBody({ p, req, armed, handle, onPermission, onOpen, refocus }: CardProps & { req: PermissionRequest }) {
  const [note, setNote] = useState<string | null>(null);
  const input = useStore((s) => (req.itemId ? (s.data[p.sessionId]?.items[req.itemId] as { input?: unknown } | undefined)?.input : undefined));
  const keys = optionKeys(req.options);
  const tool = TOOL_ICON[req.kind] ?? TOOL_ICON.other;

  const choose = (o: PermissionOption | undefined) => {
    if (!o || !armed) return false;
    if (o.tone === 'deny' && req.allowFeedback) setNote('');
    else onPermission(p, o);
    return true;
  };

  useImperativeHandle(handle, () => ({
    act: (a) => {
      if (note !== null) return false;
      if (a.type === 'allow') return choose(keys.allow);
      if (a.type === 'always') return choose(keys.always);
      if (a.type === 'deny') return choose(keys.deny);
      if (a.type === 'pick') return choose(req.options[a.index]);
      return false;
    },
  }));

  const deny = keys.deny;
  // A command's title is the command, shown in full just below: the card is titled with what it is for.
  const echo = req.kind === 'bash' && !!req.description && req.title.trim() === req.detail.command?.trim();
  const title = echo ? req.description! : req.title;
  return (
    <>
      <From p={p} onOpen={onOpen} />
      <header className="pc-head">
        <Glyph name={tool.icon} tone="var(--amber)" size={30} />
        <div className="pc-titles">
          <h3 className="pc-title">{title}</h3>
          {!echo && req.description && !restates(req) && <p className="pc-desc">{req.description}</p>}
        </div>
      </header>
      <div className="pc-body">
        <PermissionSubject req={req} input={input} />
        {req.reason && (
          <p className="pc-reason">
            <Icon name="shield-warning" size={14} />
            {req.reason}
          </p>
        )}
      </div>
      {note !== null && deny ? (
        <div className="pc-foot pc-feedback">
          <input
            className="field pc-feedback-field"
            autoFocus
            placeholder="Tell the agent what to do instead"
            aria-label="Tell the agent what to do instead"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                onPermission(p, deny, note.trim() || undefined);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setNote(null);
                refocus();
              }
            }}
          />
          <button type="button" className="btn btn-ghost" onClick={() => (setNote(null), refocus())}>
            Back
          </button>
          <button type="button" className="btn" onClick={() => onPermission(p, deny, note.trim() || undefined)}>
            {deny.label}
            <KeyHint k="↵" />
          </button>
        </div>
      ) : (
        <div className="pc-foot tri-foot">
          {req.options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              className={o === keys.allow ? 'btn btn-primary' : o.tone === 'always' ? 'btn' : 'btn btn-ghost'}
              data-tone={o.tone}
              aria-disabled={!armed || undefined}
              onClick={() => choose(o)}
            >
              <span>{o.label}</span>
              {keys.hints[i] && <KeyHint k={keys.hints[i]} />}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function QuestionBody({ p, req, armed, handle, onQuestion, onOpen, refocus }: CardProps & { req: QuestionRequest }) {
  const x = useQuestionAnswers(req, (answers) => onQuestion(p, answers));
  const { q, qs, step, last, complete, sent } = x;

  useImperativeHandle(handle, () => ({
    act: (a) => {
      if (sent || !armed) return false;
      if (a.type === 'pick') return x.pick(a.index);
      if (a.type === 'advance') return x.advance(), true;
      if (a.type === 'skip') return x.send(true), true;
      if (a.type === 'step') {
        const to = step + a.by;
        if (qs.length < 2 || to < 0 || to >= qs.length) return false;
        x.go(to);
        return true;
      }
      return false;
    },
  }));

  if (!q) return null;
  return (
    <>
      <From p={p} onOpen={onOpen} />
      <div className="tri-q">
        <QuestionHead x={x} />
        <QuestionPage x={x} onFieldEscape={refocus} />
      </div>
      <div className="pc-foot qc-foot tri-foot">
        <button type="button" className="btn btn-ghost" disabled={sent} aria-disabled={!armed || undefined} onClick={() => armed && x.send(true)}>
          Skip
          <KeyHint k="S" />
        </button>
        <span className="grow" />
        {!last && (
          <button type="button" className="btn" disabled={!x.ready} onClick={() => x.go(step + 1)}>
            Next
            <KeyHint k="↵" />
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={!complete || sent} aria-disabled={!armed || undefined} onClick={() => armed && x.send()}>
          Send answers
          {last && <KeyHint k="↵" />}
        </button>
      </div>
    </>
  );
}
