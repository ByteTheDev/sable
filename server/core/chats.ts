import { existsSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Chats without a folder: each one gets a fresh folder of its own under one chats folder, so the
 * agent starts with an empty working directory and nothing from another chat.
 */

/** Where chats go unless the person chose a place: "Sable chats" on D: when there is one, else in the home folder. */
export function defaultChatsRoot(userHome: string, platform: string = process.platform, exists: (p: string) => boolean = existsSync): string {
  if (platform === 'win32' && exists('D:\\')) return 'D:\\Sable chats';
  return path.join(userHome, 'Sable chats');
}

/**
 * A chat's folder name: the date and the first words of its first message ("2026-11-19 refactor the
 * session module"), with only letters, digits, spaces, hyphens and underscores, so it is valid on
 * every filesystem (and never a reserved Windows name, as it starts with the date).
 */
export function chatFolderName(text: string | undefined, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const words = (text ?? '')
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .replace(/(^|\s)[-_]+|[-_]+(?=\s|$)/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  let name = '';
  for (const w of words) {
    const next = name ? `${name} ${w}` : w;
    if (next.length > 48) break;
    name = next;
  }
  if (!name && words[0]) name = words[0].slice(0, 48);
  return `${date} ${name || 'chat'}`;
}

/** Makes a new folder for a chat under `root` (and `root` itself when missing); a taken name gets " 2", " 3"... */
export function makeChatFolder(root: string, text: string | undefined, now = new Date()): string {
  mkdirSync(root, { recursive: true });
  const base = chatFolderName(text, now);
  for (let n = 1; n < 1000; n++) {
    const dir = path.join(root, n === 1 ? base : `${base} ${n}`);
    if (existsSync(dir)) continue;
    mkdirSync(dir);
    return dir;
  }
  throw new Error('Could not make a folder for this chat.');
}

/** Removes a chat's folder when the chat is deleted, only when it is directly under `root` and empty. */
export function removeEmptyChatFolder(root: string, dir: string): boolean {
  const parent = path.resolve(path.dirname(path.resolve(dir))).toLowerCase();
  if (parent !== path.resolve(root).toLowerCase()) return false;
  try {
    if (readdirSync(dir).length) return false;
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}
