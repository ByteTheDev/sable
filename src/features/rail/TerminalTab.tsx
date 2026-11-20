import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import type { ProjectScript } from '@shared/protocol';
import { Ring } from '@/art/Logo';
import { Icon } from '@/icons';
import { parseAnsi } from '@/lib/ansi';
import { baseName, formatDuration } from '@/lib/format';
import { useNow } from '@/lib/view-hooks';
import { useStore } from '@/state/store';
import { IconButton, Menu, MenuContent, MenuLabel, MenuSep, MenuTrigger, Tip } from '@/ui';
import { DevUrlChip } from './DevUrlChip';
import { refreshScripts, scriptForCommand, useScripts } from './scripts-store';
import { clearRuns, getFocus, getHistory, getRuns, killLatest, killRun, restartRun, runCommand, runningScript, runScript, scriptKey, useTermVersion, type TermRun } from './term-store';

const STICK = 40;

/** A command runner for the session's folder: a transcript of runs over a pinned input, and the folder's scripts one choice away. */
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
  const scripts = useScripts(cwd);
  useScriptsFresh(sessionId, cwd, active, runs);

  // A script chosen from the Run control or the palette: its terminal comes into view (a running one, chosen again, also lights up once).
  const focus = getFocus(sessionId);
  const focusAt = useRef(0);
  useLayoutEffect(() => {
    if (!focus || focus.at === focusAt.current) return;
    focusAt.current = focus.at;
    // Only a choice just made: a tab that mounts again does not replay an old one.
    if (Date.now() - focus.at > 2000) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-run="${focus.runId}"]`);
    if (!el) return;
    const last = el === el.parentElement?.lastElementChild;
    stuck.current = last;
    if (last && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    else el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (focus.flash) {
      el.removeAttribute('data-flash');
      void el.offsetWidth;
      el.setAttribute('data-flash', '');
      window.setTimeout(() => el.removeAttribute('data-flash'), 900);
    }
  });

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
      // A typed script ("pnpm dev") carries the script's name, so Restart and the Run control know it.
      const script = scriptForCommand(scripts, cmd);
      runCommand(sessionId, cwd, cmd, script ? { name: script.name, script: scriptKey(script) } : undefined);
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
          <RunMenu
            sessionId={sessionId}
            cwd={cwd}
            onRun={(s) => {
              stuck.current = true;
              runScript(sessionId, cwd, s);
            }}
          />
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

/**
 * Keeps the folder's scripts current whenever they can be seen: when the tab shows, when a turn or
 * a command ends (either may have changed package.json), and when the window comes back (an editor
 * may have). Each ask costs the bridge a few stats unless the files changed.
 */
function useScriptsFresh(sessionId: string, cwd: string, active: boolean, runs: TermRun[]) {
  const status = useStore((s) => s.sessions[sessionId]?.status);
  const ended = runs.reduce((n, r) => n + (r.endedAt ? 1 : 0), 0);
  useEffect(() => {
    if (active && cwd) void refreshScripts(cwd);
  }, [active, cwd, status, ended]);
  useEffect(() => {
    if (!active || !cwd) return;
    const onFocus = () => document.visibilityState === 'visible' && void refreshScripts(cwd);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [active, cwd]);
}

const SOURCE_LABEL: Record<ProjectScript['source'], string> = { package: 'package.json', make: 'Makefile', python: 'pyproject.toml' };

/**
 * The folder's scripts behind one quiet "Run": each by its name, its command on hover. Choosing one
 * opens a terminal named after it; a script that runs already says so and brings its terminal into
 * view. Absent while the folder has none. Opening the menu reads the list again.
 */
function RunMenu({ sessionId, cwd, onRun }: { sessionId: string; cwd: string; onRun: (s: ProjectScript) => void }) {
  // Rendered with the tab, which follows every run (its "Running" marks stay current).
  const list = useScripts(cwd);
  const [open, setOpen] = useState(false);
  const scripts = list?.scripts ?? [];
  if (!scripts.length) return null;
  const groups: { source: ProjectScript['source']; items: ProjectScript[] }[] = [];
  for (const s of scripts) {
    const g = groups.find((x) => x.source === s.source);
    if (g) g.items.push(s);
    else groups.push({ source: s.source, items: [s] });
  }
  return (
    <Menu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void refreshScripts(cwd);
      }}
    >
      <MenuTrigger className="btn btn-sm btn-ghost tm-run-btn" aria-label="Run a script">
        <Icon name="play" size={11} />
        <span>Run</span>
        <Icon name="caret-down" size={9} className="tm-run-caret" />
      </MenuTrigger>
      <MenuContent align="end" width={224} className="tm-run-menu">
        {groups.map((g, i) => (
          <Fragment key={g.source}>
            {i > 0 && <MenuSep />}
            {groups.length > 1 && <MenuLabel>{SOURCE_LABEL[g.source]}</MenuLabel>}
            {g.items.map((s) => (
              <ScriptItem key={scriptKey(s)} script={s} running={!!runningScript(sessionId, cwd, scriptKey(s))} onRun={onRun} />
            ))}
          </Fragment>
        ))}
      </MenuContent>
    </Menu>
  );
}

function ScriptItem({ script, running, onRun }: { script: ProjectScript; running: boolean; onRun: (s: ProjectScript) => void }) {
  return (
    <Tip label={script.command} side="left">
      <RM.Item className="menu-item tm-script" onSelect={() => onRun(script)} aria-label={running ? `${script.name}, running` : script.name}>
        <span className="grow truncate">{script.name}</span>
        {running && <span className="hint">Running</span>}
      </RM.Item>
    </Tip>
  );
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
  // The server it started, while it runs: an address with nothing behind it is not offered.
  const url = live && !run.stopping ? run.urls[run.urls.length - 1] : undefined;
  const restarting = !!run.restart;

  return (
    <div className="tm-run" data-tone={tone} data-run={run.id}>
      <div className="tm-cmd">
        <span className="tm-mark" aria-hidden>
          ❯
        </span>
        {run.name ? (
          // A script's terminal: its name, then what it runs.
          <span className="tm-title">
            <span className="tm-name">{run.name}</span>
            <code className="tm-cmd-sub">{run.command}</code>
          </span>
        ) : (
          <code className="tm-cmd-text">{run.command}</code>
        )}
        {url && <DevUrlChip url={url.url} label={url.label} cwd={run.cwd} from={run.name ?? run.command} className="tm-url" />}
        {run.script && (
          <Tip label={live ? 'Restart' : 'Run again'}>
            <button type="button" className="tm-act tm-restart" aria-label={live ? 'Restart' : 'Run again'} onClick={() => restartRun(run)} disabled={run.state === 'starting' || restarting}>
              <Icon name="refresh" size={12} />
            </button>
          </Tip>
        )}
        {live && (
          <Tip label={run.stopping ? 'Stopping' : 'Stop'}>
            <button type="button" className="tm-act tm-stop" aria-label="Stop command" onClick={stop} disabled={run.stopping || run.state === 'starting'}>
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
            <span>{restarting ? 'Restarting' : run.stopping ? 'Stopping' : 'Running'}</span>
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
