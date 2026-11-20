import type { SessionMeta, SessionRace } from '@shared/protocol';

/**
 * Race (the desktop's `/race`): two chats given one task, each in a lane of its own. Both carry
 * `SessionMeta.race`; once one is kept the other is dropped and both are ordinary chats again, so
 * the phone marks a chat only while its race is open. No race view on the phone: a chat's mark goes
 * to its rival.
 */
export const openRace = (s: SessionMeta | undefined): SessionRace | null => (s?.race && !s.race.outcome ? s.race : null);

/** The folder a chat belongs to: a chat in a lane (a race's, or one made beside another chat) belongs to the folder it came from. */
export const homeFolder = (s: SessionMeta): string => s.lane?.folder ?? s.cwd;

/**
 * A chat replaced on screen by its rival: the rival comes in from the side its column is on (the
 * desktop's race view: side 0 left, side 1 right) while the chat leaves toward its own. Module
 * state, as `openFrom`: the tap records, each screen's layer takes its half once.
 */
let swap: { from: string; to: string; dir: 1 | -1; at: number; in: boolean; out: boolean } | null = null;

export function swapTo(from: string, to: string, rivalSide: 0 | 1) {
  swap = { from, to, dir: rivalSide === 1 ? 1 : -1, at: performance.now(), in: false, out: false };
}

/** For the screen coming in (`to`) or going (`from`): which way, 1 toward the right, -1 toward the left; null when it was not a swap. */
export function takeSwap(id: string, role: 'in' | 'out'): 1 | -1 | null {
  const s = swap;
  if (!s || performance.now() - s.at > 1500) return null;
  if (role === 'in' && s.to === id && !s.in) {
    s.in = true;
    return s.dir;
  }
  if (role === 'out' && s.from === id && !s.out) {
    s.out = true;
    return s.dir;
  }
  return null;
}
