/**
 * Google Gemini text-to-speech — generateContent with an AUDIO response
 * modality.
 *
 * Gemini has no /audio/speech route; the TTS models return raw 24 kHz PCM
 * inside a generateContent response, so the decoder wraps the bytes in a WAV
 * header before they reach the phone.
 */

import { scopeString } from '../../../scopes.js';
import { languageLabel } from '../../languages.js';
import { pcm16ToWav } from '../../wav.js';
import { resolveVendorCall } from '../settings.js';
import type { SpeechOutputVendor, SpeechVoiceOption } from '../types.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_CHARS = 4000;
/** Gemini TTS returns L16 PCM at 24 kHz, not the 16 kHz the mic path uses. */
const GEMINI_TTS_SAMPLE_RATE = 24_000;

/** Prebuilt voices are language-agnostic — the model speaks what it is given. */
const VOICES: SpeechVoiceOption[] = [
  { id: 'Zephyr', label: 'Zephyr', note: 'Bright.' },
  { id: 'Puck', label: 'Puck', note: 'Upbeat.' },
  { id: 'Charon', label: 'Charon', note: 'Informative — a good default for status updates.' },
  { id: 'Kore', label: 'Kore', note: 'Firm.' },
  { id: 'Fenrir', label: 'Fenrir', note: 'Excitable.' },
  { id: 'Leda', label: 'Leda', note: 'Youthful.' },
  { id: 'Orus', label: 'Orus', note: 'Steady.' },
  { id: 'Aoede', label: 'Aoede', note: 'Breezy.' },
  { id: 'Callirrhoe', label: 'Callirrhoe', note: 'Easy-going.' },
  { id: 'Enceladus', label: 'Enceladus', note: 'Breathy.' },
];

interface GeminiTtsResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
  }>;
  promptFeedback?: { blockReason?: string };
}

function apiKey(): string {
  return process.env['GEMINI_API_KEY']?.trim() ?? '';
}

export const geminiSpeechOutput: SpeechOutputVendor = {
  id: 'gemini',
  displayName: 'Google Gemini',
  description: 'Prompt-steered voices across 24 languages, on the same key as Gemini transcription.',
  capabilities: {
    kind: 'cloud',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    sharedWith: 'Gemini speech-to-text',
    languages: [
      'ar', 'bn', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'mr', 'nl', 'pl',
      'pt', 'ro', 'ru', 'ta', 'te', 'th', 'tr', 'uk', 'vi',
    ],
    sendsTextOffMachine: true,
    approxUsdPerMillionChars: 10,
    docsUrl: 'https://ai.google.dev/gemini-api/docs/speech-generation',
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
  },
  models: [
    {
      id: 'gemini-2.5-flash-preview-tts',
      label: 'Gemini 2.5 Flash TTS',
      note: 'Fast and cheap, 24 languages. The default.',
      recommended: true,
    },
    {
      id: 'gemini-2.5-pro-preview-tts',
      label: 'Gemini 2.5 Pro TTS',
      note: 'Richer delivery, higher latency and price.',
    },
  ],
  defaultModel: 'gemini-2.5-flash-preview-tts',
  scopes: [
    {
      id: 'style',
      label: 'Delivery instruction',
      kind: 'text',
      default: 'Say the following clearly and at a measured pace:',
      placeholder: 'Read this calmly, like a colleague talking through a change:',
      help: 'Gemini TTS is prompt-steered — this sentence prefixes the reply and shapes the delivery.',
    },
  ],
  voices: () => VOICES,
  defaultVoice: () => 'Charon',
  isConfigured: () => apiKey().length > 0,
  unconfiguredDetail: 'GEMINI_API_KEY is not set',

  transport: 'http',
  converter: {
    id: 'gemini',
    encode(req) {
      const call = resolveVendorCall(geminiSpeechOutput, req);
      const style = scopeString(call.scopes, 'style').trim();
      const languageNote = call.language ? ` Speak in ${languageLabel(call.language)}.` : '';

      return {
        url: `${BASE_URL}/${encodeURIComponent(call.model)}:generateContent`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey() },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: `${style}${languageNote}\n\n${req.text.slice(0, MAX_CHARS)}` }] },
          ],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: call.voice } } },
          },
        }),
        ...(call.signal ? { signal: call.signal } : {}),
      };
    },
    async decode(res, req) {
      const call = resolveVendorCall(geminiSpeechOutput, req);
      const body = (await res.json()) as GeminiTtsResponse;
      if (body.promptFeedback?.blockReason) {
        throw new Error(`Gemini blocked the reply (${body.promptFeedback.blockReason})`);
      }

      const inline = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
      if (!inline?.data) throw new Error('Gemini returned no audio');

      // `audio/L16;rate=24000` — headerless PCM that browsers cannot play directly.
      const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1]) || GEMINI_TTS_SAMPLE_RATE;
      return {
        audio: pcm16ToWav(Buffer.from(inline.data, 'base64'), rate),
        contentType: 'audio/wav',
        model: call.model,
        voice: call.voice,
      };
    },
  },
};
