import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Ring } from '@/art/Logo';
import { Icon } from '@/icons';
import { parseAnsi } from '@/lib/ansi';
import { baseName, formatDuration } from '@/lib/format';
import { useNow } from '@/lib/view-hooks';
import { IconButton, Tip } from '@/ui';
import { clearRuns, getHistory, getRuns, killLatest, killRun, runCommand, useTermVersion, type TermRun } from './term-store';

const STICK = 40;

/** A command runner for the session's folder: a transcript of runs over a pinned input. */
export function TerminalTab({ sessionId, cwd, active }: { sessionId: string; cwd: string; active: boolean }) {
  useTermVersion();
  const runs = getRuns(sessionId);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const stuck = useRef(true);
  const lastTop = useRef(0);
  const [value, setValue] = useState('');
  const histIndex = useRef<number | null>(null);
  const draft = useRef('');

  // A signature of everything visible, so the tail follows output.
  const sig = runs.map((r) => `${r.id}:${r.v}`).join(',');
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) {
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    }
  }, [sig]);

  // Output that changes size after render (wrapping, fonts, the panel resizing) keeps the tail in view.
  const runsBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    const box = runsBox.current;
    if (!el || !box) return;
    const ro = new ResizeObserver(() => {
      if (!stuck.current) return;
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    });
    ro.observe(box);
    ro.observe(el);
    return () => ro.disconnect();
  }, [runs.length > 0]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
  }, [active]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Only a deliberate scroll up, away from the end, stops following the tail.
    if (el.scrollTop < lastTop.current - 1 && dist > STICK) stuck.current = false;
    else if (dist <= STICK) stuck.current = true;
    lastTop.current = el.scrollTop;
  };

  const submit = () => {
    const cmd = value.trim();
    if (!cmd) return;
    if (cmd === 'clear' || cmd === 'cls') {
      clearRuns(sessionId);
    } else {
      stuck.current = true;
      runCommand(sessionId, cwd, cmd);
    }
    setValue('');
    histIndex.current = null;
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const hist = getHistory(sessionId);
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp') {
      if (!hist.length) return;
      e.preventDefault();
      if (histIndex.current === null) {
        draft.current = value;
        histIndex.current = hist.length - 1;
      } else histIndex.current = Math.max(0, histIndex.current - 1);
      setValue(hist[histIndex.current]);
    } else if (e.key === 'ArrowDown') {
      if (histIndex.current === null) return;
      e.preventDefault();
      if (histIndex.current >= hist.length - 1) {
        histIndex.current = null;
        setValue(draft.current);
      } else {
        histIndex.current++;
        setValue(hist[histIndex.current]);
      }
    } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      clearRuns(sessionId);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'c' && !hasSelection(e.currentTarget)) {
      // Ctrl+C on an empty selection stops the newest run, like a terminal.
      if (killLatest(sessionId)) e.preventDefault();
    }
  };

  const onTranscriptKey = (e: React.KeyboardEvent) => {
    if (!e.ctrlKey || e.shiftKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'c' && !window.getSelection()?.toString()) {
      if (killLatest(sessionId)) e.preventDefault();
    } else if (k === 'l') {
      e.preventDefault();
      clearRuns(sessionId);
    }
  };

  const running = runs.some((r) => r.state === 'running' || r.state === 'starting');

  return (
    <div className="rail-col tm">
      <div className="rail-bar">
        <Tip label={cwd}>
          <span className="rail-bar-title truncate">
            <Icon name="folder" size={14} />
            <span className="truncate">{baseName(cwd)}</span>
          </span>
        </Tip>
        <span className="rail-bar-actions">
          {running && <IconButton icon="stop" label="Stop the newest command" keys="Ctrl+c" size={12} onClick={() => killLatest(sessionId)} />}
          {runs.length > 0 && <IconButton icon="broom" label="Clear" keys="Ctrl+l" size={14} onClick={() => clearRuns(sessionId)} />}
        </span>
      </div>
      <div
        className="rail-scroll scroll tm-scroll"
        ref={scroller}
        onScroll={onScroll}
        tabIndex={0}
        role="log"
        aria-label="Command output"
        onKeyDown={onTranscriptKey}
        onMouseUp={() => {
          if (!window.getSelection()?.toString()) input.current?.focus({ preventScroll: true });
        }}
      >
        {runs.length === 0 ? (
          <p className="rail-empty">No commands run yet.</p>
        ) : (
          <div className="tm-runs" ref={runsBox}>
            {runs.map((r) => (
              <RunView key={r.id} run={r} v={r.v} />
            ))}
          </div>
        )}
      </div>
      <div className="tm-input-wrap">
        <label className="tm-input" data-busy={running || undefined}>
          <span className="tm-mark" aria-hidden>
            ❯
          </span>
          <input
            ref={input}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              histIndex.current = null;
            }}
            onKeyDown={onInputKey}
            placeholder="Run a command"
            aria-label="Run a command"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
          />
        </label>
      </div>
    </div>
  );
}

function hasSelection(el: HTMLInputElement) {
  return el.selectionStart !== el.selectionEnd;
}

const RunView = memo(function RunView({ run }: { run: TermRun; v: number }) {
  const live = run.state === 'running' || run.state === 'starting';
  const now = useNow(live, 1000);
  const ok = run.state === 'done' && run.code === 0;
  const failed = run.state === 'failed' || (run.state === 'done' && run.code !== 0);
  const tone = live ? 'live' : ok ? 'ok' : run.state === 'failed' ? 'warn' : failed ? 'fail' : 'quiet';
  const stop = useCallback(() => killRun(run), [run]);
  const body = useMemo(
    () =>
      run.chunks.map((c, i) =>
        parseAnsi(c.t).map((sp, j) => (
          <span key={`${i}.${j}`} className={[c.s === 'err' && !sp.cls ? 'tm-err' : '', sp.cls ?? ''].join(' ').trim() || undefined}>
            {sp.text}
          </span>
        )),
      ),
    // `run.v` changes whenever chunks change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, run.v],
  );
  const hasOut = run.size > 0;
  const dur = (run.endedAt ?? now) - run.startedAt;

  return (
    <div className="tm-run" data-tone={tone}>
      <div className="tm-cmd">
        <span className="tm-mark" aria-hidden>
          ❯
        </span>
        <code className="tm-cmd-text">{run.command}</code>
        {live && (
          <Tip label={run.stopping ? 'Stopping' : 'Stop'}>
            <button type="button" className="tm-stop" aria-label="Stop command" onClick={stop} disabled={run.stopping || run.state === 'starting'}>
              <Icon name="stop" size={10} />
            </button>
          </Tip>
        )}
      </div>
      {run.trimmed && <div className="tm-trim">Earlier output trimmed</div>}
      {hasOut && <pre className="tm-out">{body}</pre>}
      {run.error && <div className="tm-error">{run.error}</div>}
      <div className="tm-foot num">
        {live ? (
          <>
            <Ring size={11} />
            <span>{run.stopping ? 'Stopping' : 'Running'}</span>
            <span className="tm-sep" />
            <span>{formatDuration(Math.max(0, dur))}</span>
          </>
        ) : run.state === 'failed' ? (
          <span>Did not start</span>
        ) : (
          <>
            <span className="tm-exit">{run.state === 'killed' ? 'Stopped' : run.code === null || run.code === undefined ? 'Ended' : `Exit ${run.code}`}</span>
            <span className="tm-sep" />
            <span>{formatDuration(dur)}</span>
            {!hasOut && run.state === 'done' && (
              <>
                <span className="tm-sep" />
                <span>No output</span>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
});
