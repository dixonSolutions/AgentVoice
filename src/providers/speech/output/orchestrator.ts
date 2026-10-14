/**
 * Speech-output orchestrator — the policy half.
 *
 * Same shape as the input side: chain order, capability checks, retry rules.
 * The capability check is doing more work here than anywhere else in the app,
 * because a text-to-speech vendor can fail a language at three levels — the
 * provider, the model, or the individual voice — and picking the wrong one
 * produces confident mispronunciation rather than an error.
 */

import type { SpeechOutputProviderId } from '../../../config.js';
import { ProviderHttpError, createHttpSpecializer } from '../../../orchestration/http.js';
import type { OrchestrationPolicy } from '../../../orchestration/types.js';
import { baseLanguage, supportsLanguage, type LanguageSupport } from '../languages.js';
import { resolveModelFor, resolveVoiceFor, speechOutputSettings } from './settings.js';
import { deepgramSpeechOutput } from './vendors/deepgram.js';
import { elevenlabsSpeechOutput } from './vendors/elevenlabs.js';
import { geminiSpeechOutput } from './vendors/gemini.js';
import { groqSpeechOutput } from './vendors/groq.js';
import { localSpeechOutput } from './vendors/local.js';
import { openaiSpeechOutput } from './vendors/openai.js';
import { pollySpeechOutput } from './vendors/polly.js';
import type {
  SpeechOutputCapabilities,
  SpeechOutputRequest,
  SpeechOutputResult,
  SpeechOutputSpecializer,
  SpeechOutputVendor,
} from './types.js';

type ServerId = Exclude<SpeechOutputProviderId, 'browser'>;

const VENDORS: Record<ServerId, SpeechOutputVendor> = {
  local_speech: localSpeechOutput,
  elevenlabs: elevenlabsSpeechOutput,
  openai: openaiSpeechOutput,
  gemini: geminiSpeechOutput,
  deepgram: deepgramSpeechOutput,
  groq: groqSpeechOutput,
  amazon_polly: pollySpeechOutput,
};

function toSpecializer(vendor: SpeechOutputVendor): SpeechOutputSpecializer {
  const meta = {
    id: vendor.id,
    displayName: vendor.displayName,
    description: vendor.description,
    capabilities: vendor.capabilities,
    isConfigured: vendor.isConfigured,
    ...(vendor.checkAvailability ? { checkAvailability: vendor.checkAvailability } : {}),
    ...(vendor.unconfiguredDetail ? { unconfiguredDetail: vendor.unconfiguredDetail } : {}),
  };

  if (vendor.transport === 'http') {
    return createHttpSpecializer<SpeechOutputRequest, SpeechOutputResult, SpeechOutputCapabilities>({
      ...meta,
      converter: vendor.converter,
    });
  }

  const handle = vendor.handle;
  return {
    ...meta,
    async checkAvailability() {
      if (vendor.checkAvailability) return vendor.checkAvailability();
      return vendor.isConfigured()
        ? { available: true }
        : { available: false, ...(vendor.unconfiguredDetail ? { detail: vendor.unconfiguredDetail } : {}) };
    },
    handle,
  };
}

const SPECIALIZERS: Record<ServerId, SpeechOutputSpecializer> = Object.fromEntries(
  Object.entries(VENDORS).map(([id, vendor]) => [id, toSpecializer(vendor)]),
) as Record<ServerId, SpeechOutputSpecializer>;

/** Picker order: local and best-quality first, Polly last (the legacy default). */
export const SPEECH_OUTPUT_PICKER_ORDER: readonly SpeechOutputProviderId[] = [
  'browser',
  'local_speech',
  'elevenlabs',
  'openai',
  'gemini',
  'deepgram',
  'groq',
  'amazon_polly',
];

export function isServerSpeechOutput(id: SpeechOutputProviderId): id is ServerId {
  return id !== 'browser' && id in VENDORS;
}

export function getSpeechOutputVendor(id: SpeechOutputProviderId): SpeechOutputVendor | null {
  return isServerSpeechOutput(id) ? VENDORS[id] : null;
}

export function getSpeechOutputSpecializer(
  id: SpeechOutputProviderId,
): SpeechOutputSpecializer | null {
  return isServerSpeechOutput(id) ? SPECIALIZERS[id] : null;
}

export function listSpeechOutputVendors(): SpeechOutputVendor[] {
  return SPEECH_OUTPUT_PICKER_ORDER.filter(isServerSpeechOutput).map((id) => VENDORS[id]);
}

export function speechOutputChain(settings = speechOutputSettings()): SpeechOutputProviderId[] {
  const seen = new Set<SpeechOutputProviderId>();
  const out: SpeechOutputProviderId[] = [];
  for (const id of [settings.provider, ...settings.fallbacks]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Languages this vendor can speak with the selected model and voice.
 *
 * All three narrow: Groq's PlayAI is English or Arabic depending on the model,
 * and a Kokoro voice is bound to one language regardless of the model's range.
 */
export function speechOutputLanguages(
  id: SpeechOutputProviderId,
  model?: string,
  voice?: string,
): LanguageSupport {
  const vendor = getSpeechOutputVendor(id);
  if (!vendor) return 'all';
  const voiceLanguages = vendor.voices(model).find((v) => v.id === voice)?.languages;
  if (voiceLanguages) return voiceLanguages;
  return vendor.models.find((m) => m.id === model)?.languages ?? vendor.capabilities.languages;
}

export const speechOutputPolicy: OrchestrationPolicy<
  SpeechOutputRequest,
  SpeechOutputResult,
  SpeechOutputCapabilities
> = {
  chain: () => speechOutputChain(),

  resolve: (id) => getSpeechOutputSpecializer(id as SpeechOutputProviderId),

  accepts(specializer, req) {
    const language = baseLanguage(req.language);
    if (!language) return true;

    const id = specializer.id as SpeechOutputProviderId;
    if (!supportsLanguage(specializer.capabilities.languages, language)) {
      return `cannot speak ${language}`;
    }

    const settings = speechOutputSettings();
    const vendor = getSpeechOutputVendor(id);
    if (!vendor) return true;
    const model = req.modelOverride?.trim() || resolveModelFor(id, vendor.defaultModel, settings);
    const voice = req.voiceOverride?.trim() || resolveVoiceFor(id, vendor.defaultVoice(model), settings);

    // The provider can speak it — but can *this* voice? Polly resolves against
    // its live catalog and swaps the voice itself.
    if (supportsLanguage(speechOutputLanguages(id, model, voice), language)) return true;
    return id === 'amazon_polly' ? true : `no ${language} voice available`;
  },

  retriable(err) {
    if (err instanceof ProviderHttpError) return err.isRetriable;
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    // Empty input fails identically everywhere.
    return !message.includes('is empty');
  },

  probeAvailability: (specializer) => specializer.capabilities.kind === 'self_hosted',
};
