/**
 * Speech-input orchestrator — the policy half.
 *
 * It knows the chain order, which vendors can handle which languages, and
 * which failures are worth retrying elsewhere. It knows nothing about HTTP,
 * AWS, or any vendor's field names — that is the converters' job.
 *
 * `browser` is a legal chain entry with no specializer: the PWA implements it.
 * `resolve` returning null makes the orchestrator step over it silently, which
 * is exactly right — "browser first, Groq as backup" is then just an ordinary
 * chain rather than a special case.
 */

import type { SpeechInputProviderId } from '../../../config.js';
import { ProviderHttpError, createHttpSpecializer } from '../../../orchestration/http.js';
import type { OrchestrationPolicy, Specializer } from '../../../orchestration/types.js';
import { supportsLanguage, baseLanguage, type LanguageSupport } from '../languages.js';
import { speechInputSettings } from './settings.js';
import { amazonSpeechInput } from './vendors/amazon.js';
import { deepgramSpeechInput } from './vendors/deepgram.js';
import { elevenlabsSpeechInput } from './vendors/elevenlabs.js';
import { geminiSpeechInput } from './vendors/gemini.js';
import { groqSpeechInput } from './vendors/groq.js';
import { localSpeechInput } from './vendors/local.js';
import { openaiSpeechInput } from './vendors/openai.js';
import { openrouterSpeechInput } from './vendors/openrouter.js';
import type {
  SpeechInputCapabilities,
  SpeechInputRequest,
  SpeechInputResult,
  SpeechInputSpecializer,
  SpeechInputVendor,
} from './types.js';

type ServerId = Exclude<SpeechInputProviderId, 'browser'>;

const VENDORS: Record<ServerId, SpeechInputVendor> = {
  local_whisper: localSpeechInput,
  groq: groqSpeechInput,
  openai: openaiSpeechInput,
  deepgram: deepgramSpeechInput,
  gemini: geminiSpeechInput,
  elevenlabs: elevenlabsSpeechInput,
  openrouter: openrouterSpeechInput,
  amazon_transcribe: amazonSpeechInput,
};

/** Wrap a vendor in the Specializer contract the orchestrator consumes. */
function toSpecializer(vendor: SpeechInputVendor): SpeechInputSpecializer {
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
    return createHttpSpecializer<SpeechInputRequest, SpeechInputResult, SpeechInputCapabilities>({
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

const SPECIALIZERS: Record<ServerId, SpeechInputSpecializer> = Object.fromEntries(
  Object.entries(VENDORS).map(([id, vendor]) => [id, toSpecializer(vendor)]),
) as Record<ServerId, SpeechInputSpecializer>;

/** Picker order: local and cheap first, Amazon last (it is the legacy default). */
export const SPEECH_INPUT_PICKER_ORDER: readonly SpeechInputProviderId[] = [
  'browser',
  'local_whisper',
  'groq',
  'openai',
  'deepgram',
  'gemini',
  'elevenlabs',
  'openrouter',
  'amazon_transcribe',
];

export function isServerSpeechInput(id: SpeechInputProviderId): id is ServerId {
  return id !== 'browser' && id in VENDORS;
}

export function getSpeechInputVendor(id: SpeechInputProviderId): SpeechInputVendor | null {
  return isServerSpeechInput(id) ? VENDORS[id] : null;
}

export function getSpeechInputSpecializer(id: SpeechInputProviderId): SpeechInputSpecializer | null {
  return isServerSpeechInput(id) ? SPECIALIZERS[id] : null;
}

export function listSpeechInputVendors(): SpeechInputVendor[] {
  return SPEECH_INPUT_PICKER_ORDER.filter(isServerSpeechInput).map((id) => VENDORS[id]);
}

/** `provider` then `fallbacks`, deduped, `browser` kept so the UI can show it. */
export function speechInputChain(settings = speechInputSettings()): SpeechInputProviderId[] {
  const seen = new Set<SpeechInputProviderId>();
  const out: SpeechInputProviderId[] = [];
  for (const id of [settings.provider, ...settings.fallbacks]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Languages a vendor can handle for a model (the model narrows the vendor). */
export function speechInputLanguages(
  id: SpeechInputProviderId,
  model?: string,
): LanguageSupport {
  const vendor = getSpeechInputVendor(id);
  if (!vendor) return 'all';
  return vendor.models.find((m) => m.id === model)?.languages ?? vendor.capabilities.languages;
}

export const speechInputPolicy: OrchestrationPolicy<
  SpeechInputRequest,
  SpeechInputResult,
  SpeechInputCapabilities
> = {
  chain: () => speechInputChain(),

  resolve: (id) => getSpeechInputSpecializer(id as SpeechInputProviderId),

  accepts(specializer: Specializer<SpeechInputRequest, SpeechInputResult, SpeechInputCapabilities>, req) {
    const settings = speechInputSettings();
    const model = req.modelOverride?.trim() || settings.models[specializer.id]?.trim();
    const supported = speechInputLanguages(specializer.id as SpeechInputProviderId, model);
    if (supportsLanguage(supported, req.language)) return true;
    return `does not support ${baseLanguage(req.language)}`;
  },

  retriable(err) {
    if (err instanceof ProviderHttpError) return err.isRetriable;
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    // "Audio too short" fails identically everywhere; retrying multiplies the wait.
    return !message.includes('too short');
  },

  // Only the self-hosted server can be configured-but-down; probing an API key
  // would add a round trip to every turn for no information.
  probeAvailability: (specializer) => specializer.capabilities.kind === 'self_hosted',
};
