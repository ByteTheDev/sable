import { isMac } from '@/lib/format';
import { openPreview } from '@/lib/links';
import { Tip, cx } from '@/ui';
import { rememberDevUrl } from './dev-urls';
import './dev-url.css';

/**
 * A dev server's address and "Open", as one quiet control: in a terminal run's header and on an
 * agent's command step. It opens the page in the Browser tab (the path `browser_open` and Preview
 * take); with Ctrl/Cmd, the system browser. Nothing opens by itself.
 */
export function DevUrlChip({ url, label, cwd, from, className }: { url: string; label: string; cwd?: string; from?: string; className?: string }) {
  return (
    <Tip label={`Open in the Browser tab. ${isMac ? 'Cmd' : 'Ctrl'}+click opens your browser`} side="top">
      <button
        type="button"
        className={cx('dev-chip', className)}
        aria-label={`Open ${label} in the Browser tab`}
        onClick={(e) => {
          e.stopPropagation();
          if (cwd) rememberDevUrl(cwd, url, from);
          openPreview(url, e.ctrlKey || e.metaKey);
        }}
      >
        <span className="dev-chip-host num">{label}</span>
        <span className="dev-chip-open">Open</span>
      </button>
    </Tip>
  );
}
