/**
 * Amazon Polly — the original server-side voice, on the same IAM keys as
 * Bedrock and Transcribe.
 *
 * Custom transport: Polly speaks the AWS SDK, not REST. It also does the one
 * thing no other vendor here needs — swapping the voice mid-request. Polly
 * voices are language-bound (Joanna is en-US, Ewa is pl-PL), so speaking a
 * Polish reply with Joanna would produce Polish words in English phonemes.
 */

import { isAmazonAudioAvailable } from '../../../../intelligence/audio/awsClient.js';
import {
  listPollyVoices,
  synthesizePollyMp3,
  type PollyEngine,
} from '../../../../intelligence/audio/polly.js';
import { baseLanguage } from '../../languages.js';
import { resolveVendorCall } from '../settings.js';
import type { SpeechOutputVendor, SpeechVoiceOption } from '../types.js';

/** Polly's languages, narrowed to the app's catalog. */
const POLLY_LANGUAGES = [
  'ar', 'ca', 'cs', 'da', 'de', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'is', 'it', 'ja', 'ko',
  'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sv', 'tr', 'uk', 'zh',
];

/** Enough to work before DescribeVoices is reachable; the live list replaces it. */
const FALLBACK_VOICES: SpeechVoiceOption[] = [
  { id: 'Joanna', label: 'Joanna (en-US)', gender: 'Female', languages: ['en'] },
  { id: 'Matthew', label: 'Matthew (en-US)', gender: 'Male', languages: ['en'] },
  { id: 'Amy', label: 'Amy (en-GB)', gender: 'Female', languages: ['en'] },
];

function asEngine(value: string): PollyEngine {
  return value === 'standard' || value === 'generative' ? value : 'neural';
}

export const pollySpeechOutput: SpeechOutputVendor = {
  id: 'amazon_polly',
  displayName: 'Amazon Polly',
  description: 'Server-side voices on the IAM keys you already have for Bedrock.',
  capabilities: {
    kind: 'cloud',
    apiKeyEnvVar: 'AWS_SECRET_ACCESS_KEY',
    sharedWith: 'Bedrock and Amazon Transcribe',
    languages: POLLY_LANGUAGES,
    sendsTextOffMachine: true,
    approxUsdPerMillionChars: 16,
    livesVoiceCatalog: true,
    docsUrl: 'https://docs.aws.amazon.com/polly/latest/dg/voicelist.html',
    apiKeyUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
  },
  /** Polly's "model" is its engine, so the engine is the model list. */
  models: [
    {
      id: 'neural',
      label: 'Neural',
      note: 'The best quality/coverage balance, and the widest language set.',
      recommended: true,
    },
    { id: 'generative', label: 'Generative', note: 'Most lifelike; fewer voices and higher cost.' },
    { id: 'standard', label: 'Standard', note: 'Cheapest and most robotic.' },
  ],
  defaultModel: 'neural',
  scopes: [],
  voices: () => FALLBACK_VOICES,
  defaultVoice: () => 'Joanna',

  isConfigured: () => isAmazonAudioAvailable(),
  unconfiguredDetail: 'AWS IAM keys are not configured',

  async listVoices(model?: string): Promise<SpeechVoiceOption[]> {
    const voices = await listPollyVoices(asEngine(model ?? 'neural'));
    return voices.map((v) => ({
      id: v.id,
      label: `${v.name} (${v.languageCode})`,
      languages: [v.languageCode],
      gender: v.gender,
      note: v.languageName,
    }));
  },

  transport: 'custom',
  async handle(req) {
    const call = resolveVendorCall(pollySpeechOutput, req);
    const engine = asEngine(call.model);
    let voiceId = call.voice;

    const language = baseLanguage(call.language);
    if (language) {
      const catalog = await listPollyVoices(engine);
      const chosen = catalog.find((v) => v.id === voiceId);
      if (!chosen || baseLanguage(chosen.languageCode) !== language) {
        voiceId = catalog.find((v) => baseLanguage(v.languageCode) === language)?.id ?? voiceId;
      }
    }

    const { audio, contentType } = await synthesizePollyMp3(req.text, { voiceId, engine });
    return { audio, contentType, model: call.model, voice: voiceId };
  },
};
