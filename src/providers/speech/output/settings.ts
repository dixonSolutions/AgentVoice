/**
 * Settings resolution for speech-output vendors.
 *
 * Separate from the orchestrator so a vendor file can read its own model,
 * voice and scope values without importing the module that imports it.
 */

import { getConfig, type SpeechOutputProviderId, type SpeechOutputSettings } from '../../../config.js';
import { resolveScopes, type ProviderScope, type ScopeValues } from '../../scopes.js';
import { baseLanguage } from '../languages.js';
import type { SpeechOutputRequest, SpeechOutputVendor } from './types.js';

export function speechOutputSettings(): SpeechOutputSettings {
  return getConfig().settings.workflow.llmIntelligence.audio.tts;
}

/**
 * The language the agent should speak.
 *
 * `tts.language: 'auto'` follows the speech-input setting, so talking to it in
 * Polish gets a Polish reply without configuring the same thing twice.
 */
export function speechOutputLanguage(): string | undefined {
  const audio = getConfig().settings.workflow.llmIntelligence.audio;
  return baseLanguage(audio.tts.language) ?? baseLanguage(audio.stt.language) ?? undefined;
}

export function resolveModelFor(
  id: SpeechOutputProviderId,
  fallback: string,
  settings = speechOutputSettings(),
): string {
  return settings.models[id]?.trim() || fallback;
}

export function resolveVoiceFor(
  id: SpeechOutputProviderId,
  fallback: string,
  settings = speechOutputSettings(),
): string {
  return settings.voices[id]?.trim() || fallback;
}

/** Provider scopes plus any the selected model adds (model wins on conflict). */
export function scopeDefsFor(vendor: SpeechOutputVendor, model: string): ProviderScope[] {
  const modelScopes = vendor.models.find((m) => m.id === model)?.scopes ?? [];
  const byId = new Map<string, ProviderScope>();
  for (const scope of [...vendor.scopes, ...modelScopes]) byId.set(scope.id, scope);
  return [...byId.values()];
}

export interface VendorCall {
  model: string;
  voice: string;
  scopes: ScopeValues;
  language: string | undefined;
  signal: AbortSignal | undefined;
}

export function resolveVendorCall(
  vendor: SpeechOutputVendor,
  req: SpeechOutputRequest,
  settings = speechOutputSettings(),
): VendorCall {
  const model = req.modelOverride?.trim() || resolveModelFor(vendor.id, vendor.defaultModel, settings);
  return {
    model,
    voice: req.voiceOverride?.trim() || resolveVoiceFor(vendor.id, vendor.defaultVoice(model), settings),
    scopes: resolveScopes(scopeDefsFor(vendor, model), settings.scopes[vendor.id]),
    language: req.language ?? speechOutputLanguage(),
    signal: req.signal,
  };
}
