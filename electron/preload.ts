import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * Sandboxed preload: the page gets a few facts about the shell, the native folder dialog, the window
 * commands behind its own minimise / maximise / close buttons, the real path of a dropped or
 * picked file (Electron's webUtils.getPathForFile), and three narrow calls for
 * the panel browser (capture its page, clear its data, hear about blocked downloads), nothing else.
 * The app version arrives as an extra argument from the main process.
 */
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

interface WindowState {
  maximized: boolean;
  focused: boolean;
  fullScreen: boolean;
}

const toState = (s: unknown): WindowState => {
  const o = (s ?? {}) as Partial<WindowState>;
  return { maximized: !!o.maximized, focused: o.focused !== false, fullScreen: !!o.fullScreen };
};

contextBridge.exposeInMainWorld('sableDesktop', {
  platform: process.platform,
  version: arg('sable-version') ?? '',
  /** True only for verification runs started with --eval. */
  debug: process.argv.includes('--sable-debug'),
  /** Shows the system's folder dialog; resolves to the chosen folder, or null when cancelled. */
  pickFolder: (startIn?: string): Promise<string | null> => ipcRenderer.invoke('sable:pick-folder', typeof startIn === 'string' ? startIn : undefined),
  /** The real path of a file the user dropped or picked (empty for pasted or generated files). */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  /** The page's own minimise / maximise / close buttons (Windows, Linux): three commands and the window's state. */
  window: {
    minimize: () => ipcRenderer.send('sable:window', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('sable:window', 'toggle-maximize'),
    close: () => ipcRenderer.send('sable:window', 'close'),
    getState: (): Promise<WindowState> => ipcRenderer.invoke('sable:window-state').then(toState),
    onState: (cb: (s: WindowState) => void) => {
      if (typeof cb !== 'function') return () => {};
      const listener = (_e: unknown, msg: unknown) => cb(toState(msg));
      ipcRenderer.on('sable:window-state', listener);
      return () => {
        ipcRenderer.removeListener('sable:window-state', listener);
      };
    },
  },
  browser: {
    /** `forAgent`: smaller, as JPEG, for the agent's browser_screenshot. */
    capture: (webContentsId: number, opts?: { forAgent?: boolean }): Promise<string> => ipcRenderer.invoke('sable:browser-capture', Number(webContentsId), !!opts?.forAgent),
    clearData: (): Promise<void> => ipcRenderer.invoke('sable:browser-clear'),
    /** Blocked downloads, Ctrl+F in a page, and failed requests of a page ('net': url without query, method, status or error). */
    onEvent: (cb: (e: { type: string; name?: string; id?: number; url?: string; method?: string; status?: number; error?: string }) => void) => {
      if (typeof cb !== 'function') return () => {};
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      const listener = (_e: unknown, msg: { type: string; name?: string; id?: number; url?: string; method?: string; status?: number; error?: string }) =>
        cb({
          type: String(msg?.type),
          name: msg?.name ? String(msg.name) : undefined,
          id: typeof msg?.id === 'number' ? msg.id : undefined,
          url: str(msg?.url),
          method: str(msg?.method),
          status: typeof msg?.status === 'number' ? msg.status : undefined,
          error: str(msg?.error),
        });
      ipcRenderer.on('sable:browser-event', listener);
      return () => {
        ipcRenderer.removeListener('sable:browser-event', listener);
      };
    },
  },
});
