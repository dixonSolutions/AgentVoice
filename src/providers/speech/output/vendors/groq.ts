/**
 * Groq text-to-speech — PlayAI on Groq's LPUs, OpenAI-compatible
 * /openai/v1/audio/speech.
 *
 * Same speed story as Groq's transcription side. The catch is coverage: the
 * PlayAI models are English or Arabic, one model per language, so the
 * orchestrator routes anything else past this vendor.
 */

import { scopeString } from '../../../scopes.js';
import { baseLanguage } from '../../languages.js';
import { resolveVendorCall } from '../settings.js';
import type { SpeechOutputVendor, SpeechVoiceOption } from '../types.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/speech';
const MAX_CHARS = 4000;

const VOICES: SpeechVoiceOption[] = [
  { id: 'Fritz-PlayAI', label: 'Fritz', gender: 'male', languages: ['en'] },
  { id: 'Arista-PlayAI', label: 'Arista', gender: 'female', languages: ['en'] },
  { id: 'Atlas-PlayAI', label: 'Atlas', gender: 'male', languages: ['en'] },
  { id: 'Basil-PlayAI', label: 'Basil', gender: 'male', languages: ['en'] },
  { id: 'Celeste-PlayAI', label: 'Celeste', gender: 'female', languages: ['en'] },
  { id: 'Gail-PlayAI', label: 'Gail', gender: 'female', languages: ['en'] },
  { id: 'Quinn-PlayAI', label: 'Quinn', gender: 'neutral', languages: ['en'] },
  { id: 'Ahmad-PlayAI', label: 'Ahmad', gender: 'male', languages: ['ar'] },
  { id: 'Amira-PlayAI', label: 'Amira', gender: 'female', languages: ['ar'] },
];

function apiKey(): string {
  return process.env['GROQ_API_KEY']?.trim() ?? '';
}

function isArabicModel(model: string): boolean {
  return model.endsWith('-arabic');
}

export const groqSpeechOutput: SpeechOutputVendor = {
  id: 'groq',
  displayName: 'Groq',
  description: 'PlayAI voices on Groq LPUs — very fast and very cheap. English or Arabic.',
  capabilities: {
    kind: 'cloud',
    apiKeyEnvVar: 'GROQ_API_KEY',
    sharedWith: 'Groq speech-to-text',
    languages: ['en', 'ar'],
    sendsTextOffMachine: true,
    approxUsdPerMillionChars: 50,
    docsUrl: 'https://console.groq.com/docs/text-to-speech',
    apiKeyUrl: 'https://console.groq.com/keys',
  },
  models: [
    {
      id: 'playai-tts',
      label: 'PlayAI TTS (English)',
      note: 'Fast and natural. English only.',
      recommended: true,
      languages: ['en'],
    },
    {
      id: 'playai-tts-arabic',
      label: 'PlayAI TTS (Arabic)',
      note: 'Arabic only — pick an Arabic voice with it.',
      languages: ['ar'],
    },
  ],
  defaultModel: 'playai-tts',
  scopes: [
    {
      id: 'response_format',
      label: 'Audio format',
      kind: 'select',
      default: 'wav',
      advanced: true,
      choices: [
        { value: 'wav', label: 'WAV', note: 'What PlayAI returns natively — no transcode.' },
        { value: 'mp3', label: 'MP3', note: 'Smaller over a phone connection.' },
      ],
    },
  ],
  voices: (model?: string) =>
    VOICES.filter((v) => v.languages?.includes(isArabicModel(model ?? '') ? 'ar' : 'en')),
  defaultVoice: (model?: string) => (isArabicModel(model ?? '') ? 'Amira-PlayAI' : 'Fritz-PlayAI'),
  isConfigured: () => apiKey().length > 0,
  unconfiguredDetail: 'GROQ_API_KEY is not set',

  transport: 'http',
  converter: {
    id: 'groq',
    encode(req) {
      const call = resolveVendorCall(groqSpeechOutput, req);
      // One model per language — switch to the Arabic one when that is asked for.
      const model =
        req.modelOverride?.trim() ??
        (baseLanguage(call.language) === 'ar' ? 'playai-tts-arabic' : call.model);
      const format = scopeString(call.scopes, 'response_format', 'wav') === 'mp3' ? 'mp3' : 'wav';

      return {
        url: ENDPOINT,
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          input: req.text.slice(0, MAX_CHARS),
          voice: call.voice,
          response_format: format,
        }),
        ...(call.signal ? { signal: call.signal } : {}),
      };
    },
    async decode(res, req) {
      const call = resolveVendorCall(groqSpeechOutput, req);
      const format = scopeString(call.scopes, 'response_format', 'wav');
      return {
        audio: Buffer.from(await res.arrayBuffer()),
        contentType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
        model: call.model,
        voice: call.voice,
      };
    },
  },
};
