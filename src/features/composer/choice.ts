import { useCallback, useMemo } from 'react';
import type { Capabilities, Effort, ModeInfo, ModelInfo, ProviderId } from '@shared/protocol';
import { modelNameById, visibleModels } from '@/lib/models';
import { homeAccountId, setEffort as setSessionEffort, setMode as setSessionMode, setModel as setSessionModel } from '@/state/actions';
import { useShallow } from 'zustand/react/shallow';
import { useCapsState } from '@/state/hooks';
import { useStore } from '@/state/store';

export const EFFORT_LABEL: Record<Effort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

// ── the effort last used with each model (per browser), so picking a model brings it back ──

const EFFORT_KEY = 'sable.modelEffort.v1';
let remembered: Record<string, Effort> | null = null;

function efforts(): Record<string, Effort> {
  if (remembered) return remembered;
  try {
    remembered = JSON.parse(localStorage.getItem(EFFORT_KEY) ?? '{}') as Record<string, Effort>;
  } catch {
    remembered = {};
  }
  return remembered;
}

export function rememberedEffort(provider: ProviderId, model: ModelInfo): Effort | undefined {
  const e = efforts()[`${provider}:${model.id}`];
  return e && model.efforts?.includes(e) ? e : undefined;
}

function remember(provider: ProviderId, modelId: string, effort: Effort) {
  const next = { ...efforts(), [`${provider}:${modelId}`]: effort };
  remembered = next;
  try {
    localStorage.setItem(EFFORT_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}

export interface Choice {
  provider: ProviderId;
  /** The account the caps come from (the session's, or the home choice). */
  accountId: string | undefined;
  caps: Capabilities | undefined;
  /** The caps are still on their way (show a placeholder); false once they arrived or failed for good. */
  capsPending: boolean;
  /** What the model menu lists: the visible models plus the one in use. */
  models: ModelInfo[];
  model?: ModelInfo;
  modelId?: string;
  /** The model's display name ("Fable 5.2"; an alias reads as what it resolves to). */
  modelLabel?: string;
  effort?: Effort;
  /** The effort was picked (not the model's default standing in). */
  effortChosen: boolean;
  mode?: ModeInfo;
  /** Picks a model with an effort: the one given, else the one last used with it, else the current one when it fits. */
  pickModel: (id: string, effort?: Effort) => void;
  setEffort: (e: Effort) => void;
  /** Home only: back to the model's default effort. */
  clearEffort?: () => void;
  setMode: (id: string) => void;
}

const NO_MODELS: ModelInfo[] = [];

/**
 * What the composer would use: the session's current model/effort/mode, or on the
 * home screen the choices for the next session (same rules as `homeChoice()`).
 */
export function useChoice(sessionId: string | null): Choice {
  const { caps, failed: capsFailed } = useCapsState(sessionId);
  const capsPending = !caps && !capsFailed;
  // The fields a choice reads, compared shallowly: usage ticks while streaming change the session, not these.
  const meta = useStore(
    useShallow((s) => {
      const m = sessionId ? s.sessions[sessionId] : undefined;
      return m ? { provider: m.provider, accountId: m.accountId, model: m.model, effort: m.effort, mode: m.mode } : undefined;
    }),
  );
  const homeProvider = useStore((s) => s.ui.homeProvider);
  const provider = meta?.provider ?? homeProvider;
  const accountId = useStore((s) => (meta ? meta.accountId : homeAccountId(provider, s)));
  const homeModel = useStore((s) => s.ui.homeModel[provider] ?? s.settings.defaultModels[provider]);
  const homeMode = useStore((s) => s.ui.homeMode[provider] ?? s.settings.defaultModes[provider]);
  const homeEffort = useStore((s) => s.ui.homeEffort[provider] ?? s.settings.defaultEfforts[provider]);
  const visibility = useStore((s) => s.settings.modelVisibility);

  const all = caps?.models ?? NO_MODELS;
  const modelId = meta ? meta.model : (homeModel ?? all.find((m) => m.isDefault)?.id ?? all[0]?.id);
  const model = all.find((m) => m.id === modelId);
  const models = useMemo(() => visibleModels(provider, all, visibility, modelId), [provider, all, visibility, modelId]);
  const modeId = meta ? meta.mode : (homeMode ?? caps?.modes[0]?.id);
  const mode = caps?.modes.find((m) => m.id === modeId);
  // No choice anywhere and no model default means the agent picks: show none rather than invent one.
  let effort = meta ? meta.effort : homeEffort;
  const effortChosen = !!(effort && model?.efforts?.includes(effort));
  if (model?.efforts?.length && (!effort || !model.efforts.includes(effort))) effort = model.defaultEffort;
  if (model && !model.efforts?.length) effort = undefined;

  const write = useCallback(
    (id: string | undefined, e: Effort | undefined) => {
      if (sessionId) {
        if (id) void setSessionModel(sessionId, id).then(() => e && setSessionEffort(sessionId, e));
        else if (e) void setSessionEffort(sessionId, e);
        return;
      }
      const s = useStore.getState();
      s.setUi({
        ...(id ? { homeModel: { ...s.ui.homeModel, [provider]: id } } : {}),
        ...(e ? { homeEffort: { ...s.ui.homeEffort, [provider]: e } } : {}),
      });
    },
    [sessionId, provider],
  );

  const pickModel = useCallback(
    (id: string, chosen?: Effort) => {
      const next = all.find((m) => m.id === id);
      const fits = (e: Effort | undefined) => (e && next?.efforts?.includes(e) ? e : undefined);
      const e = fits(chosen) ?? (next ? rememberedEffort(provider, next) : undefined) ?? fits(effort) ?? next?.defaultEffort;
      if (chosen && fits(chosen)) remember(provider, id, chosen);
      write(id === modelId ? undefined : id, e && e !== effort ? e : id !== modelId ? e : undefined);
    },
    [all, provider, effort, modelId, write],
  );

  const setEffort = useCallback(
    (e: Effort) => {
      if (modelId) remember(provider, modelId, e);
      write(undefined, e);
    },
    [provider, modelId, write],
  );

  const setMode = useCallback(
    (id: string) => {
      if (sessionId) void setSessionMode(sessionId, id);
      else {
        const s = useStore.getState();
        s.setUi({ homeMode: { ...s.ui.homeMode, [provider]: id } });
      }
    },
    [sessionId, provider],
  );

  const clearEffort = useCallback(() => {
    const s = useStore.getState();
    const next = { ...s.ui.homeEffort };
    delete next[provider];
    s.setUi({ homeEffort: next });
  }, [provider]);

  const modelLabel = modelNameById(modelId, all);
  // One object per distinct choice, so memoized controls skip renders when only the draft changed.
  return useMemo(
    () => ({ provider, accountId, caps, capsPending, models, model, modelId, modelLabel, effort, effortChosen, mode, pickModel, setEffort, clearEffort: sessionId ? undefined : clearEffort, setMode }),
    [provider, accountId, caps, capsPending, models, model, modelId, modelLabel, effort, effortChosen, mode, pickModel, setEffort, clearEffort, sessionId, setMode],
  );
}
