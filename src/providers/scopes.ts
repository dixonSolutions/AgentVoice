/**
 * Provider scopes — declarative, per-item options.
 *
 * A "scope" is one tunable a provider (or a single model) exposes: Deepgram's
 * `smart_format`, OpenRouter's routing preference, a Cursor model's
 * `effort=high`. Providers *declare* them; the UI renders them generically and
 * the settings store keeps a plain value map. That way a new option is one
 * entry in one file — never a new field in the config schema, a new form
 * control, and a new patch route.
 *
 * The same type describes provider-level scopes (STT/TTS) and per-model scopes
 * (agent CLI models), so there is one renderer and one resolver for both.
 *
 * See docs/30-provider-scopes-and-speech-providers.md.
 */

import { z } from 'zod';

export type ScopeValue = string | number | boolean;

export type ScopeKind = 'select' | 'toggle' | 'number' | 'text';

export interface ScopeChoice {
  value: ScopeValue;
  label: string;
  /** One-line trade-off note shown under the control. */
  note?: string;
}

export interface ProviderScope {
  /** Key in the value map. Matches the upstream API field where one exists. */
  id: string;
  label: string;
  kind: ScopeKind;
  default: ScopeValue;
  /** Required for `select`. */
  choices?: ScopeChoice[];
  /** `number` bounds — values outside are clamped, never rejected. */
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  help?: string;
  /** Render only while another scope holds one of these values. */
  showWhen?: { scope: string; equals: ScopeValue[] };
  /** Collapse behind a disclosure — Hick's Law for the long tail. */
  advanced?: boolean;
}

export type ScopeValues = Record<string, ScopeValue>;

export const ScopeValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const ScopeValuesSchema = z.record(z.string(), ScopeValueSchema);
/** provider (or model) id → its saved scope values. */
export const ScopeMapSchema = z.record(z.string(), ScopeValuesSchema);

export function scopeDefaults(scopes: readonly ProviderScope[]): ScopeValues {
  const out: ScopeValues = {};
  for (const scope of scopes) out[scope.id] = scope.default;
  return out;
}

function coerce(scope: ProviderScope, raw: ScopeValue): ScopeValue {
  switch (scope.kind) {
    case 'toggle':
      return typeof raw === 'boolean' ? raw : raw === 'true' || raw === 1;
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) return scope.default;
      const min = scope.min ?? Number.NEGATIVE_INFINITY;
      const max = scope.max ?? Number.POSITIVE_INFINITY;
      return Math.min(Math.max(n, min), max);
    }
    case 'select': {
      const value = typeof raw === 'object' ? scope.default : raw;
      const allowed = scope.choices?.some((c) => c.value === value);
      // An unknown choice usually means the provider's catalog moved on —
      // fall back rather than sending something upstream will reject.
      return allowed ? value : scope.default;
    }
    case 'text':
      return typeof raw === 'string' ? raw : String(raw);
  }
}

/**
 * Merge saved values over declared defaults, coercing and clamping each one.
 * Unknown saved keys are dropped — a provider that removed a scope should not
 * keep leaking it into API calls.
 */
export function resolveScopes(
  scopes: readonly ProviderScope[],
  saved: ScopeValues | undefined,
): ScopeValues {
  const out: ScopeValues = {};
  for (const scope of scopes) {
    const raw = saved?.[scope.id];
    out[scope.id] = raw === undefined ? scope.default : coerce(scope, raw);
  }
  return out;
}

/** Scopes whose `showWhen` guard is currently satisfied. */
export function visibleScopes(
  scopes: readonly ProviderScope[],
  values: ScopeValues,
): ProviderScope[] {
  return scopes.filter((scope) => {
    if (!scope.showWhen) return true;
    return scope.showWhen.equals.includes(values[scope.showWhen.scope] as ScopeValue);
  });
}

// ── Typed accessors ────────────────────────────────────────────────────────

export function scopeString(values: ScopeValues, id: string, fallback = ''): string {
  const v = values[id];
  return typeof v === 'string' ? v : v === undefined ? fallback : String(v);
}

export function scopeBool(values: ScopeValues, id: string, fallback = false): boolean {
  const v = values[id];
  return typeof v === 'boolean' ? v : fallback;
}

export function scopeNumber(values: ScopeValues, id: string, fallback = 0): number {
  const v = values[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Drop scopes left at their default. Sent upstream, an explicit default is
 * usually harmless but occasionally not (some APIs reject `temperature` on
 * models that do not support it), and it keeps config.json readable.
 */
export function nonDefaultScopes(
  scopes: readonly ProviderScope[],
  values: ScopeValues,
): ScopeValues {
  const out: ScopeValues = {};
  for (const scope of scopes) {
    const value = values[scope.id];
    if (value !== undefined && value !== scope.default) out[scope.id] = value;
  }
  return out;
}
