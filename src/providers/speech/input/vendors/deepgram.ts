/**
 * Deepgram speech-to-text — /v1/listen (pre-recorded).
 *
 * The default engine behind a lot of production voice agents: sub-second on
 * short clips, cheap, and `smart_format` gives punctuation and numerals without
 * a second pass, which matters when the transcript becomes a coding prompt.
 */

import { scopeBool, scopeString } from '../../../scopes.js';
import { baseLanguage } from '../../languages.js';
import { pcm16ToWav } from '../../wav.js';
import { resolveVendorCall } from '../settings.js';
import type { SpeechInputVendor } from '../types.js';

const BASE_URL = 'https://api.deepgram.com/v1/listen';

/**
 * Nova-3's multilingual set. Single-language mode covers more, but this is what
 * `language=multi` and the general models reliably handle.
 */
const DEEPGRAM_LANGUAGES = [
  'bg', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hi', 'hu', 'id', 'it',
  'ja', 'ko', 'lv', 'lt', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sv', 'ta', 'th',
  'tr', 'uk', 'vi', 'zh',
];

interface DeepgramResponse {
  results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
}

function apiKey(): string {
  return process.env['DEEPGRAM_API_KEY']?.trim() ?? '';
}

export const deepgramSpeechInput: SpeechInputVendor = {
  id: 'deepgram',
  displayName: 'Deepgram',
  description: 'Nova-3 — sub-second latency with smart formatting. The voice-agent workhorse.',
  capabilities: {
    kind: 'cloud',
    apiKeyEnvVar: 'DEEPGRAM_API_KEY',
    languages: DEEPGRAM_LANGUAGES,
    languageHint: true,
    sendsAudioOffMachine: true,
    approxUsdPerAudioHour: 0.26,
    docsUrl: 'https://developers.deepgram.com/docs/pre-recorded-audio',
    apiKeyUrl: 'https://console.deepgram.com/',
  },
  models: [
    {
      id: 'nova-3',
      label: 'Nova-3',
      note: 'Latest general model — best accuracy on technical vocabulary.',
      recommended: true,
    },
    { id: 'nova-2', label: 'Nova-2', note: 'Previous generation; broader language coverage.' },
    { id: 'base', label: 'Base', note: 'Cheapest tier — noticeably weaker on jargon.' },
  ],
  defaultModel: 'nova-3',
  scopes: [
    {
      id: 'smart_format',
      label: 'Smart formatting',
      kind: 'toggle',
      default: true,
      help: 'Punctuation, casing, dates and numerals in one pass. Leave on for coding prompts.',
    },
    { id: 'punctuate', label: 'Punctuation', kind: 'toggle', default: true, advanced: true },
    {
      id: 'numerals',
      label: 'Numerals',
      kind: 'toggle',
      default: false,
      advanced: true,
      help: 'Write numbers as digits ("port 8080") rather than words.',
    },
    {
      id: 'keyterm',
      label: 'Key terms',
      kind: 'text',
      default: '',
      placeholder: 'Fastify, Zod, tsup',
      help: 'Comma-separated terms to boost. Nova-3 only.',
    },
    {
      id: 'profanity_filter',
      label: 'Profanity filter',
      kind: 'toggle',
      default: false,
      advanced: true,
    },
  ],
  isConfigured: () => apiKey().length > 0,
  unconfiguredDetail: 'DEEPGRAM_API_KEY is not set',

  transport: 'http',
  converter: {
    id: 'deepgram',
    encode(req) {
      const call = resolveVendorCall(deepgramSpeechInput, req);
      const params = new URLSearchParams({ model: call.model });

      params.set('smart_format', String(scopeBool(call.scopes, 'smart_format', true)));
      params.set('punctuate', String(scopeBool(call.scopes, 'punctuate', true)));
      if (scopeBool(call.scopes, 'numerals')) params.set('numerals', 'true');
      if (scopeBool(call.scopes, 'profanity_filter')) params.set('profanity_filter', 'true');

      // Deepgram takes repeated keyterm params, not a comma-joined string.
      if (call.model.startsWith('nova-3')) {
        for (const term of scopeString(call.scopes, 'keyterm').split(',')) {
          const clean = term.trim();
          if (clean) params.append('keyterm', clean);
        }
      }

      // Deepgram wants a locale or the literal "multi"; a bare "en" is fine too.
      params.set('language', baseLanguage(call.language) ?? 'multi');

      return {
        url: `${BASE_URL}?${params.toString()}`,
        method: 'POST',
        headers: { Authorization: `Token ${apiKey()}`, 'Content-Type': 'audio/wav' },
        body: new Uint8Array(pcm16ToWav(req.pcm)),
        ...(call.signal ? { signal: call.signal } : {}),
      };
    },
    async decode(res, req) {
      const body = (await res.json()) as DeepgramResponse;
      return {
        text: (body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim(),
        model: resolveVendorCall(deepgramSpeechInput, req).model,
      };
    },
  },
};
