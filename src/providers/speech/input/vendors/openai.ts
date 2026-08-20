/**
 * OpenAI speech-to-text — /v1/audio/transcriptions.
 *
 * `gpt-4o-mini-transcribe` is the default: Whisper-class accuracy at a lower
 * price than `whisper-1`, and noticeably faster on the short turns this app
 * sends. Reuses OPENAI_API_KEY, which the Codex agent client may already have.
 */

import { scopeNumber, scopeString } from '../../../scopes.js';
import { decodeOpenAiTranscription, openAiTranscriptionCall } from '../../http.js';
import { pcm16ToWav } from '../../wav.js';
import { resolveVendorCall } from '../settings.js';
import type { SpeechInputVendor } from '../types.js';

const BASE_URL = 'https://api.openai.com/v1';

function apiKey(): string {
  return process.env['OPENAI_API_KEY']?.trim() ?? '';
}

export const openaiSpeechInput: SpeechInputVendor = {
  id: 'openai',
  displayName: 'OpenAI',
  description: 'Hosted Whisper / GPT-4o transcription. Accurate, 90+ languages, pay per minute.',
  capabilities: {
    kind: 'cloud',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    sharedWith: 'the Codex agent client',
    languages: 'whisper',
    languageHint: true,
    sendsAudioOffMachine: true,
    approxUsdPerAudioHour: 0.18,
    docsUrl: 'https://platform.openai.com/docs/guides/speech-to-text',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  models: [
    {
      id: 'gpt-4o-mini-transcribe',
      label: 'gpt-4o-mini-transcribe',
      note: 'Fast and cheap — the best default for short voice turns.',
      recommended: true,
    },
    { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe', note: 'Most accurate; ~2× the price.' },
    { id: 'whisper-1', label: 'whisper-1', note: 'Original Whisper large-v2 endpoint.' },
  ],
  defaultModel: 'gpt-4o-mini-transcribe',
  scopes: [
    {
      id: 'prompt',
      label: 'Vocabulary hint',
      kind: 'text',
      default: '',
      placeholder: 'Kubernetes, tsconfig, pnpm, Fastify',
      help: 'Names and jargon to bias the transcript toward. The single most effective fix for mangled library names.',
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
      help: 'Leave at 0 for transcription. Higher values only help when the audio is very unclear.',
    },
  ],
  isConfigured: () => apiKey().length > 0,
  unconfiguredDetail: 'OPENAI_API_KEY is not set',

  transport: 'http',
  converter: {
    id: 'openai',
    encode(req) {
      const call = resolveVendorCall(openaiSpeechInput, req);
      const prompt = scopeString(call.scopes, 'prompt').trim();
      const temperature = scopeNumber(call.scopes, 'temperature', 0);

      return openAiTranscriptionCall({
        baseUrl: BASE_URL,
        apiKey: apiKey(),
        model: call.model,
        wav: pcm16ToWav(req.pcm),
        ...(call.language ? { language: call.language } : {}),
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
        model: resolveVendorCall(openaiSpeechInput, req).model,
      };
    },
  },
};
