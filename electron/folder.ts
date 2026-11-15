import { statSync } from 'node:fs';
import path from 'node:path';

/**
 * The native "Open a folder" dialog, kept free of Electron imports so it can be tested with the
 * dialog stubbed. main.ts passes Electron's dialog.showOpenDialog (bound to the window) as `show`.
 */

export interface FolderDialogOptions {
  title: string;
  buttonLabel: string;
  defaultPath?: string;
  properties: ('openDirectory' | 'createDirectory' | 'dontAddToRecent')[];
}

export type ShowFolderDialog = (options: FolderDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;

/** The folder the dialog starts in: the page's suggestion only when it is an existing absolute folder. */
export function startFolder(suggested: unknown): string | undefined {
  if (typeof suggested !== 'string' || !suggested || suggested.length > 4096 || suggested.includes('\0')) return undefined;
  if (!path.isAbsolute(suggested)) return undefined;
  try {
    return statSync(suggested).isDirectory() ? path.resolve(suggested) : undefined;
  } catch {
    return undefined;
  }
}

/** Shows the dialog and returns the chosen folder, or null when it was cancelled. */
export async function pickFolder(show: ShowFolderDialog, suggested: unknown): Promise<string | null> {
  const result = await show({
    title: 'Open a folder',
    buttonLabel: 'Open',
    defaultPath: startFolder(suggested),
    properties: ['openDirectory', 'createDirectory'],
  });
  const chosen = result.canceled ? undefined : result.filePaths[0];
  // Only an existing folder goes back to the page.
  return chosen && startFolder(chosen) ? path.resolve(chosen) : null;
}
