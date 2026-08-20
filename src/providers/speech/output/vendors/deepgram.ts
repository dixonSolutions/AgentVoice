/**
 * Deepgram text-to-speech — /v1/speak (Aura).
 *
 * The lowest time-to-first-byte of the hosted options, which is what you feel
 * on a short spoken reply. Aura's voice range is English-first, so the
 * orchestrator routes other languages past it rather than mispronouncing them.
 */

import { scopeString } from '../../../scopes.js';
import { resolveVendorCall } from '../settings.js';
import type { SpeechOutputVendor, SpeechVoiceOption } from '../types.js';

const ENDPOINT = 'https://api.deepgram.com/v1/speak';
const MAX_CHARS = 2000;

const VOICES: SpeechVoiceOption[] = [
  { id: 'thalia', label: 'Thalia', gender: 'female', note: 'Clear and brisk.', languages: ['en'] },
  { id: 'andromeda', label: 'Andromeda', gender: 'female', languages: ['en'] },
  { id: 'helena', label: 'Helena', gender: 'female', languages: ['en'] },
  { id: 'apollo', label: 'Apollo', gender: 'male', note: 'Low, unhurried.', languages: ['en'] },
  { id: 'arcas', label: 'Arcas', gender: 'male', languages: ['en'] },
  { id: 'orion', label: 'Orion', gender: 'male', languages: ['en'] },
  { id: 'celeste', label: 'Celeste', gender: 'female', note: 'Spanish.', languages: ['es'] },
];

function apiKey(): string {
  return process.env['DEEPGRAM_API_KEY']?.trim() ?? '';
}

/**
 * Aura ids are `<generation>-<voice>-<lang>`, where the suffix is the voice's
 * own language rather than the requested one — so read it off the catalog.
 */
function voiceModelId(model: string, voice: string, language: string | undefined): string {
  const known = VOICES.find((v) => v.id === voice);
  const suffix =
    Array.isArray(known?.languages) && known.languages[0] ? known.languages[0] : (language ?? 'en');
  return `${model}-${voice}-${suffix}`;
}

export const deepgramSpeechOutput: SpeechOutputVendor = {
  id: 'deepgram',
  displayName: 'Deepgram',
  description: 'Aura-2 — the fastest first syllable of any hosted voice. English-first.',
  capabilities: {
    kind: 'cloud',
    apiKeyEnvVar: 'DEEPGRAM_API_KEY',
    sharedWith: 'Deepgram speech-to-text',
    languages: ['en', 'es'],
    sendsTextOffMachine: true,
    approxUsdPerMillionChars: 30,
    docsUrl: 'https://developers.deepgram.com/docs/text-to-speech',
    apiKeyUrl: 'https://console.deepgram.com/',
  },
  /** Deepgram folds voice and model into one id, so the model list is the generation. */
  models: [
    { id: 'aura-2', label: 'Aura-2', note: 'Current generation — the default.', recommended: true },
    { id: 'aura', label: 'Aura', note: 'Previous generation; fewer voices.' },
  ],
  defaultModel: 'aura-2',
  scopes: [
    {
      id: 'encoding',
      label: 'Audio format',
      kind: 'select',
      default: 'mp3',
      advanced: true,
      choices: [
        { value: 'mp3', label: 'MP3', note: 'Smallest over a phone connection.' },
        { value: 'linear16', label: 'WAV (linear16)', note: 'Uncompressed; larger but no decode step.' },
      ],
    },
  ],
  voices: () => VOICES,
  defaultVoice: () => 'thalia',
  isConfigured: () => apiKey().length > 0,
  unconfiguredDetail: 'DEEPGRAM_API_KEY is not set',

  transport: 'http',
  converter: {
    id: 'deepgram',
    encode(req) {
      const call = resolveVendorCall(deepgramSpeechOutput, req);
      const encoding = scopeString(call.scopes, 'encoding', 'mp3') === 'linear16' ? 'linear16' : 'mp3';
      const params = new URLSearchParams({
        model: voiceModelId(call.model, call.voice, call.language),
        encoding,
      });
      if (encoding === 'linear16') params.set('sample_rate', '24000');

      return {
        url: `${ENDPOINT}?${params.toString()}`,
        method: 'POST',
        headers: { Authorization: `Token ${apiKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: req.text.slice(0, MAX_CHARS) }),
        ...(call.signal ? { signal: call.signal } : {}),
      };
    },
    async decode(res, req) {
      const call = resolveVendorCall(deepgramSpeechOutput, req);
      const encoding = scopeString(call.scopes, 'encoding', 'mp3');
      return {
        audio: Buffer.from(await res.arrayBuffer()),
        contentType: encoding === 'linear16' ? 'audio/wav' : 'audio/mpeg',
        model: call.model,
        voice: call.voice,
      };
    },
  },
};
