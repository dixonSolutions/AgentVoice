/**
 * Settings resolution for speech-input vendors.
 *
 * Separate from the registry so a vendor file can read its own model and scope
 * values without importing the registry that imports it.
 */

import { getConfig, type SpeechInputProviderId, type SpeechInputSettings } from '../../../config.js';
import { resolveScopes, type ProviderScope, type ScopeValues } from '../../scopes.js';
import { baseLanguage } from '../languages.js';
import type { SpeechInputRequest, SpeechInputVendor } from './types.js';

export function speechInputSettings(): SpeechInputSettings {
  return getConfig().settings.workflow.llmIntelligence.audio.stt;
}

/** Configured model for a provider, falling back to the vendor's own default. */
export function resolveModelFor(
  id: SpeechInputProviderId,
  fallback: string,
  settings = speechInputSettings(),
): string {
  return settings.models[id]?.trim() || fallback;
}

/**
 * Provider scopes plus any the selected model adds. Model scopes come last so
 * a model can override a provider-level default without a parallel list.
 */
export function scopeDefsFor(vendor: SpeechInputVendor, model: string): ProviderScope[] {
  const modelScopes = vendor.models.find((m) => m.id === model)?.scopes ?? [];
  const byId = new Map<string, ProviderScope>();
  for (const scope of [...vendor.scopes, ...modelScopes]) byId.set(scope.id, scope);
  return [...byId.values()];
}

export interface VendorCall {
  model: string;
  scopes: ScopeValues;
  /** Undefined means "let the provider detect". */
  language: string | undefined;
  signal: AbortSignal | undefined;
}

/**
 * Everything a converter needs beyond the neutral request: which model this
 * vendor should use, its resolved scope values, and the language.
 */
export function resolveVendorCall(
  vendor: SpeechInputVendor,
  req: SpeechInputRequest,
  settings = speechInputSettings(),
): VendorCall {
  const model = req.modelOverride?.trim() || resolveModelFor(vendor.id, vendor.defaultModel, settings);
  return {
    model,
    scopes: resolveScopes(scopeDefsFor(vendor, model), settings.scopes[vendor.id]),
    language: req.language ?? baseLanguage(settings.language) ?? undefined,
    signal: req.signal,
  };
}
