import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Popover as RP } from 'radix-ui';
import { STANDARD_SPEED, type Effort, type SpeedInfo } from '@shared/protocol';
import { effortName, isUltraEffort } from '@/lib/models';
import { EASE_OUT, play, reducedMotion, spring } from '@/lib/motion';
import { Segmented, Switch, Tip } from '@/ui';
import { Icon } from '@/icons';
import { type Choice } from './choice';
import { ChipSkeleton, MENU_EVENT } from './Controls';

/** The rail's drawn length; stops sit evenly along it, the first and last on its ends. */
const RAIL_W = 196;
/** The thumb lands on a stop with a small, quick settle: the detent. */
const DETENT = spring(560, 34);
/** How long the "ultra" moment plays when it turns on. */
const BURST_MS = 900;

/**
 * The "ultra" mark: two stacked heads, the second riding under the first. The same drawing the
 * send key gains, worn by ultracode (Claude Code) and by the Ultra level (Codex) alike.
 */
export function UltraMark({ className }: { className?: string }) {
  return (
    <svg className={className ? `ux-mark ${className}` : 'ux-mark'} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path className="ux-m1" d="M3.6 6.4 7 3l3.4 3.4" />
      <path className="ux-m2" d="M3.6 10.6 7 7.2l3.4 3.4" />
    </svg>
  );
}

/** The level as a row of rising ticks, lit up to the level. An Ultra level's tick is dithered. */
function Meter({ efforts, level }: { efforts: Effort[]; level: number }) {
  const n = efforts.length;
  // The wave runs from where the ticks were last drawn.
  const prev = useRef(level);
  const from = prev.current;
  useEffect(() => {
    prev.current = level;
  }, [level]);
  return (
    <span className="th-meter" aria-hidden>
      {efforts.map((e, i) => (
        <i
          key={e}
          data-on={i <= level || undefined}
          data-ultra={isUltraEffort(e) || undefined}
          style={{ height: Math.round(5 + (i * 7) / Math.max(1, n - 1)), transitionDelay: `${Math.max(0, Math.abs(i - from) - 1) * 22}ms` }}
        />
      ))}
    </span>
  );
}

/** A level's name, with the ultra mark in front of an Ultra level (or of any level while ultracode is on). */
function LevelName({ effort, mark }: { effort: Effort | undefined; mark?: boolean }) {
  return (
    <>
      {(mark || isUltraEffort(effort)) && <UltraMark />}
      {effort ? effortName(effort) : 'Default'}
    </>
  );
}

interface TrackProps {
  efforts: Effort[];
  level: number;
  onPick: (i: number) => void;
  onDone: () => void;
  trackRef: RefObject<HTMLDivElement | null>;
  burst: boolean;
}

/**
 * One horizontal stepped track: click a stop, drag across the stops, arrows / Home / End / number
 * keys. The thumb moves on a spring and settles on each stop; only the current name is bright.
 */
function Track({ efforts, level, onPick, onDone, trackRef, burst }: TrackProps) {
  const n = efforts.length;
  const [hover, setHover] = useState<number | null>(null);
  const [pressed, setPressed] = useState(false);
  const rail = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);

  const at = (clientX: number) => {
    const r = rail.current?.getBoundingClientRect();
    if (!r || n < 2) return 0;
    const f = (clientX - r.left) / r.width;
    return Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer */
    }
    e.currentTarget.focus({ preventScroll: true });
    dragging.current = true;
    setPressed(true);
    onPick(at(e.clientX));
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const i = at(e.clientX);
    if (dragging.current) {
      if (i !== level) onPick(i);
    } else setHover(i);
  };
  const end = () => {
    dragging.current = false;
    setPressed(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    let next: number | null = null;
    if (k === 'ArrowRight' || k === 'ArrowUp') next = level + 1;
    else if (k === 'ArrowLeft' || k === 'ArrowDown') next = level - 1;
    else if (k === 'Home') next = 0;
    else if (k === 'End') next = n - 1;
    else if (/^[1-9]$/.test(k)) next = Number(k) - 1;
    else if (k === 'Enter') {
      e.preventDefault();
      onDone();
      return;
    } else return;
    e.preventDefault();
    setHover(null);
    if (next >= 0 && next < n && next !== level) onPick(next);
  };

  const step = n > 1 ? RAIL_W / (n - 1) : 0;
  const x = Math.max(0, level) * step;
  const still = reducedMotion();
  const move: CSSProperties = still ? {} : { transitionDuration: `${DETENT.duration}ms`, transitionTimingFunction: DETENT.easing };
  const named = hover !== null && hover !== level ? hover : null;
  const shown = efforts[named ?? level];
  const ultraAt = efforts.findIndex(isUltraEffort);
  // The solid fill ends where an Ultra stretch begins; that last stretch is drawn in dither.
  const cap = ultraAt > 0 ? ultraAt - 1 : n - 1;
  const fill = cap > 0 ? Math.min(Math.max(0, level), cap) / cap : 0;

  return (
    <div className="th-body">
      <div className="th-head">
        <span className="th-title">Effort</span>
        <span className="th-name" data-preview={named !== null || undefined} data-ultra={isUltraEffort(shown) || undefined} key={`${named ?? level}`}>
          <LevelName effort={shown} />
        </span>
      </div>
      <div
        ref={trackRef}
        className="th-track"
        role="slider"
        tabIndex={0}
        aria-label="Effort"
        aria-valuemin={1}
        aria-valuemax={n}
        aria-valuenow={level + 1}
        aria-valuetext={effortName(efforts[level]) ?? 'Default'}
        data-pressed={pressed || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        <span ref={rail} className="th-rail" style={{ width: RAIL_W }}>
          {ultraAt > 0 && <span className="th-ultra-seg" data-on={level >= ultraAt || undefined} data-burst={burst || undefined} style={{ left: (ultraAt - 1) * step, width: step }} />}
          <span className="th-fill" style={{ ...move, transform: `scaleX(${fill})`, width: cap * step }} />
          {efforts.map((e, i) => (
            <span key={e} className="th-stop" data-on={i <= level || undefined} data-hover={i === hover || undefined} style={{ left: i * step }} />
          ))}
          {level >= 0 && <span className="th-thumb" style={{ ...move, transform: `translateX(${x}px)` }} />}
        </span>
      </div>
    </div>
  );
}

export interface ThinkingProps {
  efforts: Effort[];
  /** The level in use (the model's default when none was picked); undefined when the agent decides. */
  value: Effort | undefined;
  onChange: (e: Effort) => void;
  /** Ultracode can be switched for this session (`caps.features.ultracode`). */
  ultraOffered: boolean;
  ultracode: boolean;
  onUltracode: (on: boolean) => void;
  /** Speeds beyond standard the model offers; none hides the Speed row. */
  speeds?: SpeedInfo[];
  speed?: string;
  onSpeed?: (id: string) => void;
  side: 'top' | 'bottom';
  onClosed: () => void;
}

/** Standard and the model's faster speeds, one segmented row; a speed that costs more says so in its tooltip. */
function SpeedRow({ speeds, speed, onSpeed }: { speeds: SpeedInfo[]; speed: string; onSpeed: (id: string) => void }) {
  const options = [{ id: STANDARD_SPEED, name: 'Standard' } as SpeedInfo, ...speeds].map((s) => ({
    value: s.id,
    label: s.note ? (
      <Tip label={s.note} side="bottom">
        <span>{s.name}</span>
      </Tip>
    ) : (
      s.name
    ),
  }));
  return (
    <div className="th-speed">
      <div className="th-head">
        <span className="th-title">Speed</span>
      </div>
      <Segmented id="th-speed" className="th-speed-seg" value={speed} onChange={onSpeed} options={options} />
    </div>
  );
}

/**
 * The thinking control: the level's name and a step meter at rest; a small popover with the
 * stepped track and, where the agent has it, the ultracode switch. Choices apply live.
 */
export const Thinking = memo(function Thinking({ efforts, value, onChange, ultraOffered, ultracode, onUltracode, speeds = NO_SPEEDS, speed = STANDARD_SPEED, onSpeed, side, onClosed }: ThinkingProps) {
  const [open, setOpen] = useState(false);
  // What the control shows before the agent confirms a change, so the thumb never waits on a round trip.
  const [local, setLocal] = useState<Effort | undefined>();
  const shown = local && efforts.includes(local) ? local : value;
  const level = shown ? efforts.indexOf(shown) : -1;
  const ucOn = ultraOffered && ultracode;
  const look = ucOn || isUltraEffort(shown);

  const chip = useRef<HTMLButtonElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const sendTimer = useRef(0);
  const settleTimer = useRef(0);

  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<string>).detail === 'effort' && setOpen(true);
    window.addEventListener(MENU_EVENT, on);
    return () => window.removeEventListener(MENU_EVENT, on);
  }, []);

  // The confirmed value caught up (or never will): drop the local one.
  useEffect(() => {
    if (local && value === local) setLocal(undefined);
  }, [value, local]);
  useEffect(() => () => (window.clearTimeout(sendTimer.current), window.clearTimeout(settleTimer.current)), []);

  const pick = useCallback(
    (i: number) => {
      const e = efforts[i];
      if (!e) return;
      setLocal(e);
      // Dragging across stops sends only where it rests.
      window.clearTimeout(sendTimer.current);
      sendTimer.current = window.setTimeout(() => onChange(e), 90);
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => setLocal(undefined), 2500);
    },
    [efforts, onChange],
  );

  // The "ultra" moment: when it turns on by the user's hand, not when a view opens with it on.
  const [burst, setBurst] = useState(false);
  const wasLook = useRef(look);
  useEffect(() => {
    if (look === wasLook.current) return;
    wasLook.current = look;
    if (!look || reducedMotion()) return setBurst(false);
    setBurst(true);
    const t = window.setTimeout(() => setBurst(false), BURST_MS);
    return () => window.clearTimeout(t);
  }, [look]);

  // The chip hugs the current name, so the toolbar's gaps stay equal; a change of name eases the
  // width (one short WAAPI resize, nothing re-renders). The chip's right edge sits against the send
  // key and never moves, so the popover (aligned to it) stays put; only the model chip slides.
  const pill = useRef<HTMLSpanElement>(null);
  const lastPill = useRef(0);
  useLayoutEffect(() => {
    const el = pill.current;
    if (!el) return;
    const w = el.offsetWidth;
    const was = lastPill.current;
    lastPill.current = w;
    if (was && Math.abs(w - was) > 1) play(el, [{ width: `${was}px` }, { width: `${w}px` }], { duration: 140, easing: EASE_OUT });
  }, [shown, ucOn, efforts]);

  const hasSpeed = speeds.length > 0 && !!onSpeed;
  if (!efforts.length && !ultraOffered && !hasSpeed) return null;

  const fast = hasSpeed && speed !== STANDARD_SPEED;
  const speedName = speeds.find((s) => s.id === speed)?.name;
  const name = shown ? effortName(shown) : 'Default';
  const aria = (efforts.length ? `Effort: ${name}${ucOn ? ', ultracode on' : ''}` : ultraOffered ? `Ultracode ${ucOn ? 'on' : 'off'}` : 'Speed') + (fast ? `, ${speedName ?? 'fast'} speed` : '');
  const tip = efforts.length ? (ucOn ? `Effort and ultracode` : 'Effort') : ultraOffered ? 'Ultracode' : 'Speed';
  return (
    <RP.Root open={open} onOpenChange={setOpen}>
      <Tip label={tip} side="top">
        <RP.Trigger asChild>
          <button ref={chip} type="button" className="tb-chip th-chip" data-ultra={look || undefined} data-burst={burst || undefined} data-bare={!efforts.length || undefined} aria-label={aria}>
            {efforts.length > 0 ? (
              <>
                <span ref={pill} className="th-pill" aria-hidden>
                  {fast && <Icon name="bolt" size={13} className="th-bolt" />}
                  {look && <UltraMark className="th-uc-narrow" />}
                  <span className="th-nm th-cur">
                    <LevelName effort={shown} mark={ucOn} />
                  </span>
                  <Meter efforts={efforts} level={level} />
                </span>
              </>
            ) : (
              <span ref={pill} className="th-pill" aria-hidden>
                {ultraOffered ? <UltraMark className="th-uc" /> : <Icon name="bolt" size={13} className="th-bolt" />}
              </span>
            )}
          </button>
        </RP.Trigger>
      </Tip>
      <RP.Portal>
        <RP.Content
          className="pop cm-pop th-pop"
          data-spot
          side={side}
          align="end"
          sideOffset={8}
          collisionPadding={10}
          aria-label="Effort"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (track.current ?? (e.currentTarget as HTMLElement).querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onClosed();
          }}
        >
          {efforts.length > 0 && <Track efforts={efforts} level={level} onPick={pick} onDone={() => setOpen(false)} trackRef={track} burst={burst && isUltraEffort(shown)} />}
          {efforts.length > 0 && ultraOffered && <div className="menu-sep th-sep" role="separator" />}
          {ultraOffered && (
            <label className="th-uc-row" data-on={ucOn || undefined} data-burst={(burst && ucOn) || undefined}>
              <UltraMark className="th-uc-mark" />
              <span className="grow">Ultracode</span>
              <Switch checked={ucOn} onChange={onUltracode} label="Ultracode" />
            </label>
          )}
          {hasSpeed && (efforts.length > 0 || ultraOffered) && <div className="menu-sep th-sep" role="separator" />}
          {hasSpeed && <SpeedRow speeds={speeds} speed={speed} onSpeed={onSpeed!} />}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
});

/** The thinking control for the composer's choice, or a placeholder while the caps are on their way. */
export const ModelEffort = memo(function ModelEffort({
  choice,
  side,
  onClosed,
  ultraOffered,
  ultracode,
  onUltracode,
}: {
  choice: Choice;
  side: 'top' | 'bottom';
  onClosed: () => void;
  ultraOffered: boolean;
  ultracode: boolean;
  onUltracode: (on: boolean) => void;
}) {
  if (!choice.caps) return choice.capsPending ? <ChipSkeleton w={74} /> : null;
  const efforts = choice.model?.efforts ?? NO_EFFORTS;
  return (
    <Thinking
      efforts={efforts}
      value={choice.effort}
      onChange={choice.setEffort}
      ultraOffered={ultraOffered}
      ultracode={ultracode}
      onUltracode={onUltracode}
      speeds={choice.speeds}
      speed={choice.speed}
      onSpeed={choice.setSpeed}
      side={side}
      onClosed={onClosed}
    />
  );
});

const NO_EFFORTS: Effort[] = [];
const NO_SPEEDS: SpeedInfo[] = [];
