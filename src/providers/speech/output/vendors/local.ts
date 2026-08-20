/**
 * Self-hosted text-to-speech — the speech server's `/audio/speech` route.
 *
 * The same container that serves `local_whisper` (see ../../server.ts). Kokoro
 * is an 82M-parameter model: small enough to run in real time on a CPU, which
 * is what makes fully local voice practical rather than a demo.
 */

import { scopeNumber, scopeString } from '../../../scopes.js';
import {
  isSpeechServerConfigured,
  probeSpeechServer,
  speechServerApiBase,
  speechServerSettings,
  speechServerUnavailableDetail,
} from '../../server.js';
import { resolveVendorCall } from '../settings.js';
import type { SpeechOutputVendor, SpeechVoiceOption } from '../types.js';

const MAX_CHARS = 4000;
/** First call after a model change may still be pulling weights. */
const FIRST_RUN_TIMEOUT_MS = 300_000;

/** Kokoro voice ids encode language and gender: `af_` = American female, etc. */
const VOICES: SpeechVoiceOption[] = [
  { id: 'af_heart', label: 'Heart (American female)', gender: 'female', languages: ['en'] },
  { id: 'af_bella', label: 'Bella (American female)', gender: 'female', languages: ['en'] },
  { id: 'am_michael', label: 'Michael (American male)', gender: 'male', languages: ['en'] },
  { id: 'am_fenrir', label: 'Fenrir (American male)', gender: 'male', languages: ['en'] },
  { id: 'bf_emma', label: 'Emma (British female)', gender: 'female', languages: ['en'] },
  { id: 'bm_george', label: 'George (British male)', gender: 'male', languages: ['en'] },
  { id: 'ef_dora', label: 'Dora (Spanish female)', gender: 'female', languages: ['es'] },
  { id: 'ff_siwis', label: 'Siwis (French female)', gender: 'female', languages: ['fr'] },
  { id: 'if_sara', label: 'Sara (Italian female)', gender: 'female', languages: ['it'] },
  { id: 'jf_alpha', label: 'Alpha (Japanese female)', gender: 'female', languages: ['ja'] },
  { id: 'pf_dora', label: 'Dora (Portuguese female)', gender: 'female', languages: ['pt'] },
  { id: 'zf_xiaobei', label: 'Xiaobei (Chinese female)', gender: 'female', languages: ['zh'] },
];

export const localSpeechOutput: SpeechOutputVendor = {
  id: 'local_speech',
  displayName: 'Self-hosted voice',
  description:
    'Kokoro or Piper on this machine, in the same container as self-hosted Whisper. No key, no cost, nothing leaves the host.',
  capabilities: {
    kind: 'self_hosted',
    apiKeyEnvVar: null,
    languages: ['en', 'es', 'fr', 'hi', 'it', 'ja', 'pt', 'zh'],
    sendsTextOffMachine: false,
    approxUsdPerMillionChars: null,
    docsUrl: 'https://speaches.ai/',
  },
  models: [
    {
      id: 'speaches-ai/Kokoro-82M-v1.0-ONNX',
      label: 'Kokoro 82M (~350 MB)',
      note: 'Real time on a CPU, and good enough to listen to all day. The default.',
      recommended: true,
      languages: ['en', 'es', 'fr', 'hi', 'it', 'ja', 'pt', 'zh'],
    },
    {
      id: 'speaches-ai/piper-en_US-ryan-high',
      label: 'Piper en-US Ryan (~110 MB)',
      note: 'Tiny and instant, but plainly synthetic. English only.',
      languages: ['en'],
    },
  ],
  defaultModel: 'speaches-ai/Kokoro-82M-v1.0-ONNX',
  scopes: [
    { id: 'speed', label: 'Speed', kind: 'number', default: 1, min: 0.5, max: 2, step: 0.05 },
    {
      id: 'response_format',
      label: 'Audio format',
      kind: 'select',
      default: 'mp3',
      advanced: true,
      choices: [
        { value: 'mp3', label: 'MP3', note: 'Smallest over a phone connection.' },
        { value: 'wav', label: 'WAV', note: 'No encode step on the server.' },
      ],
    },
  ],
  voices: (model?: string) =>
    model?.includes('piper') ? VOICES.filter((v) => v.languages?.includes('en')) : VOICES,
  defaultVoice: () => 'af_heart',

  isConfigured: () => isSpeechServerConfigured(),

  async checkAvailability() {
    const settings = speechServerSettings();
    if (settings.manage === 'external' && !settings.baseUrl?.trim()) {
      return { available: false, detail: 'Set the server URL for the external speech server' };
    }
    const probe = await probeSpeechServer(settings);
    return probe.reachable
      ? { available: true }
      : { available: false, detail: speechServerUnavailableDetail(settings) };
  },

  transport: 'http',
  converter: {
    id: 'local_speech',
    encode(req) {
      const call = resolveVendorCall(localSpeechOutput, req);
      const format = scopeString(call.scopes, 'response_format', 'mp3') === 'wav' ? 'wav' : 'mp3';

      return {
        url: `${speechServerApiBase()}/audio/speech`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: call.model,
          input: req.text.slice(0, MAX_CHARS),
          voice: call.voice,
          response_format: format,
          speed: scopeNumber(call.scopes, 'speed', 1),
        }),
        timeoutMs: FIRST_RUN_TIMEOUT_MS,
        ...(call.signal ? { signal: call.signal } : {}),
      };
    },
    async decode(res, req) {
      const call = resolveVendorCall(localSpeechOutput, req);
      const format = scopeString(call.scopes, 'response_format', 'mp3');
      return {
        audio: Buffer.from(await res.arrayBuffer()),
        contentType: format === 'wav' ? 'audio/wav' : 'audio/mpeg',
        model: call.model,
        voice: call.voice,
      };
    },
  },
};
