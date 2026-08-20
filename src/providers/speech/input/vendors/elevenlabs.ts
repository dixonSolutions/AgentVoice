/**
 * ElevenLabs speech-to-text — /v1/speech-to-text (Scribe).
 *
 * Scribe v1 leads most word-error-rate benchmarks and handles accents and
 * background noise better than Whisper, at the cost of being the slowest of the
 * hosted options here.
 */

import { scopeBool, scopeNumber } from '../../../scopes.js';
import { baseLanguage } from '../../languages.js';
import { pcm16ToWav } from '../../wav.js';
import { resolveVendorCall } from '../settings.js';
import type { SpeechInputVendor } from '../types.js';

const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';

function apiKey(): string {
  return process.env['ELEVENLABS_API_KEY']?.trim() ?? '';
}

export const elevenlabsSpeechInput: SpeechInputVendor = {
  id: 'elevenlabs',
  displayName: 'ElevenLabs',
  description: 'Scribe v1 — highest raw accuracy, strong on accents and noisy rooms.',
  capabilities: {
    kind: 'cloud',
    apiKeyEnvVar: 'ELEVENLABS_API_KEY',
    sharedWith: 'ElevenLabs text-to-speech',
    languages: 'all',
    languageHint: true,
    sendsAudioOffMachine: true,
    approxUsdPerAudioHour: 0.4,
    docsUrl: 'https://elevenlabs.io/docs/api-reference/speech-to-text',
    apiKeyUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
  models: [
    {
      id: 'scribe_v1',
      label: 'Scribe v1',
      note: 'Top-tier accuracy across 99 languages.',
      recommended: true,
    },
    {
      id: 'scribe_v1_experimental',
      label: 'Scribe v1 (experimental)',
      note: 'Newer weights; may change without notice.',
    },
  ],
  defaultModel: 'scribe_v1',
  scopes: [
    {
      id: 'tag_audio_events',
      label: 'Tag audio events',
      kind: 'toggle',
      default: false,
      help: 'Annotate laughter, applause and similar. Off for voice commands — the tags become prompt noise.',
    },
    {
      id: 'diarize',
      label: 'Separate speakers',
      kind: 'toggle',
      default: false,
      advanced: true,
      help: 'Label who said what. Useful only if more than one person shares the mic.',
    },
    {
      id: 'num_speakers',
      label: 'Number of speakers',
      kind: 'number',
      default: 2,
      min: 1,
      max: 32,
      step: 1,
      advanced: true,
      showWhen: { scope: 'diarize', equals: [true] },
    },
  ],
  isConfigured: () => apiKey().length > 0,
  unconfiguredDetail: 'ELEVENLABS_API_KEY is not set',

  transport: 'http',
  converter: {
    id: 'elevenlabs',
    encode(req) {
      const call = resolveVendorCall(elevenlabsSpeechInput, req);
      const diarize = scopeBool(call.scopes, 'diarize');

      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(pcm16ToWav(req.pcm))], { type: 'audio/wav' }), 'turn.wav');
      form.append('model_id', call.model);
      form.append('tag_audio_events', String(scopeBool(call.scopes, 'tag_audio_events')));
      form.append('diarize', String(diarize));
      if (diarize) form.append('num_speakers', String(scopeNumber(call.scopes, 'num_speakers', 2)));

      const language = baseLanguage(call.language);
      if (language) form.append('language_code', language);

      return {
        url: ENDPOINT,
        method: 'POST',
        headers: { 'xi-api-key': apiKey() },
        body: form,
        ...(call.signal ? { signal: call.signal } : {}),
      };
    },
    async decode(res, req) {
      const body = (await res.json()) as { text?: string };
      return {
        text: (body.text ?? '').trim(),
        model: resolveVendorCall(elevenlabsSpeechInput, req).model,
      };
    },
  },
};
