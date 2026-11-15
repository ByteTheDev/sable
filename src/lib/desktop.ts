/**
 * The desktop shell's bridge (electron/preload.ts), present only inside the Electron app.
 * Everything here is optional: the plain browser build runs without it.
 */
export interface DesktopShell {
  platform: string;
  version: string;
  debug: boolean;
  /** The system's folder dialog; null when cancelled. Missing on older shells. */
  pickFolder?: (startIn?: string) => Promise<string | null>;
  /** The real path of a dropped or picked file; empty when it has none (pasted). Missing on older shells. */
  pathForFile?: (file: File) => string;
  /** Tells the shell how tall the title strip is (CSS pixels) so the native buttons match it. */
  setTitleBarHeight?: (height: number) => void;
}

export const desktop: DesktopShell | undefined = typeof window === 'undefined' ? undefined : (window as { sableDesktop?: DesktopShell }).sableDesktop;

/** A dropped or picked file's real path in the desktop app; undefined in the browser or when it has none. */
export function pathForFile(file: File): string | undefined {
  try {
    return desktop?.pathForFile?.(file) || undefined;
  } catch {
    return undefined;
  }
}

/** True when the native folder dialog replaces the in-app folder browser. */
export const hasNativeFolderPicker = !!desktop?.pickFolder;

/**
 * Window Controls Overlay: the native minimise / maximise / close buttons drawn over the page
 * (Windows and Linux desktop builds). Returns their width in viewport pixels, or null without them.
 */
export function windowControlsWidth(): number | null {
  const wco = (navigator as { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay;
  if (!wco?.visible) return null;
  const r = wco.getTitlebarAreaRect();
  // The title bar area is what is left of the window beside the buttons (they sit on the right here).
  const right = window.innerWidth - (r.x + r.width);
  return right > 0 ? right : null;
}

export function onWindowControlsChange(fn: () => void): () => void {
  const wco = (navigator as { windowControlsOverlay?: EventTarget }).windowControlsOverlay;
  wco?.addEventListener('geometrychange', fn);
  window.addEventListener('resize', fn);
  return () => {
    wco?.removeEventListener('geometrychange', fn);
    window.removeEventListener('resize', fn);
  };
}
