import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import type { PermissionOption, PermissionRequest, QuestionRequest } from '@shared/protocol';
import { conn } from '@m/lib/conn';
import { diffLines, renderMarkdown } from '@m/lib/md';
import { haptic } from '@m/lib/native';
import { sessionData, useStore } from '@m/lib/store';
import { Icon, TOOL_ICON } from '@m/ui/icons';
import { Choice, Sheet } from '@m/ui/Sheet';

/**
 * What the agent asks: permission prompts and questions as sheets, the oldest first. "Later"
 * closes the sheet; a line above the composer brings it back.
 */
export function Prompts({ sid }: { sid: string }) {
  const permissions = useStore((s) => sessionData(s, sid).permissions);
  const questions = useStore((s) => sessionData(s, sid).questions);
  const [later, setLater] = useState<string | null>(null);
  const perm = permissions[0];
  const question = perm ? undefined : questions[0];
  const current = perm?.id ?? question?.id ?? null;
  const open = !!current && later !== current;

  useEffect(() => {
    if (current && later !== current) haptic('warning');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  return (
    <>
      {current && later === current && (
        <button type="button" className="waiting glass" onClick={() => setLater(null)}>
          <span className="waiting-dot" />
          <span>{perm ? perm.title : 'A question for you'}</span>
          <span className="waiting-go">Review</span>
        </button>
      )}
      <Sheet open={open && !!perm} onClose={() => setLater(current)} dismissable label="Permission">
        {perm && <PermissionBody sid={sid} req={perm} onLater={() => setLater(perm.id)} />}
      </Sheet>
      <Sheet open={open && !!question} onClose={() => setLater(current)} label="Question" tall>
        {question && <QuestionBody sid={sid} req={question} onLater={() => setLater(question.id)} />}
      </Sheet>
    </>
  );
}

function PermissionBody({ sid, req, onLater }: { sid: string; req: PermissionRequest; onLater: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const answer = async (o: PermissionOption) => {
    setBusy(o.id);
    haptic(o.tone === 'deny' ? 'deny' : 'success');
    try {
      await conn.call('permission.respond', { sessionId: sid, requestId: req.id, optionId: o.id });
    } catch {
      setBusy(null);
    }
  };
  const d = req.detail;
  const add = req.diff?.reduce((n, f) => n + f.additions, 0) ?? 0;
  const del = req.diff?.reduce((n, f) => n + f.deletions, 0) ?? 0;
  const ordered = [...req.options].sort((a, b) => rank(a) - rank(b));
  // Granting keys stacked (the first one ivory); refusing and "Later" side by side under them.
  const grants = ordered.filter((o) => o.tone !== 'deny');
  const denials = ordered.filter((o) => o.tone === 'deny');
  return (
    <div className="prompt">
      <div className="prompt-head">
        <span className="prompt-icon">
          <Icon name={TOOL_ICON[req.kind] ?? 'tool'} size={20} />
        </span>
        <div className="prompt-titles">
          <h2 className="prompt-title">{req.title}</h2>
          {req.description && req.description !== req.title && <p className="prompt-sub">{req.description}</p>}
        </div>
      </div>
      {d.command && d.command.trim() !== req.title.trim() && <pre className="prompt-code">{d.command}</pre>}
      {!d.command && d.path && !req.title.includes(d.path.split(/[\\/]/).pop() ?? '') && <div className="prompt-path">{d.path}</div>}
      {d.url && <div className="prompt-path">{d.url}</div>}
      {req.diff && req.diff.length > 0 && (
        <>
          <button type="button" className="prompt-diff num" aria-expanded={showDiff} onClick={() => (haptic('select'), setShowDiff((v) => !v))}>
            <span className="prompt-diff-name">{req.diff.length === 1 ? req.diff[0].path.split(/[\\/]/).pop() : `${req.diff.length} files`}</span>
            <span className="add">+{add}</span>
            <span className="del">−{del}</span>
            <Icon name="caretDown" size={13} weight="bold" className="prompt-diff-caret" />
          </button>
          <AnimatePresence initial={false}>
            {showDiff && (
              <motion.pre
                className="prompt-code prompt-patch"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 420, damping: 40 }}
                dangerouslySetInnerHTML={{ __html: patchHtml(req.diff) }}
              />
            )}
          </AnimatePresence>
        </>
      )}
      {d.plan && <div className="md prompt-plan" dangerouslySetInnerHTML={{ __html: renderMarkdown(d.plan) }} />}
      {req.reason && <p className="prompt-reason">{req.reason}</p>}
      <div className="prompt-actions">
        {grants.map((o, i) => (
          <button key={o.id} type="button" className={`btn btn-lg btn-block ${i === 0 ? 'btn-primary' : ''}`} disabled={!!busy} onClick={() => void answer(o)}>
            {busy === o.id ? <span className="dots" /> : o.label}
          </button>
        ))}
        <div className="prompt-split">
          {denials.map((o) => (
            <button key={o.id} type="button" className="btn btn-lg btn-ghost" disabled={!!busy} onClick={() => void answer(o)}>
              {busy === o.id ? <span className="dots" /> : o.label}
            </button>
          ))}
          <button type="button" className="btn btn-lg btn-ghost prompt-later" onClick={onLater}>
            Later
          </button>
        </div>
      </div>
    </div>
  );
}

/** The change an edit asks to make: its hunks, coloured, at most 160 lines. */
function patchHtml(diff: NonNullable<PermissionRequest['diff']>): string {
  const lines: string[] = [];
  for (const f of diff) {
    if (diff.length > 1) lines.push(`@@ ${f.path.split(/[\\/]/).pop()}`);
    for (const h of f.hunks) {
      lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines}`);
      lines.push(...h.lines);
      if (lines.length > 160) break;
    }
    if (lines.length > 160) break;
  }
  return diffLines(lines.slice(0, 160).join('\n'));
}

const rank = (o: PermissionOption) => (o.tone === 'allow' ? 0 : o.tone === 'always' ? 1 : 2);

function QuestionBody({ sid, req, onLater }: { sid: string; req: QuestionRequest; onLater: () => void }) {
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const ready = useMemo(() => req.questions.every((_, i) => (picked[i]?.length ?? 0) > 0 || (other[i] ?? '').trim()), [req, picked, other]);

  const submit = async (skip?: boolean) => {
    setBusy(true);
    haptic(skip ? 'tap' : 'success');
    const answers: Record<string, string[]> = {};
    req.questions.forEach((q, i) => {
      const list = [...(picked[i] ?? [])];
      const o = (other[i] ?? '').trim();
      if (o) list.push(o);
      answers[q.question] = list;
    });
    try {
      await conn.call('question.respond', { sessionId: sid, requestId: req.id, answers: skip ? null : answers });
    } catch {
      setBusy(false);
    }
  };

  return (
    <div className="prompt">
      {req.questions.map((q, i) => (
        <div key={i} className="question">
          {q.header && <div className="question-head">{q.header}</div>}
          <h2 className="prompt-title">{q.question}</h2>
          <div className="choices">
            {q.options.map((o) => {
              const on = picked[i]?.includes(o.label) ?? false;
              return (
                <Choice
                  key={o.label}
                  mark={q.multiSelect ? 'check' : 'radio'}
                  selected={on}
                  onPick={() => {
                    haptic('select');
                    setPicked((p) => ({ ...p, [i]: q.multiSelect ? (on ? (p[i] ?? []).filter((x) => x !== o.label) : [...(p[i] ?? []), o.label]) : on ? [] : [o.label] }));
                    if (!q.multiSelect) setOther((x) => ({ ...x, [i]: '' }));
                  }}
                >
                  <span className="opt">
                    <span>{o.label}</span>
                    {o.description && <span className="opt-desc">{o.description}</span>}
                  </span>
                </Choice>
              );
            })}
          </div>
          <input
            className="field-input"
            placeholder="Something else"
            value={other[i] ?? ''}
            onChange={(e) => {
              setOther((x) => ({ ...x, [i]: e.target.value }));
              if (!q.multiSelect && e.target.value) setPicked((p) => ({ ...p, [i]: [] }));
            }}
            aria-label="Another answer"
          />
        </div>
      ))}
      <div className="prompt-actions">
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? <span className="dots" /> : 'Answer'}
        </button>
        <div className="prompt-row">
          <button type="button" className="link-btn" disabled={busy} onClick={() => void submit(true)}>
            Skip
          </button>
          <button type="button" className="link-btn" onClick={onLater}>
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
