import { Fragment, memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import type { ProviderId } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { Icon, MODE_ICON } from '@/icons';
import { baseName, tildePath } from '@/lib/format';
import { fuzzy } from '@/lib/fuzzy';
import { modelName } from '@/lib/models';
import { currentBranch } from '@/lib/workspace';
import { homeAccountId, openSettings, setHomeAccount } from '@/state/actions';
import { accountName } from '@/state/hooks';
import { useStore } from '@/state/store';
import { Kbd, PathLabel, Tip } from '@/ui';
import { planWord } from '@/features/accounts/model';
import { LimitDot } from '@/features/usage';
import { type Choice } from './choice';
import { Morph } from './Morph';

export const ChipSkeleton = ({ w }: { w: number }) => <span className="chip-skel skel" style={{ width: w }} aria-hidden />;

/** The model and mode menus share one width so they read as a pair. */
const MENU_W = 232;

/** Slash commands ("/model", "/mode", "/effort") open the toolbar menus through this event. */
export const MENU_EVENT = 'sable:composer-menu';
export const openComposerMenu = (which: 'model' | 'mode' | 'effort') => window.dispatchEvent(new CustomEvent(MENU_EVENT, { detail: which }));

/** Open state kept inside the control, so opening a menu re-renders the menu and nothing else. */
function useMenuOpen(which: 'model' | 'mode') {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<string>).detail === which && setOpen(true);
    window.addEventListener(MENU_EVENT, on);
    return () => window.removeEventListener(MENU_EVENT, on);
  }, [which]);
  return [open, setOpen] as const;
}

/**
 * These menus open over their trigger with the current row lying on it, so the release of the
 * click that opened one lands on that row, and Radix picks an item on pointer-up. A release
 * shortly after opening, with no press inside the menu, is ignored.
 */
function useReleaseGuard(open: boolean) {
  const at = useRef(0);
  const pressed = useRef(false);
  if (open && !at.current) {
    at.current = performance.now();
    pressed.current = false;
  } else if (!open) at.current = 0;
  return {
    onPointerDown: () => void (pressed.current = true),
    onPointerUp: (e: { preventDefault: () => void }) => {
      if (!pressed.current && performance.now() - at.current < 500) e.preventDefault();
    },
  };
}

/**
 * The mode and model menus open over their trigger and put focus on the current row themselves
 * (ui/grow.ts, at the next frame). Radix's own focus on the menu first would be a second focus
 * move, and a second forced style pass, inside the task that opens the menu.
 */
// DropdownMenu.Content passes this through to the menu's focus scope; its types leave it out.
const SKIP_OPEN_FOCUS = { onOpenAutoFocus: (e: Event) => e.preventDefault() } as object;

interface MenuProps {
  choice: Choice;
  side: 'top' | 'bottom';
  onClosed: () => void;
}

// ───────────────────────── mode ─────────────────────────

export const ModeMenu = memo(function ModeMenu({ choice, side, onClosed }: MenuProps) {
  const [open, setOpen] = useMenuOpen('mode');
  const guard = useReleaseGuard(open);
  const modes = choice.caps?.modes ?? [];
  const cur = choice.mode;
  // The order holds while the menu is open and while it shrinks away; it turns once it is gone.
  const [anchor, setAnchor] = useState(cur?.id);
  useEffect(() => {
    if (open) return;
    const t = window.setTimeout(() => setAnchor(cur?.id), 140);
    return () => window.clearTimeout(t);
  }, [open, cur?.id]);
  if (!choice.caps) return choice.capsPending ? <ChipSkeleton w={84} /> : null;
  if (!modes.length) return null;
  // The list is the Shift+Tab cycle, turned so the mode in use is the row nearest the trigger:
  // the menu opens over the chip with that row lying on it.
  const at = Math.max(0, modes.findIndex((m) => m.id === anchor));
  const up = side === 'top';
  const ordered = up ? [...modes.slice(at + 1), ...modes.slice(0, at + 1)] : [...modes.slice(at), ...modes.slice(0, at)];
  const foot = (
    <div className="mm-foot-static" key="foot">
      <span className="grow">Cycle modes</span>
      <Kbd combo="shift+tab" />
    </div>
  );
  const sep = <RM.Separator className="menu-sep mm-sep" key="sep" />;
  return (
    <RM.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip label="Mode" keys="shift+tab" side="top">
        <RM.Trigger asChild>
          <button type="button" className="tb-chip cm-mode" data-tone={cur?.tone ?? 'ask'} aria-label={`Mode: ${cur?.name ?? 'default'}`}>
            <Icon name={MODE_ICON[cur?.tone ?? 'ask']} size={15} />
            <Morph k={cur?.id ?? ''} className="cm-mode-label">
              {cur?.name ?? 'Mode'}
            </Morph>
          </button>
        </RM.Trigger>
      </Tip>
      <RM.Portal>
        <RM.Content
          className="pop cm-pop mm-pop"
          data-origin="select"
          data-spot
          side={side}
          align="start"
          sideOffset={8}
          collisionPadding={10}
          style={{ width: MENU_W - 24 }}
          {...SKIP_OPEN_FOCUS}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onClosed();
          }}
        >
          {up && [foot, sep]}
          {ordered.map((m) => (
            <RM.Item key={m.id} className="menu-item mm-row" data-current={m.id === anchor || undefined} onSelect={() => choice.setMode(m.id)} {...guard}>
              <Icon name={MODE_ICON[m.tone] ?? 'shield'} size={15} className="mm-lead" />
              <span className="mm-name truncate" data-origin-anchor>
                {m.name}
              </span>
              <span className="mm-check">{m.id === cur?.id && <Icon name="check" size={14} />}</span>
            </RM.Item>
          ))}
          {!up && [sep, foot]}
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
});

// ───────────────────────── model ─────────────────────────

/** A name with the characters a filter matched drawn brighter. */
function Hits({ text, indices }: { text: string; indices?: number[] }) {
  if (!indices?.length) return <>{text}</>;
  const set = new Set(indices);
  return (
    <>
      {[...text].map((ch, i) =>
        set.has(i) ? (
          <b key={i} className="mm-hit">
            {ch}
          </b>
        ) : (
          <Fragment key={i}>{ch}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * The model menu: the list of models and nothing else. Picking one keeps the effort last used
 * with it. Typing filters; a field appears only when the list is long.
 */
export const ModelPopover = memo(function ModelPopover({ choice, side, onClosed }: MenuProps) {
  const [open, setOpen] = useMenuOpen('model');
  const guard = useReleaseGuard(open);
  const [query, setQuery] = useState('');
  const content = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  if (!choice.caps) return choice.capsPending ? <ChipSkeleton w={96} /> : null;
  if (!choice.caps.models.length) return null;

  const models = choice.models;
  const withField = models.length > 7;
  const q = query.trim();
  const rows = models
    .map((m) => {
      const name = modelName(m) ?? m.id;
      return { m, name, hit: q ? fuzzy(q, name) : undefined };
    })
    .filter((r) => !q || r.hit);

  const name = choice.modelLabel ?? 'Model';
  const pick = (id: string) => {
    choice.pickModel(id);
    setOpen(false);
  };

  // Typing anywhere in the menu filters (Radix's own typeahead would only jump).
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target === field.current || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1 && (e.key !== ' ' || query)) {
      e.preventDefault();
      setQuery((v) => v + e.key);
      if (withField) field.current?.focus();
    } else if (e.key === 'Backspace' && query) {
      e.preventDefault();
      setQuery((v) => v.slice(0, -1));
    }
  };

  return (
    <RM.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip label="Model" side="top">
        <RM.Trigger asChild>
          <button type="button" className="tb-chip cm-model" aria-label={`Model: ${name}`}>
            <Morph k={name} className="cm-model-name">
              <span className="truncate" data-origin-anchor>
                {name}
              </span>
            </Morph>
            <Icon name="caret-down" size={11} className="caret" />
          </button>
        </RM.Trigger>
      </Tip>
      <RM.Portal>
        <RM.Content
          ref={content}
          className="pop cm-pop mm-pop"
          data-origin="select"
          data-spot
          side={side}
          align="end"
          sideOffset={8}
          collisionPadding={10}
          loop
          style={{ width: MENU_W }}
          aria-label="Model"
          {...SKIP_OPEN_FOCUS}
          onKeyDown={onKeyDown}
          onEscapeKeyDown={(e) => {
            if (!query) return;
            e.preventDefault();
            setQuery('');
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onClosed();
          }}
        >
          {withField && (
            <div className="mm-search">
              <Icon name="search" size={14} />
              <input
                ref={field}
                className="mm-field"
                value={query}
                placeholder="Search models"
                aria-label="Search models"
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') return;
                  e.stopPropagation();
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    content.current?.querySelector<HTMLElement>('[data-mrow]')?.focus();
                  } else if (e.key === 'Enter' && rows[0]) {
                    e.preventDefault();
                    pick(rows[0].m.id);
                  }
                }}
              />
            </div>
          )}
          <div className="mm-list scroll">
            {rows.map(({ m, name, hit }) => {
              const current = m.id === choice.modelId;
              return (
                <RM.Item key={m.id} className="menu-item mm-row" data-mrow data-current={current || undefined} onSelect={() => pick(m.id)} {...guard}>
                  <ProviderMark provider={choice.provider} size={14} className="mm-mark" />
                  <span className="mm-name truncate" data-origin-anchor>
                    <Hits text={name} indices={hit?.indices} />
                  </span>
                  <span className="mm-check">{current && <Icon name="check" size={14} />}</span>
                </RM.Item>
              );
            })}
            {!rows.length && <div className="mm-empty">No models match “{q}”</div>}
          </div>
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
});

// ───────────────────────── home chips ─────────────────────────

function useBranch(cwd: string | null) {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    setBranch(null);
    if (!cwd) return;
    let live = true;
    currentBranch(cwd)
      .then((b) => live && setBranch(b ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [cwd]);
  return branch;
}

function AgentMenu({ onClosed }: { onClosed: () => void }) {
  const provider = useStore((s) => s.ui.homeProvider);
  const providers = useStore((s) => s.providers);
  // Subscribed so the checks follow the choice.
  const homeAccount = useStore((s) => s.ui.homeAccount);
  const setUi = useStore((s) => s.setUi);
  const installed = (Object.values(providers) as NonNullable<(typeof providers)[ProviderId]>[]).filter((p) => p.installed);
  const accountOf = (id: ProviderId) => homeAccountId(id, { ui: { ...useStore.getState().ui, homeAccount }, providers });
  const mine = providers[provider]?.accounts ?? [];
  const chipPick = mine.find((a) => a.id === accountOf(provider));
  // The account shows only when there is a choice; its label, never an address.
  const chipAccount = mine.length > 1 ? accountName(chipPick) : undefined;

  return (
    <RM.Root modal={false}>
      <RM.Trigger asChild>
        <button type="button" className="hc" aria-label={`Agent: ${PROVIDER_NAME[provider]}${chipAccount ? `, ${chipAccount}` : ''}`}>
          <ProviderMark provider={provider} size={15} className="hc-mark" />
          <Morph k={`${provider}:${chipAccount ?? ''}`}>
            {PROVIDER_NAME[provider]}
            {chipAccount && <span className="hc-account truncate">{chipAccount}</span>}
          </Morph>
          {chipPick && mine.length > 1 && <LimitDot provider={provider} accountId={chipPick.id} />}
          <Icon name="caret-down" size={10} className="hc-caret" />
        </button>
      </RM.Trigger>
      <RM.Portal>
        <RM.Content
          className="pop cm-pop"
          data-spot
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={10}
          style={{ width: 248 }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onClosed();
          }}
        >
          {installed.map((p) => {
            const accounts = p.accounts ?? [];
            const several = accounts.length > 1;
            const chosen = accountOf(p.id);
            return (
              <RM.Group key={p.id} className="hc-group">
                <RM.Item className="menu-item cm-row" onSelect={() => (p.auth.loggedIn || several ? setUi({ homeProvider: p.id }) : openSettings('accounts'))}>
                  <ProviderMark provider={p.id} size={15} className="hc-mark" />
                  <span className="cm-row-name grow">{PROVIDER_NAME[p.id]}</span>
                  {/* With several accounts the check goes on the account, not twice. */}
                  <span className="cm-check">{p.id === provider && !several ? <Icon name="check" size={14} /> : !p.auth.loggedIn && !several && <span className="hc-signin">Sign in</span>}</span>
                </RM.Item>
                {several &&
                  accounts.map((a) => (
                    <RM.Item
                      key={a.id}
                      className="menu-item hc-acct"
                      data-current={(p.id === provider && a.id === chosen) || undefined}
                      onSelect={() => {
                        if (!a.auth.loggedIn) return openSettings('accounts');
                        setHomeAccount(p.id, a.id);
                        setUi({ homeProvider: p.id });
                      }}
                    >
                      <span className="grow truncate">{accountName(a)}</span>
                      <span className="hc-plan">{a.auth.loggedIn ? planWord(a) : 'Sign in'}</span>
                      <span className="hc-acct-end">
                        <LimitDot provider={p.id} accountId={a.id} />
                        {p.id === provider && a.id === chosen && <Icon name="check" size={14} />}
                      </span>
                    </RM.Item>
                  ))}
              </RM.Group>
            );
          })}
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}

function FolderMenu({ onClosed }: { onClosed: () => void }) {
  const cwd = useStore((s) => s.ui.homeCwd);
  const projects = useStore((s) => s.projects);
  const home = useStore((s) => s.home);
  const setUi = useStore((s) => s.setUi);
  const recent = [...projects].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastOpened - a.lastOpened).slice(0, 8);
  return (
    <RM.Root modal={false}>
      <RM.Trigger asChild>
        <button type="button" className="hc" data-missing={!cwd || undefined} aria-label={cwd ? `Folder: ${baseName(cwd)}` : 'Choose a folder'}>
          <Icon name={cwd ? 'folder' : 'folder-plus'} size={15} className="hc-icon" />
          <Morph k={cwd ?? ''}>{cwd ? baseName(cwd) : 'Choose a folder'}</Morph>
          <Icon name="caret-down" size={10} className="hc-caret" />
        </button>
      </RM.Trigger>
      <RM.Portal>
        <RM.Content
          className="pop cm-pop"
          data-spot
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={10}
          style={{ width: 300 }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onClosed();
          }}
        >
          {recent.map((p) => (
            <RM.Item key={p.path} className="menu-item cm-row" onSelect={() => setUi({ homeCwd: p.path })}>
              <Icon name={p.pinned ? 'pin' : 'folder'} size={15} className="hc-icon" />
              <PathLabel path={tildePath(p.path, home)} title={p.path} className="cm-row-path grow" />
              <span className="cm-check">{p.path === cwd && <Icon name="check" size={14} />}</span>
            </RM.Item>
          ))}
          {recent.length > 0 && <RM.Separator className="menu-sep" />}
          <RM.Item className="menu-item cm-row" onSelect={() => setUi({ projectPicker: true })}>
            <Icon name="folder-open" size={15} className="hc-icon" />
            <span className="grow">Open a folder…</span>
            <Kbd combo="mod+o" />
          </RM.Item>
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}

function BranchChip() {
  const cwd = useStore((s) => s.ui.homeCwd);
  const branch = useBranch(cwd);
  if (!cwd || !branch) return null;
  return (
    <Tip label="Current branch" side="bottom">
      <span className="hc hc-static" tabIndex={0} aria-label={`Branch: ${branch}`}>
        <Icon name="branch" size={15} className="hc-icon" />
        <Morph k={branch}>
          <span className="truncate">{branch}</span>
        </Morph>
      </span>
    </Tip>
  );
}

/** The agent chosen on the home screen is installed but its chosen account is not signed in. */
export function useHomeSignedOut(): boolean {
  return useStore((s) => {
    const id = s.ui.homeProvider;
    const p = s.providers[id];
    if (!p?.installed) return false;
    const acct = p.accounts?.find((a) => a.id === homeAccountId(id, s));
    return !(acct ? acct.auth.loggedIn : p.auth.loggedIn);
  });
}

/** Beside the agent chip while that agent is not signed in: one step to Settings › Accounts. */
function SignInChip() {
  if (!useHomeSignedOut()) return null;
  return (
    <button type="button" className="hc" onClick={() => openSettings('accounts')}>
      <span className="hc-signin">Sign in</span>
    </button>
  );
}

/** Agent, folder and branch for the next session, under the home composer. Each chip subscribes to its own slice. */
export const HomeChips = memo(function HomeChips({ onClosed }: { onClosed: () => void }) {
  return (
    <div className="home-chips-row">
      <AgentMenu onClosed={onClosed} />
      <SignInChip />
      <FolderMenu onClosed={onClosed} />
      <BranchChip />
    </div>
  );
});
