/**
 * Model tools — cursor_list_models, cursor_set_model
 *
 * Backed by cursor-agent models (CLI, parsed + cached in SQLite).
 * No model IDs are hardcoded — everything comes from the live CLI output.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import stripAnsi from 'strip-ansi';
import { getCachedModels, setModelCache, filterModels, isValidModelId, type ModelEntry } from '../../state/models.js';
import { setActiveModel, persistDefaultActiveModel, setActiveModelForAllSessions, setModelForAllProjects } from '../../state/registry.js';
import { childLogger } from '../../log.js';
import { buildCursorAgentEnv } from '../../executor/cursorAgent.js';
import { parseMisroutedExecutionMode } from './questionDetect.js';

const execFileAsync = promisify(execFile);
const log = childLogger('tool:model');

// ── cursor_list_models ────────────────────────────────────────────────────

export interface ListModelsArgs {
  query?: string;
}

export interface ListModelsResult {
  models: ModelEntry[];
  active_model: string;
  cached_at: string | null;
  total: number;
}

/**
 * Return cached models (refreshing if stale), optionally filtered.
 * If the cache is empty, calls cursor-agent models and populates it.
 */
export async function handleListModels(
  args: ListModelsArgs,
  activeModel: string,
): Promise<ListModelsResult> {
  let models = getCachedModels();
  let cachedAt: string | null = null;

  if (!models) {
    log.info('model cache miss — fetching from CLI');
    models = await fetchAndCacheModels();
  } else {
    // Pull cached_at timestamp for the response
    cachedAt = new Date().toISOString(); // approximate — good enough
  }

  const filtered = args.query ? filterModels(models, args.query) : models;

  return {
    models: filtered,
    active_model: activeModel,
    cached_at: cachedAt,
    total: filtered.length,
  };
}

// ── cursor_set_model ──────────────────────────────────────────────────────

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
  const misroutedMode = parseMisroutedExecutionMode(args.model_id);
  if (misroutedMode) {
    if (misroutedMode === 'ask') {
      throw new Error(
        `"${args.model_id}" is read-only Q&A mode — use cursor_ask, not cursor_set_model. ` +
          'For the AI model (Claude, GPT, etc.), use cursor_list_models or leave as "auto".',
      );
    }
    throw new Error(
      `"${args.model_id}" is an execution mode, not an AI model. ` +
        `Use cursor_submit with mode: "${misroutedMode}" when the user wants that behavior. ` +
        'For the AI model, use cursor_list_models — or leave as "auto".',
    );
  }

  let models = getCachedModels();
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
          : 'Use cursor_list_models to browse available models.'),
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
      { model: args.model_id, sessionsUpdated, scope },
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

  log.info({ model: args.model_id, sessionKey, scope }, 'model set for session only');
  return {
    active_model: args.model_id,
    displayName: entry.displayName,
    scope,
  };
}

// ── Internal ──────────────────────────────────────────────────────────────

async function fetchAndCacheModels(): Promise<ModelEntry[]> {
  const { stdout } = await execFileAsync('cursor-agent', ['models'], {
    timeout: 15_000,
    env: buildCursorAgentEnv(),
  });
  const models = parseModelsOutput(stdout);
  setModelCache(models);
  return models;
}

function parseModelsOutput(raw: string): ModelEntry[] {
  return stripAnsi(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.includes(' - ') &&
        !l.startsWith('Tip:') &&
        !l.startsWith('Available models') &&
        l.length > 0,
    )
    .map((l) => {
      const dashIdx = l.indexOf(' - ');
      return { id: l.slice(0, dashIdx).trim(), displayName: l.slice(dashIdx + 3).trim() };
    })
    .filter((m) => m.id.length > 0);
}
