/**
 * Model cache DB helpers.
 *
 * Each agent provider's model list is cached separately (provider_model_cache,
 * keyed by provider id) so switching settings.agentClient never serves a stale
 * or mismatched list from another CLI. TTL is configurable in config.json
 * (default 1 hour).
 */

import { getDb } from './db.js';
import { getConfig, type AgentClient } from '../config.js';
import { childLogger } from '../log.js';

const log = childLogger('models');

export interface ModelEntry {
  id: string;
  displayName: string;
}

interface ModelCacheRow {
  provider: string;
  fetched_at: string;
  models_json: string;
}

// ── Read / write cache ────────────────────────────────────────────────────

/** Return cached models for a provider if fresh, null if stale or absent. */
export function getCachedModels(provider: AgentClient): ModelEntry[] | null {
  const row = getDb()
    .prepare('SELECT * FROM provider_model_cache WHERE provider = ?')
    .get(provider) as ModelCacheRow | undefined;

  if (!row) return null;

  const { settings } = getConfig();
  const age = Date.now() - new Date(row.fetched_at).getTime();
  if (age > settings.modelCacheTtlMs) {
    log.debug({ provider, ageMs: age, ttlMs: settings.modelCacheTtlMs }, 'model cache stale');
    return null;
  }

  try {
    return JSON.parse(row.models_json) as ModelEntry[];
  } catch {
    return null;
  }
}

/** Write / replace the model cache for a provider. */
export function setModelCache(provider: AgentClient, models: ModelEntry[]): void {
  getDb()
    .prepare(
      `INSERT INTO provider_model_cache (provider, fetched_at, models_json)
       VALUES (@provider, datetime('now'), @json)
       ON CONFLICT(provider) DO UPDATE SET
         fetched_at  = excluded.fetched_at,
         models_json = excluded.models_json`,
    )
    .run({ provider, json: JSON.stringify(models) });
  log.info({ provider, count: models.length }, 'model cache updated');
}

/** Fuzzy-contains filter: matches id or displayName case-insensitively. */
export function filterModels(models: ModelEntry[], query: string): ModelEntry[] {
  const q = query.toLowerCase();
  return models.filter(
    (m) => m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q),
  );
}

/** Validate that a model ID exists in a list. */
export function isValidModelId(models: ModelEntry[], id: string): boolean {
  return models.some((m) => m.id === id);
}
