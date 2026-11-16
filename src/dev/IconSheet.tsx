import { useEffect, useRef, useState } from 'react';
import { ANIMATED_NAMES, Icon, IconOriginal, type IconName } from '@/icons';

/**
 * Every animated icon at 16, 20 and 24 px: the Phosphor original, the drawing at rest, and its
 * motion scrubbed across six frames (paused Web Animations), with the pixel difference at rest
 * between drawing and original. Hover a row's rest icon to play it live.
 */
const SIZES = [16, 20, 24] as const;
const FRAMES = [50, 110, 170, 230, 300, 380];

/** `?gallery&icons=a,b,c` shows only those icons; `?gallery&icons=26-` a slice by position (for shots). */
function pick(): IconName[] {
  const q = new URLSearchParams(location.search).get('icons');
  if (!q) return ANIMATED_NAMES;
  const range = /^(\d*)-(\d*)$/.exec(q);
  if (range) return ANIMATED_NAMES.slice(Number(range[1] || 0), range[2] ? Number(range[2]) : undefined);
  const want = q.split(',');
  return ANIMATED_NAMES.filter((n) => want.includes(n));
}

export function IconSheet() {
  const root = useRef<HTMLDivElement>(null);
  const [names] = useState(pick);
  const [diffs, setDiffs] = useState<Record<string, string>>({});

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // Scrub: each frame cell holds its own copy of the motion, paused at its time.
    for (const cell of el.querySelectorAll<HTMLElement>('[data-ai-play]')) {
      const t = Number(cell.dataset.t);
      for (const a of cell.getAnimations({ subtree: true })) {
        a.pause();
        a.currentTime = t;
      }
    }
    let live = true;
    void (async () => {
      const out: Record<string, string> = {};
      for (const name of names) {
        const parts: string[] = [];
        for (const s of SIZES) {
          const a = el.querySelector<SVGSVGElement>(`[data-cmp="${name}-${s}"] [data-icon-original]`);
          const b = el.querySelector<SVGSVGElement>(`[data-cmp="${name}-${s}"] [data-anim]`);
          if (!a || !b) continue;
          const [x, y] = await Promise.all([raster(a, s), raster(b, s)]);
          parts.push(compare(x, y));
        }
        out[name] = parts.join('  ');
      }
      if (live) setDiffs(out);
    })();
    return () => {
      live = false;
    };
  }, [names]);

  return (
    <div className="isheet" ref={root}>
      <div className="isheet-row isheet-head">
        <span>Icon</span>
        {SIZES.map((s) => (
          <span key={s} className="isheet-size">
            {s} px: original, rest, difference, frames {FRAMES.join(' ')} ms
          </span>
        ))}
      </div>
      {names.map((name) => (
        <div key={name} className="isheet-row" data-name={name}>
          <span className="isheet-name">
            {name}
            <span className="isheet-diff num">{diffs[name] ?? '…'}</span>
          </span>
          {SIZES.map((s) => (
            <span key={s} className="isheet-size">
              <span className="isheet-cell isheet-orig">
                <IconOriginal name={name} size={s} />
              </span>
              <button type="button" className="isheet-cell" aria-label={`Play ${name}`}>
                <Icon name={name} size={s} />
              </button>
              {/* Both stacked, the drawing in difference blend: what differs from the original lights up. */}
              <span className="isheet-cell isheet-cmp" data-cmp={`${name}-${s}`}>
                <IconOriginal name={name} size={s} />
                <span className="isheet-over">
                  <Icon name={name} size={s} />
                </span>
              </span>
              {FRAMES.map((t) => (
                <span key={t} className="isheet-cell" data-ai-play="" data-t={t}>
                  <Icon name={name as IconName} size={s} />
                </span>
              ))}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Draws an icon's markup into a canvas at its size (1x) and returns its alpha channel. */
async function raster(svg: SVGSVGElement, size: number): Promise<Uint8ClampedArray> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', String(size));
  copy.setAttribute('height', String(size));
  copy.setAttribute('style', 'color:#000');
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0, size, size);
  const data = g.getImageData(0, 0, size, size).data;
  const alpha = new Uint8ClampedArray(size * size);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  return alpha;
}

/** Mean alpha difference in percent and the largest single-pixel difference. */
function compare(a: Uint8ClampedArray, b: Uint8ClampedArray): string {
  let sum = 0;
  let max = 0;
  let ink = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    ink += a[i];
    if (d > max) max = d;
  }
  return `${((sum / Math.max(1, ink)) * 100).toFixed(1)}%/${Math.round((max / 255) * 100)}`;
}
