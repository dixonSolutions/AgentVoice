/**
 * ElevenLabs text-to-speech — /v1/text-to-speech/{voice_id}.
 *
 * The most natural-sounding option here and the only one whose multilingual
 * models keep one voice identity across languages, which matters when the agent
 * answers in whatever language you asked in.
 */

import { scopeNumber } from '../../../scopes.js';
import { expectOk, speechFetch } from '../../http.js';
import { resolveVendorCall } from '../settings.js';
import type { SpeechOutputVendor, SpeechVoiceOption } from '../types.js';

const BASE_URL = 'https://api.elevenlabs.io/v1';
const MAX_CHARS = 4000;

/**
 * ElevenLabs voice ids are account-scoped, but these public library voices are
 * available to every account and give the picker a working default. The live
 * catalog from /v1/voices replaces this whenever the key is set.
 */
const VOICES: SpeechVoiceOption[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel', gender: 'female', note: 'Calm, even narration.' },
  { id: 'AZnzlk1XvdvUeBnXmlld', label: 'Domi', gender: 'female', note: 'Brighter, more energetic.' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah', gender: 'female' },
  { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni', gender: 'male' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', label: 'Josh', gender: 'male', note: 'Low and steady.' },
  { id: 'VR6AewLTigWG4xSOukaG', label: 'Arnold', gender: 'male' },
];

interface ElevenVoicesResponse {
  voices?: Array<{ voice_id?: string; name?: string; labels?: Record<string, string> }>;
}

function apiKey(): string {
  return process.env['ELEVENLABS_API_KEY']?.trim() ?? '';
}

export const elevenlabsSpeechOutput: SpeechOutputVendor = {
  id: 'elevenlabs',
  displayName: 'ElevenLabs',
  description: 'The most natural voices, and one identity across 32 languages.',
  capabilities: {
    kind: 'cloud',
    apiKeyEnvVar: 'ELEVENLABS_API_KEY',
    sharedWith: 'ElevenLabs speech-to-text',
    languages: 'all',
    sendsTextOffMachine: true,
    approxUsdPerMillionChars: 150,
    livesVoiceCatalog: true,
    docsUrl: 'https://elevenlabs.io/docs/api-reference/text-to-speech',
    apiKeyUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
  models: [
    {
      id: 'eleven_turbo_v2_5',
      label: 'Turbo v2.5',
      note: '32 languages at roughly half the latency of Multilingual v2. The default.',
      recommended: true,
    },
    {
      id: 'eleven_multilingual_v2',
      label: 'Multilingual v2',
      note: 'Richest delivery; noticeably slower.',
    },
    {
      id: 'eleven_flash_v2_5',
      label: 'Flash v2.5',
      note: 'Lowest latency of all, with a small quality cost.',
    },
  ],
  defaultModel: 'eleven_turbo_v2_5',
  scopes: [
    {
      id: 'stability',
      label: 'Stability',
      kind: 'number',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.05,
      help: 'Low is more expressive but drifts; high is monotone but predictable.',
    },
    {
      id: 'similarity_boost',
      label: 'Similarity',
      kind: 'number',
      default: 0.75,
      min: 0,
      max: 1,
      step: 0.05,
      help: 'How closely to match the original voice recording.',
    },
    {
      id: 'style',
      label: 'Style exaggeration',
      kind: 'number',
      default: 0,
      min: 0,
      max: 1,
      step: 0.05,
      advanced: true,
      help: 'Above 0 adds latency. Leave at 0 for a coding assistant.',
    },
    { id: 'speed', label: 'Speed', kind: 'number', default: 1, min: 0.7, max: 1.2, step: 0.05 },
  ],
  voices: () => VOICES,
  defaultVoice: () => '21m00Tcm4TlvDq8ikWAM',
  isConfigured: () => apiKey().length > 0,
  unconfiguredDetail: 'ELEVENLABS_API_KEY is not set',

  /** The account's own voices, including any cloned ones. */
  async listVoices(): Promise<SpeechVoiceOption[]> {
    const res = await speechFetch(
      `${BASE_URL}/voices`,
      { method: 'GET', headers: { 'xi-api-key': apiKey() } },
      { timeoutMs: 15_000 },
    );
    await expectOk(res, 'elevenlabs');
    const body = (await res.json()) as ElevenVoicesResponse;

    const voices = (body.voices ?? [])
      .filter((v): v is { voice_id: string; name: string; labels?: Record<string, string> } =>
        Boolean(v.voice_id && v.name),
      )
      .map((v) => ({
        id: v.voice_id,
        label: v.name,
        ...(v.labels?.['gender'] ? { gender: v.labels['gender'] } : {}),
        ...(v.labels?.['description'] ? { note: v.labels['description'] } : {}),
      }));

    return voices.length ? voices : VOICES;
  },

  transport: 'http',
  converter: {
    id: 'elevenlabs',
    encode(req) {
      const call = resolveVendorCall(elevenlabsSpeechOutput, req);
      return {
        url: `${BASE_URL}/text-to-speech/${encodeURIComponent(call.voice)}?output_format=mp3_44100_128`,
        method: 'POST',
        headers: { 'xi-api-key': apiKey(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: req.text.slice(0, MAX_CHARS),
          model_id: call.model,
          voice_settings: {
            stability: scopeNumber(call.scopes, 'stability', 0.5),
            similarity_boost: scopeNumber(call.scopes, 'similarity_boost', 0.75),
            style: scopeNumber(call.scopes, 'style', 0),
            speed: scopeNumber(call.scopes, 'speed', 1),
          },
        }),
        ...(call.signal ? { signal: call.signal } : {}),
      };
    },
    async decode(res, req) {
      const call = resolveVendorCall(elevenlabsSpeechOutput, req);
      return {
        audio: Buffer.from(await res.arrayBuffer()),
        contentType: 'audio/mpeg',
        model: call.model,
        voice: call.voice,
      };
    },
  },
};
