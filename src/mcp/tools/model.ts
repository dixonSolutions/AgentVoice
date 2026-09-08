/**
 * Model tools — agent_list_models / agent_set_model.
 *
 * Backed by the active AgentProvider's listModels() — never hardcoded, and
 * never locked to the Cursor CLI. The cache (state/models.ts) is keyed per
 * provider so switching settings.agentClient can't serve a stale/mismatched
 * list from a different CLI.
 *
 * A selection is (model, effort, fast). Effort levels and the fast tier are
 * whatever the CLI reported for that model, so setting `effort: "max"` on a
 * model that only lists low/medium/high is refused with the accepted levels.
 */

import {
  AUTO_MODEL_ID,
  clearModelCache,
  describeSelection,
  filterModels,
  findModel,
  getCachedModels,
  getModelCacheTimestamp,
  resolveSelection,
  setModelCache,
  type ModelEntry,
  type ModelSelection,
} from '../../state/models.js';
import {
  getSessionState,
  persistDefaultSelection,
  sessionSelection,
  setActiveSelection,
  setSelectionForAllSessions,
  setModelForAllProjects,
  type SessionState,
} from '../../state/registry.js';
import { childLogger } from '../../log.js';
import { getActiveProvider } from '../../providers/agents/registry.js';
import { notifyAuthRequired } from '../../providers/agents/authNotify.js';
import { parseMisroutedExecutionMode } from './questionDetect.js';

const log = childLogger('tool:model');

// ── agent_list_models ─────────────────────────────────────────────────────

export interface ListModelsArgs {
  query?: string;
  /** Bypass the cache and re-probe the CLI. */
  refresh?: boolean;
}

export interface ListModelsResult {
  models: ModelEntry[];
  /** Kept for existing callers — same as `active.model`. */
  active_model: string;
  active: ModelSelection;
  /** "Opus (1M context) · High · Fast" */
  active_label: string;
  cached_at: string | null;
  total: number;
  provider: string;
  supports_selection: boolean;
}

/**
 * Return cached models (refreshing if stale), optionally filtered.
 * If the cache is empty, calls the active provider's CLI and populates it.
 */
export async function handleListModels(
  args: ListModelsArgs,
  session: SessionState,
): Promise<ListModelsResult> {
  const provider = getActiveProvider();
  let models = args.refresh ? null : getCachedModels(provider.id);
  let cachedAt: string | null = null;

  if (!models) {
    log.info({ provider: provider.id, refresh: Boolean(args.refresh) }, 'model cache miss — fetching from CLI');
    if (args.refresh) clearModelCache(provider.id);
    models = await fetchAndCacheModels();
  } else {
    cachedAt = getModelCacheTimestamp(provider.id);
  }

  const filtered = args.query ? filterModels(models, args.query) : models;
  const active = sessionSelection(session);

  return {
    models: filtered,
    active_model: active.model,
    active,
    active_label: describeSelection(models, active),
    cached_at: cachedAt,
    total: filtered.length,
    provider: provider.id,
    supports_selection: provider.supportsModelSelection(),
  };
}

// ── agent_set_model ───────────────────────────────────────────────────────

export interface SetModelArgs {
  model_id: string;
  /** Effort level from the model's `efforts` list; null / "default" = CLI default. */
  effort?: string | null;
  /** Fast / priority tier — only for models reporting `fast: true`. */
  fast?: boolean;
  /**
   * global (default): default selection, all sessions, future sessions.
   * session: only this MCP/voice connection — use when user says "just this session".
   */
  scope?: 'global' | 'session';
}

export interface SetModelResult {
  active_model: string;
  active: ModelSelection;
  displayName: string;
  /** "Opus (1M context) · High · Fast" */
  label: string;
  scope: 'global' | 'session';
  sessions_updated?: number;
  default_updated?: boolean;
}

export async function handleSetModel(
  args: SetModelArgs,
  sessionKey: string,
): Promise<SetModelResult> {
  const provider = getActiveProvider();

  if (!provider.supportsModelSelection()) {
    throw new Error(
      `${provider.displayName} chooses its model from its own config, not this app — ` +
        `there is nothing to set here for the active provider.`,
    );
  }

  const misroutedMode = parseMisroutedExecutionMode(args.model_id);
  if (misroutedMode) {
    if (misroutedMode === 'ask') {
      throw new Error(
        `"${args.model_id}" is read-only Q&A mode — use agent_ask, not agent_set_model. ` +
          'For the AI model (Claude, GPT, etc.), use agent_list_models or leave as "auto".',
      );
    }
    throw new Error(
      `"${args.model_id}" is an execution mode, not an AI model. ` +
        `Use agent_submit with mode: "${misroutedMode}" when the user wants that behavior. ` +
        'For the AI model, use agent_list_models — or leave as "auto".',
    );
  }

  let models = getCachedModels(provider.id);
  if (!models) {
    models = await fetchAndCacheModels();
  }

  const entry = findModel(models, args.model_id);
  if (!entry) {
    // Show the first 10 matching IDs to help the caller
    const close = filterModels(models, args.model_id.split('-')[0] ?? args.model_id).slice(0, 10);
    throw new Error(
      `Unknown model ID "${args.model_id}". ` +
        (close.length > 0
          ? `Did you mean: ${close.map((m) => m.id).join(', ')}?`
          : 'Use agent_list_models to browse available models.'),
    );
  }

  // When only the model changes, keep the knobs the session already had — but
  // let resolveSelection clamp them to what the new model actually supports.
  const current = sessionSelection(getSessionState(sessionKey));
  const effortGiven = args.effort !== undefined;
  const requested: ModelSelection = {
    model: args.model_id,
    effort: effortGiven ? normalizeEffortArg(args.effort) : current.effort,
    fast: args.fast ?? current.fast,
  };
  const { selection, adjustments } = resolveSelection(models, requested, {
    // Explicit knobs the CLI does not offer are a caller error; inherited ones are just dropped.
    strict: effortGiven || args.fast !== undefined,
  });
  if (adjustments.length > 0) {
    log.info({ adjustments, requested }, 'selection clamped to CLI capabilities');
  }

  const scope = args.scope === 'session' ? 'session' : 'global';
  const label = describeSelection(models, selection);

  setActiveSelection(sessionKey, selection);

  if (scope === 'global') {
    persistDefaultSelection(selection);
    const sessionsUpdated = setSelectionForAllSessions(selection);
    setModelForAllProjects(selection.model);
    log.info(
      { selection, sessionsUpdated, scope, provider: provider.id },
      'model set globally (default + all sessions)',
    );
    return {
      active_model: selection.model,
      active: selection,
      displayName: entry.displayName,
      label,
      scope,
      sessions_updated: sessionsUpdated,
      default_updated: true,
    };
  }

  log.info({ selection, sessionKey, scope, provider: provider.id }, 'model set for session only');
  return {
    active_model: selection.model,
    active: selection,
    displayName: entry.displayName,
    label,
    scope,
  };
}

/** Voice callers say "default", "auto", "none" or "" for "let the CLI decide". */
function normalizeEffortArg(effort: string | null | undefined): string | null {
  if (effort === null || effort === undefined) return null;
  const trimmed = effort.trim().toLowerCase();
  if (!trimmed || trimmed === 'default' || trimmed === AUTO_MODEL_ID || trimmed === 'none') return null;
  return trimmed;
}

// ── Internal ──────────────────────────────────────────────────────────────

export async function fetchAndCacheModels(): Promise<ModelEntry[]> {
  const provider = getActiveProvider();
  try {
    const models = await provider.listModels();
    setModelCache(provider.id, models);
    return models;
  } catch (err) {
    const execErr = err as { code?: number; stderr?: string };
    const stderr = typeof execErr.stderr === 'string' ? execErr.stderr : '';
    const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
    if (provider.isAuthError(exitCode, stderr)) {
      void notifyAuthRequired('listing available models');
      throw new Error(`${provider.displayName} needs you to sign in before models can be listed.`);
    }
    throw err;
  }
}
