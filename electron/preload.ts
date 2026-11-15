import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * Sandboxed preload: the page gets a few facts about the shell, the native folder dialog, the title
 * strip's height (so the native window buttons line up with the top bar), the real path of a dropped or
 * picked file (Electron's webUtils.getPathForFile), and three narrow calls for
 * the panel browser (capture its page, clear its data, hear about blocked downloads), nothing else.
 * The app version arrives as an extra argument from the main process.
 */
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

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
  /** The height of the app's title strip in CSS pixels; the native buttons are sized to match. */
  setTitleBarHeight: (height: number) => ipcRenderer.send('sable:titlebar', Number(height)),
  browser: {
    capture: (webContentsId: number): Promise<string> => ipcRenderer.invoke('sable:browser-capture', Number(webContentsId)),
    clearData: (): Promise<void> => ipcRenderer.invoke('sable:browser-clear'),
    onEvent: (cb: (e: { type: string; name?: string }) => void) => {
      if (typeof cb !== 'function') return () => {};
      const listener = (_e: unknown, msg: { type: string; name?: string }) => cb({ type: String(msg?.type), name: msg?.name ? String(msg.name) : undefined });
      ipcRenderer.on('sable:browser-event', listener);
      return () => {
        ipcRenderer.removeListener('sable:browser-event', listener);
      };
    },
  },
});
