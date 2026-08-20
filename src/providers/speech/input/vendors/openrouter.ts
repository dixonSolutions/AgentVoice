/**
 * OpenRouter speech-to-text — chat/completions with an `input_audio` part.
 *
 * OpenRouter has no `/audio/transcriptions` route, so this goes through the
 * audio-capable chat models it proxies. Worth having anyway: one key already in
 * many people's .env, and it is the only way to reach several of these models
 * without opening a separate account. Only the models listed here accept audio —
 * pointing this at a text-only model returns an error from upstream.
 */

import { scopeBool, scopeNumber, scopeString } from '../../../scopes.js';
import { cleanLlmTranscript } from '../../http.js';
import { languageLabel } from '../../languages.js';
import { pcm16ToWav } from '../../wav.js';
import { resolveVendorCall } from '../settings.js';
import { TRANSCRIPTION_PROMPT, isEmptyTranscript } from '../transcriptionPrompt.js';
import type { SpeechInputVendor } from '../types.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

function apiKey(): string {
  return process.env['OPENROUTER_API_KEY']?.trim() ?? '';
}

export const openrouterSpeechInput: SpeechInputVendor = {
  id: 'openrouter',
  displayName: 'OpenRouter',
  description:
    'Routes to audio-capable chat models with one key. Only the listed models accept audio.',
  capabilities: {
    kind: 'cloud',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    languages: 'all',
    languageHint: true,
    sendsAudioOffMachine: true,
    approxUsdPerAudioHour: 0.1,
    docsUrl: 'https://openrouter.ai/docs/features/multimodal/audio',
    apiKeyUrl: 'https://openrouter.ai/keys',
  },
  models: [
    {
      id: 'google/gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      note: 'Best latency/price of the audio-capable models on OpenRouter.',
      recommended: true,
    },
    {
      id: 'google/gemini-2.5-flash-lite',
      label: 'Gemini 2.5 Flash Lite',
      note: 'Cheaper and faster; slightly weaker on technical terms.',
    },
    {
      id: 'openai/gpt-4o-audio-preview',
      label: 'GPT-4o Audio',
      note: 'Strong accuracy; the priciest of the three.',
    },
  ],
  defaultModel: 'google/gemini-2.5-flash',
  scopes: [
    {
      id: 'providerOrder',
      label: 'Preferred upstreams',
      kind: 'text',
      default: '',
      placeholder: 'Google, OpenAI',
      help: 'Comma-separated upstream providers to try first. Leave empty to let OpenRouter choose.',
    },
    {
      id: 'allowFallbacks',
      label: 'Allow other upstreams',
      kind: 'toggle',
      default: true,
      help: 'When the preferred upstream is down, let OpenRouter route elsewhere rather than fail.',
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
    },
  ],
  isConfigured: () => apiKey().length > 0,
  unconfiguredDetail: 'OPENROUTER_API_KEY is not set',

  transport: 'http',
  converter: {
    id: 'openrouter',
    encode(req) {
      const call = resolveVendorCall(openrouterSpeechInput, req);
      const order = scopeString(call.scopes, 'providerOrder')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const prompt = call.language
        ? `${TRANSCRIPTION_PROMPT} The speaker is using ${languageLabel(call.language)}.`
        : TRANSCRIPTION_PROMPT;

      return {
        url: ENDPOINT,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          'Content-Type': 'application/json',
          // OpenRouter attributes usage with these; harmless if the app is unlisted.
          'HTTP-Referer': 'https://github.com/dixonSolutions/AgentVoice',
          'X-Title': 'AgentVoice',
        },
        body: JSON.stringify({
          model: call.model,
          temperature: scopeNumber(call.scopes, 'temperature', 0),
          ...(order.length
            ? { provider: { order, allow_fallbacks: scopeBool(call.scopes, 'allowFallbacks', true) } }
            : {}),
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'input_audio',
                  input_audio: { data: pcm16ToWav(req.pcm).toString('base64'), format: 'wav' },
                },
              ],
            },
          ],
        }),
        ...(call.signal ? { signal: call.signal } : {}),
      };
    },
    async decode(res, req) {
      const body = (await res.json()) as OpenRouterResponse;
      if (body.error?.message) throw new Error(body.error.message);
      const text = cleanLlmTranscript(body.choices?.[0]?.message?.content ?? '');
      return {
        text: isEmptyTranscript(text) ? '' : text,
        model: resolveVendorCall(openrouterSpeechInput, req).model,
      };
    },
  },
};
