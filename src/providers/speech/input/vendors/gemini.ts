/**
 * Google Gemini speech-to-text — generateContent with inline audio.
 *
 * Gemini has no dedicated transcription endpoint; the multimodal models take
 * audio directly. Flash is fast enough for voice turns, has the most generous
 * free tier of anything here, and its context makes it unusually good at
 * getting library and identifier names right.
 */

import { scopeNumber, scopeString } from '../../../scopes.js';
import { cleanLlmTranscript } from '../../http.js';
import { languageLabel } from '../../languages.js';
import { pcm16ToWav } from '../../wav.js';
import { resolveVendorCall } from '../settings.js';
import { TRANSCRIPTION_PROMPT, isEmptyTranscript } from '../transcriptionPrompt.js';
import type { SpeechInputVendor } from '../types.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  promptFeedback?: { blockReason?: string };
}

function apiKey(): string {
  return process.env['GEMINI_API_KEY']?.trim() ?? '';
}

export const geminiSpeechInput: SpeechInputVendor = {
  id: 'gemini',
  displayName: 'Google Gemini',
  description: 'Gemini Flash transcribes audio directly. Cheapest hosted option, generous free tier.',
  capabilities: {
    kind: 'cloud',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    sharedWith: 'Gemini text-to-speech',
    languages: 'all',
    languageHint: true,
    sendsAudioOffMachine: true,
    approxUsdPerAudioHour: 0.06,
    docsUrl: 'https://ai.google.dev/gemini-api/docs/audio',
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
  },
  models: [
    {
      id: 'gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      note: 'Fast, cheap, generous free tier — the default.',
      recommended: true,
    },
    {
      id: 'gemini-2.5-flash-lite',
      label: 'Gemini 2.5 Flash Lite',
      note: 'Lowest latency and cost; slightly weaker on jargon.',
    },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', note: 'Most accurate, noticeably slower.' },
  ],
  defaultModel: 'gemini-2.5-flash',
  scopes: [
    {
      id: 'prompt',
      label: 'Extra instruction',
      kind: 'text',
      default: '',
      placeholder: 'Expect TypeScript and AWS terminology.',
      help: 'Appended to the verbatim-transcription instruction. Useful for domain vocabulary.',
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
      help: 'Keep at 0 — this is transcription, not generation.',
    },
  ],
  isConfigured: () => apiKey().length > 0,
  unconfiguredDetail: 'GEMINI_API_KEY is not set',

  transport: 'http',
  converter: {
    id: 'gemini',
    encode(req) {
      const call = resolveVendorCall(geminiSpeechInput, req);
      const extra = scopeString(call.scopes, 'prompt').trim();
      const prompt = [
        TRANSCRIPTION_PROMPT,
        call.language ? `The speaker is using ${languageLabel(call.language)}.` : '',
        extra,
      ]
        .filter(Boolean)
        .join(' ');

      return {
        url: `${BASE_URL}/${encodeURIComponent(call.model)}:generateContent`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey() },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { text: prompt },
                { inline_data: { mime_type: 'audio/wav', data: pcm16ToWav(req.pcm).toString('base64') } },
              ],
            },
          ],
          generationConfig: {
            temperature: scopeNumber(call.scopes, 'temperature', 0),
            candidateCount: 1,
          },
        }),
        ...(call.signal ? { signal: call.signal } : {}),
      };
    },
    async decode(res, req) {
      const body = (await res.json()) as GeminiResponse;
      if (body.promptFeedback?.blockReason) {
        throw new Error(`Gemini blocked the audio (${body.promptFeedback.blockReason})`);
      }
      const text = cleanLlmTranscript(
        (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(' '),
      );
      return {
        text: isEmptyTranscript(text) ? '' : text,
        model: resolveVendorCall(geminiSpeechInput, req).model,
      };
    },
  },
};
