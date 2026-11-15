import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { BackdropColour, BackdropConfig, BackdropPattern, BackdropSource, BackdropStyle } from '@shared/protocol';
import { BACKDROP_PRESETS, DEFAULT_BACKDROP, DIRECTIONAL, sameBackdrop } from '@shared/backdrop';
import { Backdrop } from '@/art/Backdrop';
import { Icon } from '@/icons';
import { addBackdropImage, backdropImageBlob, removeBackdropImage, selectBackdrop, setBackdrop } from '@/state/actions';
import { useStore } from '@/state/store';
import { Segmented, Slider, Switch, Tip } from '@/ui';
import { Card, Row } from './parts';
import './background.css';

/**
 * Settings → Appearance → Background: a live miniature of the app over the real field, presets,
 * and every part of the backdrop config. Changes show at once and are saved after a short pause.
 * The fields here exist only while this page is open.
 */
export function Background() {
  const cfg = useStore(selectBackdrop);
  const images = useStore((s) => s.settings.backdropImages);
  const [view, setView] = useState<'home' | 'session'>('home');
  const off = cfg.source === 'off';
  const softImage = cfg.source === 'image' && cfg.style === 'soft';

  return (
    <>
      <Card
        title="Background"
        aside={
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBackdrop({ ...DEFAULT_BACKDROP, image: cfg.image })} disabled={sameBackdrop({ ...cfg, image: null }, DEFAULT_BACKDROP)}>
            Reset
          </button>
        }
      >
        <Preview cfg={cfg} view={view} onView={setView} />
        <Presets cfg={cfg} />
        <Row label="Source">
          <Segmented<BackdropSource>
            id="bg-source"
            value={cfg.source}
            onChange={(source) => setBackdrop({ source, image: source === 'image' && !cfg.image ? (images[images.length - 1]?.id ?? null) : cfg.image })}
            options={[
              { value: 'pattern', label: 'Pattern' },
              { value: 'image', label: 'Image' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </Row>
        {cfg.source === 'pattern' && (
          <Row label="Pattern">
            <Segmented<BackdropPattern>
              id="bg-pattern"
              value={cfg.pattern}
              onChange={(pattern) => setBackdrop({ pattern })}
              options={[
                { value: 'streaks', label: 'Streaks' },
                { value: 'tubes', label: 'Tubes' },
                { value: 'tiles', label: 'Tiles' },
                { value: 'aurora', label: 'Aurora' },
              ]}
            />
          </Row>
        )}
        {cfg.source === 'image' && <Images cfg={cfg} />}
        {!off && (
          <Row label="Style">
            <Segmented<BackdropStyle>
              id="bg-style"
              value={cfg.style}
              onChange={(style) => setBackdrop({ style })}
              options={[
                { value: 'dither', label: 'Dither' },
                { value: 'ascii', label: 'ASCII' },
                { value: 'halftone', label: 'Halftone' },
                { value: 'soft', label: 'Soft' },
              ]}
            />
          </Row>
        )}
      </Card>

      {!off && (
        <Card>
          <SliderRow label="Amount" value={cfg.amount} onChange={(amount) => setBackdrop({ amount })} />
          <SliderRow label="Sessions" value={cfg.sessionAmount} onChange={(sessionAmount) => setBackdrop({ sessionAmount })} />
          <SliderRow label="Reach" value={cfg.reach} onChange={(reach) => setBackdrop({ reach })} />
          {!softImage && <SliderRow label="Detail" value={cfg.detail} onChange={(detail) => setBackdrop({ detail })} />}
          <SliderRow label="Speed" value={cfg.speed} onChange={(speed) => setBackdrop({ speed })} />
          {cfg.source === 'pattern' && DIRECTIONAL.includes(cfg.pattern) && (
            <SliderRow label="Angle" value={cfg.angle} max={180} unit="°" onChange={(angle) => setBackdrop({ angle })} />
          )}
        </Card>
      )}

      {!off && (
        <Card>
          <Row label="Colour">
            <Segmented<BackdropColour>
              id="bg-colour"
              value={cfg.colour}
              onChange={(colour) => setBackdrop({ colour })}
              options={[
                { value: 'agent', label: 'Agent' },
                { value: 'mono', label: 'Mono' },
                { value: 'custom', label: 'Custom' },
                ...(cfg.source === 'image' ? [{ value: 'image' as const, label: 'Image' }] : []),
              ]}
            />
          </Row>
          {cfg.colour === 'custom' && (
            <>
              <SliderRow label="Hue" value={cfg.hue} max={360} unit="°" onChange={(hue) => setBackdrop({ hue })} />
              <SliderRow label="Saturation" value={cfg.saturation} onChange={(saturation) => setBackdrop({ saturation })} />
            </>
          )}
          <Row label="React to pointer and send">
            <Switch checked={cfg.react} onChange={(react) => setBackdrop({ react })} label="React to pointer and send" />
          </Row>
        </Card>
      )}
    </>
  );
}

// ── preview ──

const NUDGE = 0.02;

/**
 * The app in miniature over the real field. On Home the focus point is a handle: drag it (or
 * press on the stage), arrow keys move it, Enter or a double-click recentres it. A dropped image
 * becomes the background.
 */
function Preview({ cfg, view, onView }: { cfg: BackdropConfig; view: 'home' | 'session'; onView: (v: 'home' | 'session') => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dropping, setDropping] = useState(false);
  const showFocus = view === 'home' && cfg.source !== 'off' && cfg.reach < 100;

  const moveTo = (e: { clientX: number; clientY: number }) => {
    const r = stage.current?.getBoundingClientRect();
    if (!r?.width || !r.height) return;
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    setBackdrop({ focus: { x, y } });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!showFocus || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    handle.current?.focus({ preventScroll: true });
    moveTo(e);
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? NUDGE * 5 : NUDGE;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) {
      e.preventDefault();
      setBackdrop({ focus: { x: cfg.focus.x + d[0], y: cfg.focus.y + d[1] } });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      setBackdrop({ focus: { x: 0.5, y: 0.5 } });
    }
  };

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDropping(false);
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) void addBackdropImage(file);
  };

  return (
    <div
      className="bg-preview"
      data-view={view}
      data-dropping={dropping || undefined}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={onDrop}
    >
      <div className="bg-mini-side" aria-hidden>
        <i style={{ width: '62%' }} />
        <i style={{ width: '48%' }} />
        <i style={{ width: '54%' }} />
        <i className="gap" style={{ width: '38%' }} />
        <i style={{ width: '58%' }} />
      </div>
      <div
        ref={stage}
        className="bg-mini-stage"
        data-focusable={showFocus || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => dragging && moveTo(e)}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onDoubleClick={() => showFocus && setBackdrop({ focus: { x: 0.5, y: 0.5 } })}
      >
        {view === 'home' ? (
          <>
            <Backdrop surface="preview" view="home" config={cfg} />
            <div className="bg-mini-veil" />
            <div className="bg-mini-home" aria-hidden>
              <i className="bg-mini-title" />
              <i className="bg-mini-composer" />
            </div>
          </>
        ) : (
          <>
            <div className="bg-mini-band">
              <Backdrop surface="preview" view="session" config={cfg} />
            </div>
            <div className="bg-mini-session" aria-hidden>
              <i style={{ width: '46%' }} className="bg-mini-user" />
              <i style={{ width: '78%' }} />
              <i style={{ width: '70%' }} />
              <i style={{ width: '52%' }} />
              <i className="bg-mini-composer" />
            </div>
          </>
        )}
        {showFocus && (
          <button
            ref={handle}
            type="button"
            className="bg-focus"
            data-dragging={dragging || undefined}
            // Kept whole inside the stage at its edges.
            style={{ left: `clamp(10px, ${cfg.focus.x * 100}%, calc(100% - 10px))`, top: `clamp(10px, ${cfg.focus.y * 100}%, calc(100% - 10px))` }}
            aria-label="Focus point"
            aria-description={`${Math.round(cfg.focus.x * 100)}% across, ${Math.round(cfg.focus.y * 100)}% down`}
            onKeyDown={onKey}
            onPointerDown={(e) => e.preventDefault()}
          />
        )}
        {dropping && <div className="bg-drop">Drop to use as background</div>}
      </div>
      <div className="bg-view">
        <Segmented
          id="bg-view"
          value={view}
          onChange={onView}
          options={[
            { value: 'home', label: 'Home' },
            { value: 'session', label: 'Session' },
          ]}
        />
      </div>
    </div>
  );
}

// ── presets ──

function Presets({ cfg }: { cfg: BackdropConfig }) {
  return (
    <div className="bg-presets" role="radiogroup" aria-label="Presets">
      {BACKDROP_PRESETS.map((p) => {
        const on = sameBackdrop({ ...cfg, image: null }, p.config);
        return (
          <button key={p.id} type="button" role="radio" aria-checked={on} className="bg-preset" onClick={() => setBackdrop({ ...p.config, image: cfg.image })}>
            <span className="bg-swatch">
              <Backdrop surface="swatch" config={p.config} />
            </span>
            <span className="bg-preset-name">{p.name}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── images ──

function Images({ cfg }: { cfg: BackdropConfig }) {
  const images = useStore((s) => s.settings.backdropImages);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    await addBackdropImage(file);
    setBusy(false);
  };

  return (
    <div className="set-row bg-images-row" data-align="start">
      <div className="set-row-text">
        <div className="set-row-label">Image</div>
      </div>
      <div className="bg-images">
        {[...images].reverse().map((img) => (
          <div key={img.id} className="bg-thumb" data-on={img.id === cfg.image || undefined}>
            <button type="button" className="bg-thumb-pick" aria-label="Use this image" aria-pressed={img.id === cfg.image} onClick={() => setBackdrop({ source: 'image', image: img.id })}>
              <Thumb id={img.id} />
            </button>
            <Tip label="Remove">
              <button type="button" className="bg-thumb-remove" aria-label="Remove image" onClick={() => void removeBackdropImage(img.id)}>
                <Icon name="x" size={11} />
              </button>
            </Tip>
          </div>
        ))}
        {images.length > 0 ? (
          <Tip label="Choose image">
            <button type="button" className="bg-add" aria-label="Choose image" onClick={() => input.current?.click()} disabled={busy}>
              <Icon name="plus" size={15} />
            </button>
          </Tip>
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? 'Adding' : 'Choose image'}
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void choose(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}

function Thumb({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    backdropImageBlob(id).then(
      (blob) => {
        if (!live) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      },
      () => {},
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id]);
  return url ? <img src={url} alt="" draggable={false} /> : <span className="skel" />;
}

// ── a slider row ──

function SliderRow({ label, value, onChange, max = 100, unit = '' }: { label: string; value: number; onChange: (v: number) => void; max?: number; unit?: string }) {
  return (
    <div className="set-row bg-slider-row">
      <div className="set-row-text">
        <div className="set-row-label">{label}</div>
      </div>
      <div className="set-row-control">
        <Slider className="bg-slider" value={value} max={max} onChange={onChange} label={label} />
        <span className="bg-value num">
          {value}
          {unit}
        </span>
      </div>
    </div>
  );
}
