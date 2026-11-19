import { StatusGlyph } from '@/art/Logo';
import { setTriage } from '@/state/actions';
import { selectWaitingCount } from '@/state/pending';
import { useStore } from '@/state/store';
import { Tip } from '@/ui';
import './waiting.css';

/**
 * The top bar's quiet count of prompts waiting on the user across chats (shown while one waits
 * outside the open chat). Opens the triage deck.
 */
export function WaitingCount() {
  const n = useStore(selectWaitingCount);
  if (!n) return null;
  const label = n === 1 ? '1 request waiting on you' : `${n} requests waiting on you`;
  return (
    <Tip label="Answer what waits" keys="mod+i">
      <button type="button" className="tri-waiting" onClick={() => setTriage(true)} aria-label={label}>
        <StatusGlyph tone="awaiting" size={10} />
        <span>
          <span className="num">{n}</span> waiting
        </span>
      </button>
    </Tip>
  );
}
