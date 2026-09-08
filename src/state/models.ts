/**
 * Model cache + selection helpers.
 *
 * Each agent provider's model list is cached separately (provider_model_cache,
 * keyed by provider id) so switching settings.agentClient never serves a stale
 * or mismatched list from another CLI. TTL is configurable in config.json
 * (default 1 hour).
 *
 * The list itself always comes from the CLI (see providers/agents/*.ts). This
 * module only stores it and answers "is this (model, effort, fast) something
 * the CLI actually accepts?" — the same question the picker, the MCP tools and
 * the spawn path all need answered identically.
 */

import { getDb } from './db.js';
import { getConfig, type AgentClient } from '../config.js';
import { childLogger } from '../log.js';
import type { ModelEntry, ModelSelection, ModelVariant } from '../providers/agents/types.js';

export type { ModelEntry, ModelSelection, ModelVariant };

const log = childLogger('models');

/** Shared "let the CLI pick" sentinel — no --model flag is passed for it. */
export const AUTO_MODEL_ID = 'auto';

interface ModelCacheRow {
  provider: string;
  fetched_at: string;
  models_json: string;
}

// ── Read / write cache ────────────────────────────────────────────────────

/** Return cached models for a provider if fresh, null if stale or absent. */
export function getCachedModels(provider: AgentClient): ModelEntry[] | null {
  const row = readCacheRow(provider);
  if (!row) return null;

  const { settings } = getConfig();
  const age = Date.now() - parseSqliteUtc(row.fetched_at).getTime();
  if (age > settings.modelCacheTtlMs) {
    log.debug({ provider, ageMs: age, ttlMs: settings.modelCacheTtlMs }, 'model cache stale');
    return null;
  }
  return parseRow(row);
}

/**
 * Cached models regardless of age. Spawn paths use this: a stale list is still
 * the right one to resolve a Cursor variant id against, and re-probing the CLI
 * on every spawn would add seconds to each turn.
 */
export function getCachedModelsAnyAge(provider: AgentClient): ModelEntry[] | null {
  const row = readCacheRow(provider);
  return row ? parseRow(row) : null;
}

/** When the cache for a provider was last filled, or null if never. */
export function getModelCacheTimestamp(provider: AgentClient): string | null {
  const row = readCacheRow(provider);
  return row ? parseSqliteUtc(row.fetched_at).toISOString() : null;
}

/**
 * `datetime('now')` is UTC in "YYYY-MM-DD HH:MM:SS" form. `new Date()` reads
 * that as *local* time, which on a UTC-minus host made every cache row look
 * hours old and re-probed the CLI on each read.
 */
function parseSqliteUtc(value: string): Date {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
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
    .run({ provider, json: JSON.stringify(models.map(normalizeModelEntry)) });
  log.info({ provider, count: models.length }, 'model cache updated');
}

/** Drop the cache for a provider so the next read re-probes the CLI. */
export function clearModelCache(provider: AgentClient): void {
  getDb().prepare('DELETE FROM provider_model_cache WHERE provider = ?').run(provider);
}

function readCacheRow(provider: AgentClient): ModelCacheRow | undefined {
  return getDb()
    .prepare('SELECT * FROM provider_model_cache WHERE provider = ?')
    .get(provider) as ModelCacheRow | undefined;
}

function parseRow(row: ModelCacheRow): ModelEntry[] | null {
  try {
    const parsed = JSON.parse(row.models_json) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((m) => normalizeModelEntry(m as ModelEntry));
  } catch {
    return null;
  }
}

// ── Entry normalisation ───────────────────────────────────────────────────

/** Fill optional capability fields so consumers never branch on `undefined`. */
export function normalizeModelEntry(entry: ModelEntry): Required<Pick<ModelEntry, 'id' | 'displayName' | 'efforts' | 'fast'>> & ModelEntry {
  const variants = entry.variants?.length ? entry.variants : undefined;
  const efforts = entry.efforts?.length
    ? [...entry.efforts]
    : variants
      ? uniqueEfforts(variants)
      : [];
  const fast = entry.fast ?? (variants ? variants.some((v) => v.fast) : false);
  return {
    ...entry,
    efforts,
    fast,
    defaultEffort: entry.defaultEffort ?? null,
    ...(variants ? { variants } : {}),
  };
}

function uniqueEfforts(variants: ModelVariant[]): string[] {
  const out: string[] = [];
  for (const v of variants) {
    if (v.effort && !out.includes(v.effort)) out.push(v.effort);
  }
  return sortEfforts(out);
}

/**
 * Display order for effort ids. CLIs print their own order (Cursor's is
 * whatever the backend returned); the picker wants none → low → … → ultra.
 * Levels this table does not know keep their incoming order, after the known ones.
 */
const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function sortEfforts(efforts: string[]): string[] {
  return [...efforts].sort((a, b) => {
    const ra = EFFORT_RANK.indexOf(a);
    const rb = EFFORT_RANK.indexOf(b);
    if (ra === -1 && rb === -1) return 0;
    if (ra === -1) return 1;
    if (rb === -1) return -1;
    return ra - rb;
  });
}

// ── Lookup / filter ───────────────────────────────────────────────────────

/** Fuzzy-contains filter: matches id, displayName, vendor or description case-insensitively. */
export function filterModels(models: ModelEntry[], query: string): ModelEntry[] {
  const q = query.toLowerCase();
  return models.filter(
    (m) =>
      m.id.toLowerCase().includes(q) ||
      m.displayName.toLowerCase().includes(q) ||
      (m.vendor?.toLowerCase().includes(q) ?? false) ||
      (m.description?.toLowerCase().includes(q) ?? false) ||
      (m.variants?.some((v) => v.id.toLowerCase().includes(q)) ?? false),
  );
}

/** Validate that a model ID exists in a list (family id or a concrete variant id). */
export function isValidModelId(models: ModelEntry[], id: string): boolean {
  return findModel(models, id) !== null;
}

/**
 * Find the entry for `id`. Accepts a concrete variant id too, so an old
 * session holding `claude-opus-5-thinking-high` (Cursor) still resolves to its
 * family entry.
 */
export function findModel(models: ModelEntry[], id: string): ModelEntry | null {
  return (
    models.find((m) => m.id === id) ??
    models.find((m) => m.variants?.some((v) => v.id === id)) ??
    null
  );
}

// ── Selection semantics ───────────────────────────────────────────────────

export interface ResolvedSelection {
  selection: ModelSelection;
  entry: ModelEntry | null;
  /** Human-readable notes on anything that was clamped ("haiku has no effort knob"). */
  adjustments: string[];
}

/**
 * Snap a requested (model, effort, fast) to what the CLI offers for that model.
 *
 *  - a concrete Cursor variant id is decomposed into family + effort + fast;
 *  - an effort the model does not list is dropped (with a note) unless
 *    `strict`, in which case it throws with the accepted levels;
 *  - `fast` is cleared when the model has no fast tier;
 *  - for variant-based models the pair must exist; otherwise the nearest
 *    offered pair is used (same effort standard tier → default effort same
 *    tier → first variant).
 *
 * An unknown model id passes through untouched (`entry: null`) so callers
 * decide whether that is an error (agent_set_model) or fine (spawn with a
 * stale cache).
 */
export function resolveSelection(
  models: ModelEntry[],
  requested: ModelSelection,
  opts: { strict?: boolean } = {},
): ResolvedSelection {
  const entry = findModel(models, requested.model);
  if (!entry) {
    return { selection: { ...requested }, entry: null, adjustments: [] };
  }
  const norm = normalizeModelEntry(entry);
  const adjustments: string[] = [];
  let effort = requested.effort;
  let fast = requested.fast;

  // A concrete variant id carries its own effort/fast — prefer those. (The
  // family id can coincide with its plain variant, e.g. `gpt-5.3-codex`; that
  // is a family reference, not a request for the plain tier.)
  const variantHit =
    requested.model !== norm.id ? norm.variants?.find((v) => v.id === requested.model) : undefined;
  if (variantHit) {
    effort = variantHit.effort;
    fast = variantHit.fast;
  }

  if (effort && !norm.efforts.includes(effort)) {
    if (opts.strict) {
      throw new Error(
        norm.efforts.length > 0
          ? `${norm.displayName} accepts effort ${norm.efforts.join(', ')} — not "${effort}".`
          : `${norm.displayName} has no effort setting on this CLI.`,
      );
    }
    adjustments.push(
      norm.efforts.length > 0
        ? `${norm.displayName} accepts effort ${norm.efforts.join(', ')} — "${effort}" ignored`
        : `${norm.displayName} has no effort setting — "${effort}" ignored`,
    );
    effort = null;
  }

  if (fast && !norm.fast) {
    if (opts.strict) throw new Error(`${norm.displayName} has no fast tier on this CLI.`);
    adjustments.push(`${norm.displayName} has no fast tier — standard speed used`);
    fast = false;
  }

  if (norm.variants) {
    const pair = pickVariant(norm.variants, effort, fast);
    if (pair && (pair.effort !== effort || pair.fast !== fast)) {
      if (opts.strict) {
        throw new Error(
          `${norm.displayName} does not offer ${describeKnobs(effort, fast)} on this CLI. ` +
            `Available: ${norm.variants.map((v) => describeKnobs(v.effort, v.fast)).join('; ')}.`,
        );
      }
      adjustments.push(
        `${norm.displayName} does not offer ${describeKnobs(effort, fast)} — using ${describeKnobs(pair.effort, pair.fast)}`,
      );
      effort = pair.effort;
      fast = pair.fast;
    }
  }

  return { selection: { model: norm.id, effort, fast }, entry: norm, adjustments };
}

/** Nearest offered (effort, fast) pair — exact first, then relax speed, then effort. */
export function pickVariant(
  variants: ModelVariant[],
  effort: string | null,
  fast: boolean,
): ModelVariant | null {
  return (
    variants.find((v) => v.effort === effort && v.fast === fast) ??
    variants.find((v) => v.effort === effort) ??
    variants.find((v) => v.effort === null && v.fast === fast) ??
    variants.find((v) => v.effort === null) ??
    variants[0] ??
    null
  );
}

/**
 * Concrete id for a selection. Providers with real flags get the family id
 * back; variant-based providers get the CLI id for the pair. When the model is
 * not in `models` (stale/empty cache) fall back to Cursor's naming convention
 * so a spawn never blocks on a probe: `<family>[-<effort>][-fast]`.
 */
export function resolveVariantId(models: ModelEntry[], selection: ModelSelection): string {
  const entry = findModel(models, selection.model);
  if (!entry) {
    if (selection.model === AUTO_MODEL_ID) return selection.model;
    return `${selection.model}${selection.effort ? `-${selection.effort}` : ''}${selection.fast ? '-fast' : ''}`;
  }
  if (!entry.variants?.length) return entry.id;
  if (selection.model !== entry.id && entry.variants.some((v) => v.id === selection.model)) return selection.model;
  return pickVariant(entry.variants, selection.effort, selection.fast)?.id ?? entry.id;
}

function describeKnobs(effort: string | null, fast: boolean): string {
  const parts = [effort ? `effort ${effort}` : 'default effort'];
  if (fast) parts.push('fast');
  return parts.join(' + ');
}

/** "Opus (1M context) · High · Fast" — shared by the chip, toasts and voice replies. */
export function describeSelection(models: ModelEntry[], selection: ModelSelection): string {
  const entry = findModel(models, selection.model);
  const name = entry?.displayName ?? (selection.model === AUTO_MODEL_ID ? 'Auto' : selection.model);
  // A stored variant id (pre-upgrade session) carries its own knobs.
  const variant =
    entry && selection.model !== entry.id ? entry.variants?.find((v) => v.id === selection.model) : undefined;
  const effort = variant ? variant.effort : selection.effort;
  const fast = variant ? variant.fast : selection.fast;
  const parts = [name];
  if (effort) parts.push(effortLabel(effort));
  if (fast) parts.push('Fast');
  return parts.join(' · ');
}

/** Effort ids are the CLI's own; prettify the common ones, pass others through. */
export function effortLabel(effort: string): string {
  switch (effort) {
    case 'none':
      return 'None';
    case 'minimal':
      return 'Minimal';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'Extra high';
    case 'max':
      return 'Max';
    case 'ultra':
      return 'Ultra';
    default:
      return effort.charAt(0).toUpperCase() + effort.slice(1);
  }
}
