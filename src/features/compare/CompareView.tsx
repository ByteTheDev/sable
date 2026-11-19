import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { animate, motion, useMotionValue, useMotionValueEvent, useTransform } from 'motion/react';
import type { CaptureView, TurnCapture } from '@shared/protocol';
import { reducedMotion } from '@/lib/motion';
import { addressParts } from '@/lib/links';
import { IconButton, Modal, Segmented } from '@/ui';
import { picture } from './captures';
import './compare.css';

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The sweep when the pictures are in: from all before to the middle, one glide. */
const SWEEP = { type: 'spring', stiffness: 380, damping: 40, mass: 1.8 } as const;
const FOLLOW = { type: 'spring', stiffness: 520, damping: 40 } as const;
const ZOOM = { type: 'spring', stiffness: 380, damping: 40 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Rect = { x: number; y: number; w: number; h: number };

/**
 * Where the two pictures meet: a 12 px band of the 4x4 ordered dither (the veil's pattern), so
 * the before thins out into the after cell by cell instead of ending on a cut. A still mask on a
 * still picture, drawn once.
 */
const SEAM = (() => {
  const bayer = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  let cells = '';
  for (let x = 0; x < 12; x++) {
    const keep = 1 - (x + 0.5) / 12;
    for (let y = 0; y < 4; y++) if ((bayer[y][x % 4] + 0.5) / 16 < keep) cells += `M${x} ${y}h1v1h-1z`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="4" shape-rendering="crispEdges"><path d="${cells}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
})();

function changesLabel(view: CaptureView): string | null {
  if (!view.before || !view.regions) return null;
  const n = view.regions.length;
  return n === 0 ? 'No visible change' : n === 1 ? '1 area changed' : `${n} areas changed`;
}

/** A picture fetched and decoded, so it paints in the same frame as its pair. */
async function decoded(sessionId: string, id: string | undefined): Promise<string | undefined> {
  if (!id) return undefined;
  const url = await picture(sessionId, id);
  if (!url) return undefined;
  const img = new Image();
  img.src = url;
  await img.decode().catch(() => {});
  return url;
}

/** Both pictures of a view, as data URLs once loaded and decoded. */
function usePictures(sessionId: string, view: CaptureView) {
  const [urls, setUrls] = useState<{ before?: string; after?: string }>({});
  useEffect(() => {
    let live = true;
    setUrls({});
    void Promise.all([decoded(sessionId, view.before?.id), decoded(sessionId, view.after?.id)]).then(([before, after]) => {
      if (live) setUrls({ before, after });
    });
    return () => {
      live = false;
    };
  }, [sessionId, view.before, view.after]);
  return urls;
}

/**
 * One view's pictures on a stage: the after underneath, the before over it on the left of a
 * divider that is dragged (or moved with the arrow keys; Space flips to one side and back). The
 * reveal is two opposite translations, so it runs on the compositor; the changed areas draw
 * their outlines once the sweep has landed.
 */
function Stage({ sessionId, view }: { sessionId: string; view: CaptureView }) {
  const urls = usePictures(sessionId, view);
  const both = !!view.before;
  const ready = !!urls.after && (!both || !!urls.before);
  const stage = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  // Divider position, 0 (all after) to 1 (all before).
  const pos = useMotionValue(1);
  const clipX = useTransform(pos, (p) => `${(p - 1) * 100}%`);
  const innerX = useTransform(pos, (p) => `${(1 - p) * 100}%`);
  const [landed, setLanded] = useState(false);
  // Zoom into a changed area: scale and offset of the content, the divider's line and disc kept at
  // their own size, the disc kept in the visible middle.
  const zs = useMotionValue(1);
  const zx = useMotionValue(0);
  const zy = useMotionValue(0);
  const hy = useMotionValue(0);
  const unscale = useTransform(zs, (z) => 1 / z);
  const [zoomed, setZoomed] = useState<number | null>(null);
  // The slider's value for assistive tech, written without a render per frame.
  useMotionValueEvent(pos, 'change', (p) => {
    const v = String(Math.round(p * 100));
    const el = handle.current;
    if (el && el.getAttribute('aria-valuenow') !== v) {
      el.setAttribute('aria-valuenow', v);
      el.setAttribute('aria-valuetext', `${v}% before`);
    }
  });

  useEffect(() => {
    if (!ready || !both) return;
    // The keys (arrows, Space) work at once.
    handle.current?.focus({ preventScroll: true });
    if (reducedMotion()) {
      pos.set(0.5);
      setLanded(true);
      return;
    }
    const a = animate(pos, 0.5, { ...SWEEP, onComplete: () => setLanded(true) });
    // The outlines need not wait for the last pixel of the spring.
    const t = window.setTimeout(() => setLanded(true), 420);
    return () => {
      a.stop();
      window.clearTimeout(t);
    };
  }, [ready, both, pos]);

  // Where the divider is going: keys step from there, not from wherever a glide has got to.
  const target = useRef(0.5);
  const moveTo = (to: number, smooth: boolean) => {
    const v = Math.min(1, Math.max(0, to));
    target.current = v;
    if (smooth && !reducedMotion()) animate(pos, v, FOLLOW);
    else {
      pos.stop();
      pos.set(v);
    }
  };

  /** Zooms so `rect` (view pixels) fills most of the stage; null zooms out. `which` names it for the keys. */
  const zoomTo = (rect: Rect | null, which: number | null) => {
    const el = stage.current;
    if (!el) return;
    const W = el.clientWidth;
    const H = el.clientHeight;
    let z = 1;
    let tx = 0;
    let ty = 0;
    if (rect) {
      z = clamp(0.7 / Math.max(rect.w / view.width, rect.h / view.height), 1.6, 3);
      const cx = ((rect.x + rect.w / 2) / view.width) * W;
      const cy = ((rect.y + rect.h / 2) / view.height) * H;
      tx = clamp(W / 2 - cx * z, W - W * z, 0);
      ty = clamp(H / 2 - cy * z, H - H * z, 0);
    }
    setZoomed(rect ? which : null);
    // The divider through the middle of the change, so both versions of it are in view.
    if (rect && both) {
      const lo = -tx / (W * z);
      const hi = (W - tx) / (W * z);
      moveTo(clamp((rect.x + rect.w / 2) / view.width, lo + 0.04, hi - 0.04), true);
    }
    const opts = reducedMotion() ? { duration: 0 } : ZOOM;
    animate(zs, z, opts);
    animate(zx, tx, opts);
    animate(zy, ty, opts);
    animate(hy, (H / 2 - ty) / z - H / 2, opts);
  };

  const zoomToRegion = (i: number) => {
    const r = view.regions?.[i];
    if (!r) return;
    zoomTo(zoomed === i ? null : r, i);
  };

  /** Double-click: out when zoomed, else into the changed area under the pointer, or around the point. */
  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!ready) return;
    if (zoomed !== null) return zoomTo(null, null);
    const r = content.current?.getBoundingClientRect();
    if (!r?.width) return;
    const px = ((e.clientX - r.left) / r.width) * view.width;
    const py = ((e.clientY - r.top) / r.height) * view.height;
    const i = view.regions?.findIndex((g) => px >= g.x && px <= g.x + g.w && py >= g.y && py <= g.y + g.h) ?? -1;
    if (i >= 0) return zoomTo(view.regions![i], i);
    const w = view.width / 3;
    const h = view.height / 3;
    zoomTo({ x: px - w / 2, y: py - h / 2, w, h }, -1);
  };

  const fromPointer = (e: PointerEvent, smooth: boolean) => {
    const r = content.current?.getBoundingClientRect();
    if (!r || !r.width) return;
    moveTo((e.clientX - r.left) / r.width, smooth);
  };

  // A press glides the divider there; a drag then follows the pointer exactly.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!both || !ready || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    fromPointer(e, true);
    handle.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const p = target.current;
    const step = e.shiftKey ? 0.2 : 0.05;
    if (e.key === 'ArrowLeft') moveTo(p - step, true);
    else if (e.key === 'ArrowRight') moveTo(p + step, true);
    else if (e.key === 'Home') moveTo(0, true);
    else if (e.key === 'End') moveTo(1, true);
    // Space: all of the other side, and back to the middle the next time.
    else if (e.key === ' ') moveTo(p > 0.02 && p < 0.98 ? (p >= 0.5 ? 0 : 1) : p >= 0.98 ? 0 : 1, true);
    // 1 to 9: into that changed area (again: out); 0 and Escape: out.
    else if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) zoomToRegion(Number(e.key) - 1);
    else if ((e.key === '0' || e.key === 'Escape') && zoomed !== null) zoomTo(null, null);
    else return;
    e.preventDefault();
  };

  return (
    // Zoomed, Escape zooms out first (the dialog leaves that key to this scope).
    <div className="cmp-stage-wrap" data-escape-scope={zoomed !== null || undefined}>
      <div
        ref={stage}
        className="cmp-stage"
        data-ready={ready || undefined}
        data-both={both || undefined}
        data-zoomed={zoomed !== null || undefined}
        data-kind={view.kind}
        style={{ aspectRatio: `${view.width} / ${view.height}` }}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => e.buttons === 1 && e.currentTarget.hasPointerCapture(e.pointerId) && fromPointer(e, false)}
        onDoubleClick={onDoubleClick}
      >
        {!ready && <div className="cmp-skel skel" />}
        <motion.div ref={content} className="cmp-zoom" style={{ x: zx, y: zy, scale: zs }}>
          {ready && (
            <div className="cmp-pics">
              <img className="cmp-img" src={urls.after} alt="After the turn" draggable={false} />
              {both && (
                <motion.div className="cmp-clip" style={{ x: clipX, ['--seam' as string]: SEAM }} aria-hidden>
                  <motion.img className="cmp-img" src={urls.before} alt="" draggable={false} style={{ x: innerX }} />
                </motion.div>
              )}
            </div>
          )}
          {ready && view.regions && view.regions.length > 0 && (
            <div className="cmp-regions" data-landed={landed || undefined} aria-hidden>
              {view.regions.map((r, i) => (
                <div
                  key={i}
                  className="cmp-region"
                  style={{
                    left: `${(r.x / view.width) * 100}%`,
                    top: `${(r.y / view.height) * 100}%`,
                    width: `${(r.w / view.width) * 100}%`,
                    height: `${(r.h / view.height) * 100}%`,
                    ['--i' as string]: i,
                  }}
                >
                  <i className="cmp-edge" data-edge="t" />
                  <i className="cmp-edge" data-edge="r" />
                  <i className="cmp-edge" data-edge="b" />
                  <i className="cmp-edge" data-edge="l" />
                </div>
              ))}
            </div>
          )}
          {both && ready && (
            // The line sits on the divider's right edge: the divider moves with the before's clip.
            <motion.div className="cmp-divider" style={{ x: clipX }}>
              <motion.span className="cmp-line" style={{ scaleX: unscale }} />
              <motion.div
                ref={handle}
                style={{ scale: unscale, y: hy }}
                className="cmp-handle"
                role="slider"
                tabIndex={0}
                aria-label="Divider between before and after"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={100}
                aria-valuetext="100% before"
                onKeyDown={onKeyDown}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                  <path d="M5 3.5 1.5 7 5 10.5M9 3.5 12.5 7 9 10.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </motion.div>
            </motion.div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

/** The before / after of one turn, in a dialog. */
export function CompareView({ sessionId, capture, open, onOpenChange }: { sessionId: string; capture: TurnCapture; open: boolean; onOpenChange: (open: boolean) => void }) {
  const views = capture.views.filter((v) => v.after);
  const [kind, setKind] = useState<CaptureView['kind']>('desktop');
  const view = views.find((v) => v.kind === kind) ?? views[0];
  const addr = addressParts(capture.url);
  if (!view) return null;
  const changes = changesLabel(view);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Before / after" bare className="cmp-dialog">
      <div className="cmp-head">
        <h2 className="cmp-title">Before / after</h2>
        <span className="cmp-url truncate">
          {addr.host}
          {addr.path && <span className="cmp-path">{addr.path}</span>}
        </span>
        <span className="cmp-head-end">
          {views.length > 1 && (
            <Segmented
              id="cmp-kind"
              value={view.kind}
              onChange={setKind}
              options={views.map((v) => ({ value: v.kind, label: v.kind === 'desktop' ? 'Desktop' : 'Phone', icon: v.kind === 'desktop' ? 'monitor' : 'phone' }))}
            />
          )}
          <IconButton icon="x" label="Close" size={15} onClick={() => onOpenChange(false)} />
        </span>
      </div>
      <Stage key={view.kind} sessionId={sessionId} view={view} />
      <div className="cmp-foot">
        <span className="cmp-side">
          {view.before ? (
            <>
              <span className="cmp-side-name">Before</span>
              <span className="num">{time(view.before.at)}</span>
            </>
          ) : (
            <span className="cmp-none">{capture.noBefore ?? 'There is no before at this size'}</span>
          )}
        </span>
        <span className="cmp-mid num">
          {view.width} × {view.height}
          {changes && <span className="cmp-changes">{changes}</span>}
        </span>
        <span className="cmp-side cmp-side-end">
          <span className="cmp-side-name">After</span>
          <span className="num">{time(view.after!.at)}</span>
        </span>
      </div>
    </Modal>
  );
}
