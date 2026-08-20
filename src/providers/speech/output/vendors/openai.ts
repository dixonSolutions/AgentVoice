/**
 * OpenAI text-to-speech — /v1/audio/speech.
 *
 * `gpt-4o-mini-tts` is the default because it takes an `instructions` prompt:
 * you can tell it to read code identifiers carefully or keep a calm pace, which
 * no other price tier here offers.
 */

import type { ProviderScope } from '../../../scopes.js';
import { scopeNumber, scopeString } from '../../../scopes.js';
import { resolveVendorCall } from '../settings.js';
import type { SpeechOutputVendor, SpeechVoiceOption } from '../types.js';

const ENDPOINT = 'https://api.openai.com/v1/audio/speech';
const MAX_CHARS = 4000;

/**
 * `instructions` is a 4o-only field — tts-1 rejects it, so it is declared on
 * the models that accept it rather than as a provider-wide scope.
 */
const INSTRUCTIONS_SCOPE: ProviderScope = {
  id: 'instructions',
  label: 'Delivery instruction',
  kind: 'text',
  default: 'Speak clearly and at a measured pace. Read code identifiers and file paths precisely.',
  placeholder: 'Calm, technical, unhurried.',
  help: 'Plain-English direction for how to read the reply.',
};

/** OpenAI voices are language-agnostic — the model speaks whatever it is given. */
const VOICES: SpeechVoiceOption[] = [
  { id: 'alloy', label: 'Alloy', note: 'Neutral, even-paced.' },
  { id: 'ash', label: 'Ash', note: 'Warm and conversational.' },
  { id: 'ballad', label: 'Ballad', note: 'Soft, unhurried.' },
  { id: 'coral', label: 'Coral', note: 'Bright and clear — good over speakerphone.' },
  { id: 'echo', label: 'Echo' },
  { id: 'fable', label: 'Fable' },
  { id: 'nova', label: 'Nova' },
  { id: 'onyx', label: 'Onyx', note: 'Low and steady.' },
  { id: 'sage', label: 'Sage' },
  { id: 'shimmer', label: 'Shimmer' },
  { id: 'verse', label: 'Verse' },
];

function apiKey(): string {
  return process.env['OPENAI_API_KEY']?.trim() ?? '';
}

export const openaiSpeechOutput: SpeechOutputVendor = {
  id: 'openai',
  displayName: 'OpenAI',
  description: 'Steerable voices — you can direct the delivery, not just pick one.',
  capabilities: {
    kind: 'cloud',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    sharedWith: 'the Codex agent client and OpenAI speech-to-text',
    languages: 'all',
    sendsTextOffMachine: true,
    approxUsdPerMillionChars: 12,
    docsUrl: 'https://platform.openai.com/docs/guides/text-to-speech',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  models: [
    {
      id: 'gpt-4o-mini-tts',
      label: 'gpt-4o-mini-tts',
      note: 'Steerable — you can direct the delivery. The best default.',
      recommended: true,
      scopes: [INSTRUCTIONS_SCOPE],
    },
    { id: 'tts-1', label: 'tts-1', note: 'Lowest latency, no steering.' },
    { id: 'tts-1-hd', label: 'tts-1-hd', note: 'Higher fidelity, slower.' },
  ],
  defaultModel: 'gpt-4o-mini-tts',
  scopes: [
    {
      id: 'speed',
      label: 'Speed',
      kind: 'number',
      default: 1,
      min: 0.25,
      max: 4,
      step: 0.05,
      help: 'Playback rate baked into the audio. 1 is the natural pace.',
    },
  ],
  voices: () => VOICES,
  defaultVoice: () => 'coral',
  isConfigured: () => apiKey().length > 0,
  unconfiguredDetail: 'OPENAI_API_KEY is not set',

  transport: 'http',
  converter: {
    id: 'openai',
    encode(req) {
      const call = resolveVendorCall(openaiSpeechOutput, req);
      const instructions = scopeString(call.scopes, 'instructions').trim();

      return {
        url: ENDPOINT,
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: call.model,
          input: req.text.slice(0, MAX_CHARS),
          voice: call.voice,
          response_format: 'mp3',
          speed: scopeNumber(call.scopes, 'speed', 1),
          // Only the 4o line accepts steering; tts-1 400s on an unknown field.
          ...(call.model.startsWith('gpt-4o') && instructions ? { instructions } : {}),
        }),
        ...(call.signal ? { signal: call.signal } : {}),
      };
    },
    async decode(res, req) {
      const call = resolveVendorCall(openaiSpeechOutput, req);
      return {
        audio: Buffer.from(await res.arrayBuffer()),
        contentType: 'audio/mpeg',
        model: call.model,
        voice: call.voice,
      };
    },
  },
};
