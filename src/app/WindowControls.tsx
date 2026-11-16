import { useEffect, useState } from 'react';
import { windowShell, type WindowState } from '@/lib/desktop';
import { Tip } from '@/ui';

/**
 * Minimise, maximise / restore and close for the desktop app on Windows and Linux (the shell hides
 * the native caption buttons; macOS keeps its traffic lights). Drawn like the app's own icon buttons:
 * the same 28 px pill, 1 px line glyphs, hover and press. Fixed to the window's top right corner, on
 * the top row's centre line; each hit area runs the full strip tall and the last one to the window
 * edge, so the corner pixel closes the window. Space for them is kept free by `html[data-wc]`
 * (app.css), set here before the first paint so nothing shifts.
 */
if (windowShell && typeof document !== 'undefined') document.documentElement.dataset.wc = '';

const INITIAL: WindowState = { maximized: false, focused: true, fullScreen: false };

export function WindowControls() {
  const shell = windowShell;
  const [state, setState] = useState<WindowState>(INITIAL);

  useEffect(() => {
    if (!shell) return;
    let live = true;
    shell
      .getState()
      .then((s) => live && setState(s))
      .catch(() => {});
    const off = shell.onState(setState);
    return () => {
      live = false;
      off();
    };
  }, [shell]);

  // Full screen has no window to control: the controls and the room kept for them go.
  useEffect(() => {
    if (!shell) return;
    const root = document.documentElement;
    if (state.fullScreen) delete root.dataset.wc;
    else root.dataset.wc = '';
  }, [shell, state.fullScreen]);

  if (!shell || state.fullScreen) return null;

  // Called without arguments: the preload's functions cross the context bridge, which tries to clone
  // whatever is passed (a click event cannot be cloned, so passing the handler directly throws).
  const minimize = () => shell.minimize();
  const toggleMaximize = () => shell.toggleMaximize();
  const close = () => shell.close();

  return (
    <div className="wc" role="group" aria-label="Window" data-blur={!state.focused || undefined}>
      <span className="wc-sep" aria-hidden />
      <Tip label="Minimize">
        <button type="button" className="wc-btn" aria-label="Minimize" onClick={minimize}>
          <span className="wc-pill">
            <CaptionGlyph kind="min" />
          </span>
        </button>
      </Tip>
      <Tip label={state.maximized ? 'Restore' : 'Maximize'}>
        <button type="button" className="wc-btn" aria-label={state.maximized ? 'Restore' : 'Maximize'} onClick={toggleMaximize}>
          <span className="wc-pill">
            <CaptionGlyph kind={state.maximized ? 'restore' : 'max'} />
          </span>
        </button>
      </Tip>
      <Tip label="Close">
        <button type="button" className="wc-btn wc-close" aria-label="Close" onClick={close}>
          <span className="wc-pill">
            <CaptionGlyph kind="close" />
          </span>
        </button>
      </Tip>
    </div>
  );
}

/**
 * The caption glyphs on a 16 px grid with 1 px strokes, the same weight as the app's line icons at
 * 16 px. Straight edges sit on half pixels so they stay sharp at 100 %.
 */
function CaptionGlyph({ kind }: { kind: 'min' | 'max' | 'restore' | 'close' }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon={`wc-${kind}`}
      aria-hidden
    >
      {kind === 'min' && <path d="M3.5 8.5h9" />}
      {kind === 'max' && <rect x="3.5" y="3.5" width="9" height="9" rx="1.75" />}
      {kind === 'restore' && (
        <>
          <rect x="3.5" y="5.5" width="7" height="7" rx="1.5" />
          <path d="M5.5 5.5V5a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 12.5 5v4a1.5 1.5 0 0 1-1.5 1.5h-.5" />
        </>
      )}
      {kind === 'close' && <path d="M4 4l8 8M12 4l-8 8" />}
    </svg>
  );
}
