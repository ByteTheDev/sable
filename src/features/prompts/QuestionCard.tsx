import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { QuestionRequest } from '@shared/protocol';
import { Icon } from '@/icons';
import { respondQuestion } from '@/state/actions';
import { focusComposer } from '@/state/hooks';
import { KeyHint } from './PermissionCard';
import { usePromptKeys } from './keys';

interface Answer {
  picked: string[];
  /** null: "Other" not chosen. */
  other: string | null;
}

const blank = (): Answer => ({ picked: [], other: null });
const answered = (a: Answer | undefined) => !!a && (a.picked.length > 0 || !!a.other?.trim());

/** Structured questions from the agent: pick options, or write your own answer. */
export function QuestionCard({ sessionId, req, more }: { sessionId: string; req: QuestionRequest; more: number }) {
  const qs = req.questions;
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [answers, setAnswers] = useState<Answer[]>(() => qs.map(blank));
  const [sent, setSent] = useState(false);
  const otherRef = useRef<HTMLInputElement>(null);
  const q = qs[step];
  const a = answers[step] ?? blank();
  const multi = !!q?.multiSelect;
  const last = step === qs.length - 1;
  const complete = qs.every((_, i) => answered(answers[i]));

  const update = (fn: (a: Answer) => Answer) => setAnswers((all) => all.map((x, i) => (i === step ? fn(x) : x)));

  const toggle = (label: string) =>
    update((cur) => {
      if (multi) return { ...cur, picked: cur.picked.includes(label) ? cur.picked.filter((l) => l !== label) : [...cur.picked, label] };
      return { picked: cur.picked[0] === label ? [] : [label], other: null };
    });

  const chooseOther = () => {
    update((cur) => (cur.other !== null ? (multi ? { ...cur, other: null } : cur) : { picked: multi ? cur.picked : [], other: '' }));
    requestAnimationFrame(() => otherRef.current?.focus());
  };

  const go = (to: number) => {
    setDir(to > step ? 1 : -1);
    setStep(to);
  };

  const send = (skip = false) => {
    if (sent) return;
    if (!skip && !complete) return;
    setSent(true);
    const out: Record<string, string[]> = {};
    qs.forEach((qq, i) => {
      const x = answers[i];
      out[qq.question] = [...x.picked, ...(x.other?.trim() ? [x.other.trim()] : [])];
    });
    void respondQuestion(sessionId, req.id, skip ? null : out);
    focusComposer();
  };

  const advance = () => {
    if (!last && answered(a)) go(step + 1);
    else if (complete) send();
    else {
      const missing = answers.findIndex((x) => !answered(x));
      if (missing >= 0 && missing !== step) go(missing);
    }
  };

  usePromptKeys(!sent, (e) => {
    if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key) - 1;
      if (n < q.options.length) {
        e.preventDefault();
        toggle(q.options[n].label);
      } else if (n === q.options.length) {
        e.preventDefault();
        chooseOther();
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      advance();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      send(true);
    } else if (qs.length > 1 && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const to = step + (e.key === 'ArrowRight' ? 1 : -1);
      if (to >= 0 && to < qs.length) {
        e.preventDefault();
        go(to);
      }
    }
  });

  if (!q) return null;

  return (
    <section className="pc qc glass-card" data-spot aria-label="Questions from the agent">
      <header className="qc-head">
        {q.header && <span className="qc-chip">{q.header}</span>}
        {qs.length > 1 && (
          <div className="qc-stepper">
            <button type="button" className="icon-btn qc-step" aria-label="Previous question" disabled={step === 0} onClick={() => go(step - 1)}>
              <Icon name="caret-left" size={12} />
            </button>
            <span className="qc-count num">
              {step + 1} of {qs.length}
            </span>
            <button type="button" className="icon-btn qc-step" aria-label="Next question" disabled={last} onClick={() => go(step + 1)}>
              <Icon name="caret-right" size={12} />
            </button>
          </div>
        )}
        {more > 0 && <span className="pc-more">{more} more waiting</span>}
      </header>

      <AnimatePresence mode="popLayout" initial={false} custom={dir}>
        <motion.div
          key={step}
          className="qc-page"
          custom={dir}
          initial={{ opacity: 0, x: dir * 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: dir * -24, transition: { duration: 0.12 } }}
          transition={{ type: 'spring', stiffness: 460, damping: 38 }}
        >
          <h3 className="pc-title qc-question">{q.question}</h3>
          {multi && <p className="pc-desc">Choose any that apply</p>}
          <div className="qc-options" role={multi ? 'group' : 'radiogroup'} aria-label={q.question}>
            {q.options.map((o, i) => {
              const on = a.picked.includes(o.label);
              return (
                <button key={o.label} type="button" role={multi ? 'checkbox' : 'radio'} aria-checked={on} className="qc-opt" data-on={on || undefined} onClick={() => toggle(o.label)}>
                  <span className={multi ? 'qc-mark qc-box' : 'qc-mark qc-radio'} aria-hidden>
                    {on && (multi ? <Icon name="check" size={11} /> : <i />)}
                  </span>
                  <span className="qc-opt-text">
                    <span className="qc-opt-label">{o.label}</span>
                    {o.description && <span className="qc-opt-desc">{o.description}</span>}
                  </span>
                  {i < 9 && <KeyHint k={String(i + 1)} />}
                </button>
              );
            })}
            {a.other === null ? (
              <button type="button" role={multi ? 'checkbox' : 'radio'} aria-checked={false} className="qc-opt qc-other" onClick={chooseOther}>
                <span className={multi ? 'qc-mark qc-box' : 'qc-mark qc-radio'} aria-hidden />
                <span className="qc-opt-text">
                  <span className="qc-opt-label">Other</span>
                </span>
                {q.options.length < 9 && <KeyHint k={String(q.options.length + 1)} />}
              </button>
            ) : (
              <div className="qc-opt qc-other" data-on={a.other.trim() ? true : undefined}>
                <span className={multi ? 'qc-mark qc-box' : 'qc-mark qc-radio'} aria-hidden>
                  {a.other.trim() && (multi ? <Icon name="check" size={11} /> : <i />)}
                </span>
                <input
                  ref={otherRef}
                  autoFocus
                  className="qc-other-field"
                  placeholder="Write your own answer"
                  aria-label="Your own answer"
                  value={a.other}
                  onChange={(e) => update((cur) => ({ ...cur, other: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      advance();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      if (!a.other?.trim()) update((cur) => ({ ...cur, other: null }));
                      focusComposer();
                    }
                  }}
                />
              </div>
            )}
          </div>
        </motion.div>
      </AnimatePresence>

      <div className="pc-foot qc-foot">
        <button type="button" className="btn btn-ghost" disabled={sent} onClick={() => send(true)}>
          Skip
          <KeyHint k="Esc" />
        </button>
        <span className="grow" />
        {!last && (
          <button type="button" className="btn" disabled={!answered(a)} onClick={() => go(step + 1)}>
            Next
            <KeyHint k="↵" />
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={!complete || sent} onClick={() => send()}>
          Send answers
          {last && <KeyHint k="↵" />}
        </button>
      </div>
    </section>
  );
}
