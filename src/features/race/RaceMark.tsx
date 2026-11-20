import { useStore } from '@/state/store';
import { Icon } from '@/icons';
import { baseName } from '@/lib/format';
import { Tip } from '@/ui';
import { openRace } from './race';
import './mark.css';

/**
 * The race glyph: one start (the folder) and two lanes that leave it side by side, each with its
 * node at the end. Plain line art on the icons' 16 px grid.
 */
export function RaceGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg className="race-glyph" viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="13" r="1.5" />
      <path className="race-glyph-l" d="M7.1 11.8 4.75 8.6V5.6" />
      <path className="race-glyph-r" d="M8.9 11.8 11.25 8.6V5.6" />
      <circle cx="4.75" cy="3.9" r="1.5" />
      <circle cx="11.25" cy="3.9" r="1.5" />
    </svg>
  );
}

/**
 * In the header of a chat that races another: "Race", opening the race view with both chats side
 * by side. Only while the race is open; once it is decided the chat is an ordinary chat again.
 */
export function RaceMark({ sessionId }: { sessionId: string }) {
  const raceId = useStore((s) => {
    const r = s.sessions[sessionId]?.race;
    return r && !r.outcome ? r.id : null;
  });
  if (!raceId) return null;
  return (
    <Tip label="Show both side by side">
      <button type="button" className="race-mark" aria-label="Race. Show both side by side" onClick={() => openRace(raceId)}>
        <RaceGlyph />
        <span>Race</span>
      </button>
    </Tip>
  );
}

/** The top bar's title while the race view shows: the glyph, the task, and the folder both lanes came from. */
export function RaceTitle({ raceId }: { raceId: string }) {
  const info = useStore((s) => {
    for (const m of Object.values(s.sessions)) if (m.race?.id === raceId) return `${m.race.folder}\u0000${m.race.task}`;
    return '';
  });
  if (!info) return <div className="grow" />;
  const [folder, task] = info.split('\u0000');
  return (
    <div className="topbar-title race-title">
      <span className="race-title-glyph">
        <RaceGlyph size={15} />
      </span>
      <span className="truncate race-title-task">{task}</span>
      <span className="topbar-crumb">
        <span className="topbar-crumb-item">
          <Icon name="folder" size={13} />
          <span className="truncate">{baseName(folder)}</span>
        </span>
      </span>
    </div>
  );
}
