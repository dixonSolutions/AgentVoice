/**
 * Google Gemini text-to-speech — generateContent with an AUDIO response
 * modality.
 *
 * Gemini has no /audio/speech route; the TTS models return raw 24 kHz PCM
 * inside a generateContent response, so the decoder wraps the bytes in a WAV
 * header before they reach the phone. A streamed reply uses
 * streamGenerateContent (server-sent events) and passes each event's PCM on
 * as it lands — today the TTS models tend to send the clip in one event, which
 * plays no later than the whole-file path.
 */

import { scopeString } from '../../../scopes.js';
import { languageLabel } from '../../languages.js';
import { pcm16ToWav } from '../../wav.js';
import { bodyChunks, sseData } from '../pcmStream.js';
import { resolveVendorCall } from '../settings.js';
import type { PcmStream, SpeechOutputVendor, SpeechVoiceOption } from '../types.js';

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

/** The audio in one response (or one streamed event), or null if it carries none. */
function audioOf(body: GeminiTtsResponse): { pcm: Buffer; rate: number } | null {
  if (body.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the reply (${body.promptFeedback.blockReason})`);
  }
  const inline = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) return null;
  // `audio/L16;rate=24000` — headerless PCM that browsers cannot play directly.
  const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1]) || GEMINI_TTS_SAMPLE_RATE;
  return { pcm: Buffer.from(inline.data, 'base64'), rate };
}

/** streamGenerateContent events → PCM, the rate taken from the first audio event. */
async function geminiPcmStream(events: AsyncIterable<string>): Promise<PcmStream> {
  const it = events[Symbol.asyncIterator]();
  let first: { pcm: Buffer; rate: number } | null = null;
  try {
    while (!first) {
      const next = await it.next();
      if (next.done) throw new Error('Gemini returned no audio');
      first = audioOf(JSON.parse(next.value) as GeminiTtsResponse);
    }
  } catch (err) {
    await it.return?.();
    throw err;
  }
  const opening = first.pcm;
  async function* chunks(): AsyncGenerator<Buffer> {
    try {
      yield opening;
      for (;;) {
        const next = await it.next();
        if (next.done) return;
        const audio = audioOf(JSON.parse(next.value) as GeminiTtsResponse);
        if (audio?.pcm.length) yield audio.pcm;
      }
    } finally {
      await it.return?.();
    }
  }
  return { sampleRate: first.rate, chunks: chunks() };
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
    streaming: true,
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
        url: req.stream
          ? `${BASE_URL}/${encodeURIComponent(call.model)}:streamGenerateContent?alt=sse`
          : `${BASE_URL}/${encodeURIComponent(call.model)}:generateContent`,
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
      if (req.stream) {
        return {
          audio: Buffer.alloc(0),
          contentType: 'audio/pcm',
          model: call.model,
          voice: call.voice,
          pcm: await geminiPcmStream(sseData(bodyChunks(res, { signal: req.signal }))),
        };
      }

      const audio = audioOf((await res.json()) as GeminiTtsResponse);
      if (!audio) throw new Error('Gemini returned no audio');
      return {
        audio: pcm16ToWav(audio.pcm, audio.rate),
        contentType: 'audio/wav',
        model: call.model,
        voice: call.voice,
      };
    },
  },
};
