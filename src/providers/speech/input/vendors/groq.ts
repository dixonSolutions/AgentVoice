/**
 * Groq speech-to-text — OpenAI-compatible /openai/v1/audio/transcriptions.
 *
 * Whisper large-v3 on Groq's LPUs transcribes a 10-second turn in well under a
 * second, which is the single biggest latency win available here, and costs
 * roughly a tenth of the hosted alternatives.
 */

import { scopeNumber, scopeString } from '../../../scopes.js';
import { decodeOpenAiTranscription, openAiTranscriptionCall } from '../../http.js';
import { pcm16ToWav } from '../../wav.js';
import { resolveVendorCall } from '../settings.js';
import type { SpeechInputVendor } from '../types.js';

const BASE_URL = 'https://api.groq.com/openai/v1';

function apiKey(): string {
  return process.env['GROQ_API_KEY']?.trim() ?? '';
}

export const groqSpeechInput: SpeechInputVendor = {
  id: 'groq',
  displayName: 'Groq',
  description: 'Whisper large-v3 on Groq LPUs — the fastest hosted option, and very cheap.',
  capabilities: {
    kind: 'cloud',
    apiKeyEnvVar: 'GROQ_API_KEY',
    languages: 'whisper',
    languageHint: true,
    sendsAudioOffMachine: true,
    approxUsdPerAudioHour: 0.04,
    docsUrl: 'https://console.groq.com/docs/speech-to-text',
    apiKeyUrl: 'https://console.groq.com/keys',
  },
  models: [
    {
      id: 'whisper-large-v3-turbo',
      label: 'whisper-large-v3-turbo',
      note: 'Fastest multilingual option — the default for voice turns.',
      recommended: true,
    },
    {
      id: 'whisper-large-v3',
      label: 'whisper-large-v3',
      note: 'Highest accuracy, still faster than most hosted APIs.',
    },
    {
      id: 'distil-whisper-large-v3-en',
      label: 'distil-whisper-large-v3-en',
      note: 'The cheapest and fastest of the three, but English only.',
      languages: ['en'],
    },
  ],
  defaultModel: 'whisper-large-v3-turbo',
  scopes: [
    {
      id: 'prompt',
      label: 'Vocabulary hint',
      kind: 'text',
      default: '',
      placeholder: 'Kubernetes, tsconfig, pnpm, Fastify',
      help: 'Names and jargon to bias the transcript toward.',
    },
    {
      id: 'temperature',
      label: 'Temperature',
      kind: 'number',
      default: 0,
      min: 0,
      max: 1,
      step: 0.1,
      advanced: true,
      help: 'Leave at 0 for transcription.',
    },
  ],
  isConfigured: () => apiKey().length > 0,
  unconfiguredDetail: 'GROQ_API_KEY is not set',

  transport: 'http',
  converter: {
    id: 'groq',
    encode(req) {
      const call = resolveVendorCall(groqSpeechInput, req);
      const prompt = scopeString(call.scopes, 'prompt').trim();
      const temperature = scopeNumber(call.scopes, 'temperature', 0);
      // The distil model is English-only and 400s on any other language hint.
      const language = call.model.endsWith('-en') ? 'en' : call.language;

      return openAiTranscriptionCall({
        baseUrl: BASE_URL,
        apiKey: apiKey(),
        model: call.model,
        wav: pcm16ToWav(req.pcm),
        ...(language ? { language } : {}),
        extraFields: {
          ...(prompt ? { prompt } : {}),
          ...(temperature > 0 ? { temperature: String(temperature) } : {}),
        },
        ...(call.signal ? { signal: call.signal } : {}),
      });
    },
    async decode(res, req) {
      return {
        text: await decodeOpenAiTranscription(res),
        model: resolveVendorCall(groqSpeechInput, req).model,
      };
    },
  },
};
