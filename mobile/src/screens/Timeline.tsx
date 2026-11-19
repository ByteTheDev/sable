import { animate } from 'motion';
import { AnimatePresence, motion } from 'motion/react';
import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { NoticeItem, PhoneItem, TextItem, ThinkingItem, TimelineItem, ToolItem, TurnItem, UntilCheck, UserItem } from '@shared/protocol';
import { formatDuration, formatTokens, plural, resetIn } from '@desk/lib/format';
import { useNow } from '@m/lib/useNow';
import { conn } from '@m/lib/conn';
import { diffLines, renderMarkdown } from '@m/lib/md';
import { haptic } from '@m/lib/native';
import { applyChildren, applyFull, fetchItem, sessionData, setState, useStore } from '@m/lib/store';
import { takeFlight } from '@m/lib/flight';
import type { Turn } from '@m/lib/turns';
import { Icon, TOOL_ICON } from '@m/ui/icons';
import { Ring, Tiles } from '@m/ui/marks';

const useItem = <T extends TimelineItem>(sid: string, id: string | undefined) => useStore((s) => (id ? (sessionData(s, sid).items[id] as T | undefined) : undefined));

/** One turn: your message, the steps folded to a line, sub-agents and workflows as blocks, notices, the answer. */
export const TurnView = memo(function TurnView({ sid, turn, live }: { sid: string; turn: Turn; live: boolean }) {
  return (
    <section className="turn" data-live={live || undefined}>
      {turn.user && <UserBubble sid={sid} id={turn.user} />}
      {(turn.steps.length > 0 || live) && <Steps sid={sid} turn={turn} live={live} />}
      {turn.blocks.map((id) => (
        <Block key={id} sid={sid} id={id} />
      ))}
      {turn.steered.map((id) => (
        <UserBubble key={id} sid={sid} id={id} steered />
      ))}
      {turn.notices.map((id) => (
        <Notice key={id} sid={sid} id={id} />
      ))}
      {turn.answer.map((id) => (
        <Answer key={id} sid={sid} id={id} />
      ))}
      {turn.ends.map((id) => (
        <Notice key={id} sid={sid} id={id} />
      ))}
    </section>
  );
});

const UserBubble = memo(function UserBubble({ sid, id, steered }: { sid: string; id: string; steered?: boolean }) {
  const it = useItem<UserItem>(sid, id);
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);

  // The message flies from the composer to where it lands (lib/flight.ts records where it left).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !it) return;
    setLong(el.scrollHeight > 260);
    const f = takeFlight(it.text);
    if (!f) return;
    // Land where it will rest: the conversation is at its newest line before measuring.
    const sc = el.closest('.thread');
    if (sc) sc.scrollTop = sc.scrollHeight;
    const r = el.getBoundingClientRect();
    const dx = f.rect.right - r.right;
    const dy = f.rect.bottom - r.bottom;
    animate(el, { x: [dx, 0], y: [dy, 0], scale: [0.96, 1], opacity: [0.5, 1] }, { type: 'spring', stiffness: 420, damping: 36, mass: 0.9 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!it]);

  if (!it) return null;
  // A failing `/until` check Sable sent back: the check's row, not a message.
  if (it.until?.check) return <CheckRow check={it.until.check} />;
  const images = it.attachments?.filter((a) => a.dataUrl && a.kind === 'image') ?? [];
  const files = it.attachments?.filter((a) => !(a.dataUrl && a.kind === 'image')) ?? [];
  return (
    <div className="user-row" data-steered={steered || undefined}>
      <div ref={ref} className="user-bubble glass" data-long={long && !open ? true : undefined} onClick={() => long && setOpen((v) => !v)}>
        {images.length > 0 && (
          <div className="user-images">
            {images.map((a) => (
              <img key={a.id} src={a.dataUrl} alt={a.name} />
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="user-files">
            {files.map((a) => (
              <span key={a.id} className="file-chip">
                <Icon name="file" size={13} /> {a.name}
              </span>
            ))}
          </div>
        )}
        {it.text && <div className="user-text">{it.text}</div>}
        {long && !open && <div className="user-more">Show more</div>}
      </div>
      {steered && <span className="user-note">Steered</span>}
    </div>
  );
});

/** The steps of a turn on one line: live while it runs (what it does now, the last few steps), a summary once done. */
function Steps({ sid, turn, live }: { sid: string; turn: Turn; live: boolean }) {
  const [open, setOpen] = useState(false);
  const activity = useStore((s) => s.sessions[sid]?.activity);
  const end = useItem<TurnItem>(sid, turn.end);
  const first = useItem<UserItem>(sid, turn.user);
  const lastStep = useItem<TimelineItem>(sid, turn.steps[turn.steps.length - 1]);
  const n = turn.steps.length;
  const tokens = (end?.inputTokens ?? 0) + (end?.outputTokens ?? 0);

  // While it runs, the step in progress is the line itself; the trail under it shows the ones before.
  const current = live && ((lastStep?.type === 'thinking' && lastStep.streaming) || (lastStep?.type === 'tool' && (lastStep.status === 'running' || lastStep.status === 'pending')));
  const trail = open ? turn.steps : current ? turn.steps.slice(-4, -1) : turn.steps.slice(-3);
  const label = live
    ? activity || (lastStep?.type === 'tool' ? lastStep.title : lastStep?.type === 'thinking' ? 'Thinking' : 'Working')
    : end
      ? `Worked ${formatDuration(end.durationMs)}${n ? ` · ${plural(n, 'step')}` : ''}`
      : plural(n, 'step');

  return (
    <div className="steps" data-open={open || undefined}>
      <button
        type="button"
        className="steps-line"
        onClick={() => {
          if (!n) return;
          haptic('select');
          setOpen((v) => !v);
        }}
        aria-expanded={open}
      >
        {live ? <Tiles size={13} /> : <Icon name="todo" size={15} />}
        <span className={live ? 'steps-label shimmer' : 'steps-label'}>{label}</span>
        {!live && first && end && tokens > 0 && <span className="steps-meta num">{formatTokens(tokens)}</span>}
        {n > 0 && <Icon name="caretDown" size={13} weight="bold" className="steps-caret" />}
      </button>
      <AnimatePresence initial={false}>
        {(open || live) && trail.length > 0 && (
          <motion.div
            className="steps-list"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 40 }}
          >
            {trail.map((id) => (
              <Step key={id} sid={sid} id={id} quiet={!open} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const Step = memo(function Step({ sid, id, quiet }: { sid: string; id: string; quiet?: boolean }) {
  const it = useItem<TimelineItem>(sid, id);
  const [open, setOpen] = useState(false);
  // The desktop keeps a step's output and change: asked for when the step opens.
  const [full, setFull] = useState<ToolItem>();
  if (!it) return null;
  if (it.type === 'thinking') return <ThinkingStep sid={sid} it={it} quiet={quiet} />;
  if (it.type === 'text') return <div className="step-text">{it.text.length > 280 ? `${it.text.slice(0, 280)}…` : it.text}</div>;
  if (it.type !== 'tool') return null;
  const more = !!(it as PhoneItem).more;
  const detail = toolDetail(full ?? it);
  const status = it.status;
  const toggle = () => {
    if (quiet || !(detail || more)) return;
    if (more && !full && !open) void fetchItem(sid, id).then((r) => setFull(r.item as ToolItem), () => {});
    setOpen((v) => !v);
  };
  return (
    <div className="step" data-status={status}>
      <button type="button" className="step-line" onClick={toggle} disabled={quiet || !(detail || more)}>
        <span className="step-icon">{status === 'running' || status === 'pending' ? <Ring size={13} /> : <Icon name={TOOL_ICON[it.kind] ?? 'tool'} size={15} />}</span>
        <span className="step-title">{it.title}</span>
        {it.result?.diff && <DiffStat diff={it.result.diff} />}
        {(status === 'error' || status === 'denied') && <span className="step-flag">{status === 'denied' ? 'Denied' : 'Failed'}</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && (detail || more) && (
          <motion.pre className="step-detail" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 40 }}>
            {detail && <Detail d={detail} />}
            {more && !full && <span className="step-detail-wait skel" aria-label="Loading" />}
          </motion.pre>
        )}
      </AnimatePresence>
    </div>
  );
});

function ThinkingStep({ sid, it, quiet }: { sid: string; it: ThinkingItem; quiet?: boolean }) {
  const [open, setOpen] = useState(false);
  const secs = it.endedAt ? Math.max(1, Math.round((it.endedAt - it.ts) / 1000)) : 0;
  const toggle = () => {
    if (quiet || !it.text) return;
    if ((it as PhoneItem).cut && !open && !it.streaming) void fetchItem(sid, it.id).then((r) => applyFull(sid, r.item), () => {});
    setOpen((v) => !v);
  };
  return (
    <div className="step">
      <button type="button" className="step-line" onClick={toggle} disabled={quiet || !it.text}>
        <span className="step-icon">{it.streaming ? <Ring size={13} /> : <Icon name="brain" size={15} />}</span>
        <span className="step-title">{it.streaming ? 'Thinking' : secs ? `Thought for ${secs}s` : 'Thought'}</span>
      </button>
      {open && <div className="step-think">{it.text}</div>}
    </div>
  );
}

/** What a step did, for its detail: the command or target, the first lines of output, the first hunks of a change. */
function toolDetail(it: ToolItem): { head?: string; out?: string; diff?: string } | null {
  const d = it.detail;
  const head = d.command ? `$ ${d.command}` : d.path || d.url || (d.query || d.pattern ? String(d.query ?? d.pattern) : undefined);
  let out: string | undefined;
  const res = it.output || it.result?.text || it.result?.stderr;
  if (res) {
    const lines = res.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
    out = (lines.slice(0, 24).join('\n') + (lines.length > 24 ? `\n… ${lines.length - 24} more lines` : '')).slice(0, 3000);
  }
  let diff: string | undefined;
  if (it.result?.diff?.length) {
    const parts: string[] = [];
    for (const f of it.result.diff.slice(0, 3)) for (const h of f.hunks.slice(0, 2)) parts.push(h.lines.slice(0, 16).join('\n'));
    diff = parts.join('\n').slice(0, 3000);
  }
  return head || out || diff ? { head, out: diff ? undefined : out, diff } : null;
}

function Detail({ d }: { d: NonNullable<ReturnType<typeof toolDetail>> }) {
  return (
    <>
      {d.head && <span className="step-detail-head">{d.head}</span>}
      {d.out && `${d.head ? '\n' : ''}${d.out}`}
      {d.diff && (
        <>
          {d.head ? '\n' : ''}
          <span dangerouslySetInnerHTML={{ __html: diffLines(d.diff) }} />
        </>
      )}
    </>
  );
}

function DiffStat({ diff }: { diff: NonNullable<ToolItem['result']>['diff'] }) {
  const add = diff?.reduce((n, f) => n + f.additions, 0) ?? 0;
  const del = diff?.reduce((n, f) => n + f.deletions, 0) ?? 0;
  if (!add && !del) return null;
  return (
    <span className="diffstat num">
      {add > 0 && <span className="add">+{add}</span>}
      {del > 0 && <span className="del">−{del}</span>}
    </span>
  );
}

/** Sub-agents, workflows and widgets as compact blocks. */
const Block = memo(function Block({ sid, id }: { sid: string; id: string }) {
  const it = useItem<ToolItem>(sid, id);
  const known = useStore((s) => sessionData(s, sid).children[id]?.length ?? 0);
  if (!it) return null;
  const kids = Math.max(known, (it as PhoneItem).kids ?? 0);
  if (it.kind === 'widget') {
    const title = (it.input as { title?: string } | undefined)?.title ?? it.title;
    return (
      <div className="block block-quiet">
        <Icon name="cube" size={16} />
        <span className="block-title">{title}</span>
        <span className="block-aside">Open on the desktop</span>
      </div>
    );
  }
  const w = it.workflow;
  if (w) {
    const running = w.agents.filter((a) => a.state === 'running').length;
    const done = w.agents.filter((a) => a.state === 'done').length;
    return (
      <div className="block">
        <div className="block-head">
          <span className="block-icon">{w.status === 'running' ? <Ring size={14} /> : <Icon name="workflow" size={16} />}</span>
          <span className="block-title">{w.name ?? 'Workflow'}</span>
          <span className="block-aside num">{w.phases.length ? `Phase ${Math.max(1, w.phase)} of ${w.phases.length}` : statusWord(w.status)}</span>
        </div>
        {w.agents.length > 0 && (
          <div className="block-agents" aria-label={`${running} running, ${done} done of ${w.agents.length}`}>
            {w.agents.slice(0, 40).map((a) => (
              <i key={a.index} data-state={a.state} />
            ))}
          </div>
        )}
        <div className="block-sub num">
          {[running && `${running} running`, done && `${done} done`, w.tokens && `${formatTokens(w.tokens)} tokens`, w.durationMs && formatDuration(w.durationMs)].filter(Boolean).join(' · ') || plural(w.agents.length, 'agent')}
        </div>
      </div>
    );
  }
  const stats = it.result?.agent;
  const bg = stats?.background;
  const runningNow = it.status === 'running' || it.status === 'pending' || bg === 'running';
  const name = it.detail.subagent || it.title;
  return <AgentBlock sid={sid} id={id} it={it} name={name} running={runningNow} background={!!bg} kids={kids} />;
});

/** A sub-agent: what it was asked, how far it got; a tap opens its own steps (the last 40). */
function AgentBlock({ sid, id, it, name, running, background, kids }: { sid: string; id: string; it: ToolItem; name: string; running: boolean; background: boolean; kids: number }) {
  const [open, setOpen] = useState(false);
  const children = useStore((s) => (open ? sessionData(s, sid).children[id] : undefined));
  const stats = it.result?.agent;
  const steps = (children ?? []).slice(-40);
  const toggle = () => {
    haptic('select');
    // Its steps stay on the desktop until asked for (the last 40).
    if (!open) void fetchItem(sid, id).then((r) => applyChildren(sid, id, r.children), () => {});
    setOpen((v) => !v);
  };
  return (
    <div className="block" data-open={open || undefined}>
      <button type="button" className="block-toggle" aria-expanded={open} disabled={!kids} onClick={toggle}>
        <span className="block-head">
          <span className="block-icon">{running ? <Ring size={14} /> : <Icon name="agent" size={16} />}</span>
          <span className="block-title">{name}</span>
          <span className="block-aside">{it.status === 'error' ? 'Failed' : running ? (background ? 'In the background' : 'Working') : 'Done'}</span>
        </span>
        {it.detail.description && it.detail.description !== name && <span className="block-desc">{it.detail.description}</span>}
        <span className="block-sub num">
          {[stats?.steps ? plural(stats.steps, 'step') : kids ? plural(kids, 'step') : '', stats?.tokens && `${formatTokens(stats.tokens)} tokens`, stats?.durationMs && formatDuration(stats.durationMs)].filter(Boolean).join(' · ')}
          {kids > 0 && <Icon name="caretDown" size={12} weight="bold" className="block-caret" />}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && steps.length > 0 && (
          <motion.div
            className="block-steps"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 40 }}
          >
            {steps.map((cid) => (
              <Step key={cid} sid={sid} id={cid} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const statusWord = (s: string) => (s === 'running' ? 'Running' : s === 'done' ? 'Done' : s === 'failed' ? 'Failed' : 'Stopped');

const Notice = memo(function Notice({ sid, id }: { sid: string; id: string }) {
  const it = useItem<NoticeItem>(sid, id);
  const provider = useStore((s) => s.sessions[sid]?.provider);
  const accounts = useStore((s) => (provider ? s.providers[provider]?.accounts : undefined));
  const [busy, setBusy] = useState(false);
  if (!it) return null;
  // At a plan limit: carry on with the account the desktop suggests (the refused message goes again).
  const next = it.limit?.next && !it.limit.continuedWith ? accounts?.find((a) => a.id === it.limit!.next && a.auth.loggedIn) : undefined;
  if (it.limit) return <LimitCard sid={sid} it={it} next={next} went={it.limit.continuedWith ? (accounts?.find((a) => a.id === it.limit!.continuedWith)?.label ?? 'another account') : undefined} />;
  if (it.until) return <UntilEnd it={it} />;
  return (
    <div className="notice" data-variant={it.variant}>
      {it.variant === 'error' && <Icon name="warning" size={15} />}
      <span>
        {it.text}
        {it.detail && <span className="notice-detail"> · {it.detail}</span>}
        {next && (
          <button
            type="button"
            className="btn btn-sm notice-action"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              haptic('send');
              void conn.call('session.switchAccount', { sessionId: sid, accountId: next.id, retry: true }).finally(() => setBusy(false));
            }}
          >
            Continue with {next.label}
          </button>
        )}
      </span>
    </div>
  );
});

/** A `/until` check: one quiet row (passed or failed, its round); a tap shows the first lines of its output. */
function CheckRow({ check }: { check: UntilCheck }) {
  const [open, setOpen] = useState(false);
  const out = check.output?.trim();
  const shown = out ? out.split('\n').slice(0, 14).join('\n') : '';
  const result = check.passed ? (check.passing ? `${check.passing} passed` : '') : check.timedOut ? 'Timed out' : check.failing ? `${check.failing} failing` : check.exitCode != null ? `exit ${check.exitCode}` : '';
  return (
    <div className="step check-row" data-status={check.passed ? 'done' : 'error'}>
      <button type="button" className="step-line" disabled={!out} aria-expanded={out ? open : undefined} onClick={() => (haptic('select'), setOpen((v) => !v))}>
        <span className="step-icon">
          <Icon name={check.passed ? 'check' : 'x'} size={14} weight="bold" />
        </span>
        <span className="step-title">{check.passed ? 'Check passed' : 'Check failed'}</span>
        {result && <span className="check-result num">{result}</span>}
        <span className="check-round num">
          {check.round} of {check.rounds}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && out && (
          <motion.pre className="step-detail" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 40 }}>
            <span className="step-detail-head">$ {check.command}</span>
            {`\n${shown}`}
          </motion.pre>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Where a `/until` loop ended: its last check, then one calm line. */
function UntilEnd({ it }: { it: NoticeItem }) {
  const end = it.until?.end;
  return (
    <div className="until-end">
      {it.until?.check && <CheckRow check={it.until.check} />}
      <div className="until-line" data-end={end}>
        <Icon name={end === 'passed' ? 'check' : 'hand'} size={13} weight={end === 'passed' ? 'bold' : 'regular'} />
        <span>{it.text}</span>
      </div>
    </div>
  );
}

/** A turn refused at a plan limit: which window, when it resets, and the account to carry on with. */
function LimitCard({ sid, it, next, went }: { sid: string; it: NoticeItem; next?: { id: string; label: string }; went?: string }) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const l = it.limit!;
  return (
    <div className="limit-card">
      <div className="limit-card-head">
        <span className="limit-card-dot" aria-hidden />
        <span className="limit-card-title">{l.window ? `${l.window} reached` : it.text}</span>
        {l.resetsAt && <span className="limit-card-reset num">{resetIn(l.resetsAt, now)}</span>}
      </div>
      {it.detail && <div className="limit-card-detail">{it.detail}</div>}
      {next && (
        <button
          type="button"
          className="btn btn-primary limit-card-go"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            haptic('send');
            void conn.call('session.switchAccount', { sessionId: sid, accountId: next.id, retry: true }).finally(() => setBusy(false));
          }}
        >
          {busy ? <span className="dots" /> : `Continue with ${next.label}`}
        </button>
      )}
      {went && <div className="limit-card-detail">Carried on with {went}</div>}
    </div>
  );
}

const Answer = memo(function Answer({ sid, id }: { sid: string; id: string }) {
  const it = useItem<TextItem>(sid, id);
  const html = useMemo(() => (it ? renderMarkdown(it.text, it.streaming) : ''), [it]);
  const [busy, setBusy] = useState(false);
  if (!it || !it.text.trim()) return null;
  const cut = (it as PhoneItem).cut && !it.streaming;
  return (
    <>
      <div className="md" data-streaming={it.streaming || undefined} data-cut={cut || undefined} onClick={copyCode} dangerouslySetInnerHTML={{ __html: html }} />
      {cut && (
        <button
          type="button"
          className="btn btn-sm md-rest"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            haptic('select');
            void fetchItem(sid, id)
              .then((r) => applyFull(sid, r.item))
              .catch(() => setBusy(false));
          }}
        >
          {busy ? <span className="dots" /> : 'Show all'}
        </button>
      )}
    </>
  );
});

/** The copy key on a code block: its text to the clipboard, a short confirmation on the key itself. */
function copyCode(e: React.MouseEvent) {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.md-copy');
  const code = btn?.parentElement?.querySelector('code');
  if (!btn || !code) return;
  void navigator.clipboard
    ?.writeText(code.textContent ?? '')
    .then(() => {
      haptic('success');
      setState({ toast: { text: 'Copied', level: 'success', at: Date.now() } });
      btn.dataset.done = '';
      window.setTimeout(() => delete btn.dataset.done, 1400);
    })
    .catch(() => {});
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
