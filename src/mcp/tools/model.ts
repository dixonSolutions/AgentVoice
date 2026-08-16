/**
 * Model tools — agent_list_models / agent_set_model.
 *
 * Backed by the active AgentProvider's listModels() — never hardcoded, and
 * never locked to the Cursor CLI. The cache (state/models.ts) is keyed per
 * provider so switching settings.agentClient can't serve a stale/mismatched
 * list from a different CLI.
 */

import { getCachedModels, setModelCache, filterModels, isValidModelId, type ModelEntry } from '../../state/models.js';
import { setActiveModel, persistDefaultActiveModel, setActiveModelForAllSessions, setModelForAllProjects } from '../../state/registry.js';
import { childLogger } from '../../log.js';
import { getActiveProvider } from '../../providers/agents/registry.js';
import { notifyAuthRequired } from '../../providers/agents/authNotify.js';
import { parseMisroutedExecutionMode } from './questionDetect.js';

const log = childLogger('tool:model');

// ── agent_list_models ─────────────────────────────────────────────────────

export interface ListModelsArgs {
  query?: string;
}

export interface ListModelsResult {
  models: ModelEntry[];
  active_model: string;
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
  activeModel: string,
): Promise<ListModelsResult> {
  const provider = getActiveProvider();
  let models = getCachedModels(provider.id);
  let cachedAt: string | null = null;

  if (!models) {
    log.info({ provider: provider.id }, 'model cache miss — fetching from CLI');
    models = await fetchAndCacheModels();
  } else {
    cachedAt = new Date().toISOString(); // approximate — good enough
  }

  const filtered = args.query ? filterModels(models, args.query) : models;

  return {
    models: filtered,
    active_model: activeModel,
    cached_at: cachedAt,
    total: filtered.length,
    provider: provider.id,
    supports_selection: provider.supportsModelSelection(),
  };
}

// ── agent_set_model ───────────────────────────────────────────────────────

export interface SetModelArgs {
  model_id: string;
  /**
   * global (default): default selection, all sessions, future sessions.
   * session: only this MCP/voice connection — use when user says "just this session".
   */
  scope?: 'global' | 'session';
}

export interface SetModelResult {
  active_model: string;
  displayName: string;
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

  if (!isValidModelId(models, args.model_id)) {
    // Show the first 10 matching IDs to help the caller
    const close = filterModels(models, args.model_id.split('-')[0] ?? args.model_id).slice(0, 10);
    throw new Error(
      `Unknown model ID "${args.model_id}". ` +
        (close.length > 0
          ? `Did you mean: ${close.map((m) => m.id).join(', ')}?`
          : 'Use agent_list_models to browse available models.'),
    );
  }

  const scope = args.scope === 'session' ? 'session' : 'global';

  setActiveModel(sessionKey, args.model_id);
  const entry = models.find((m) => m.id === args.model_id)!;

  if (scope === 'global') {
    persistDefaultActiveModel(args.model_id);
    const sessionsUpdated = setActiveModelForAllSessions(args.model_id);
    setModelForAllProjects(args.model_id);
    log.info(
      { model: args.model_id, sessionsUpdated, scope, provider: provider.id },
      'model set globally (default + all sessions)',
    );
    return {
      active_model: args.model_id,
      displayName: entry.displayName,
      scope,
      sessions_updated: sessionsUpdated,
      default_updated: true,
    };
  }

  log.info({ model: args.model_id, sessionKey, scope, provider: provider.id }, 'model set for session only');
  return {
    active_model: args.model_id,
    displayName: entry.displayName,
    scope,
  };
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
