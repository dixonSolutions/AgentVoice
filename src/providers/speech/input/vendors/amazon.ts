/**
 * Amazon Transcribe — streaming SFM over StartStreamTranscription.
 *
 * The one speech-input vendor that is not a REST call: the AWS SDK streams
 * audio over HTTP/2, so this owns its transport instead of handing a converter
 * to the shared HTTP specializer. Everything above it — chain position,
 * capability checks, fallback — is unchanged, which is the point of the
 * transport being a vendor detail.
 *
 * Its four tunables (language mode, identify candidates, partial-results
 * stabilization and stability) used to be top-level `audio.transcribe*` config
 * fields. They are scopes now, so they live with the vendor that uses them.
 */

import { scopeBool, scopeString } from '../../../scopes.js';
import { isAmazonAudioAvailable } from '../../../../intelligence/audio/awsClient.js';
import { transcribePcm16 } from '../../../../intelligence/audio/transcribe.js';
import { defaultLocale } from '../../languages.js';
import { resolveVendorCall } from '../settings.js';
import type { SpeechInputVendor } from '../types.js';

/** Locales Transcribe streaming supports, narrowed to the app's catalog. */
const TRANSCRIBE_LANGUAGES = [
  'ar', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'fi', 'fr', 'he', 'hi', 'hr',
  'hu', 'id', 'it', 'ja', 'ko', 'lt', 'lv', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk',
  'sl', 'sv', 'ta', 'te', 'th', 'tr', 'uk', 'vi', 'zh',
];

export const amazonSpeechInput: SpeechInputVendor = {
  id: 'amazon_transcribe',
  displayName: 'Amazon Transcribe',
  description: 'Streaming SFM transcription on the same IAM keys as Bedrock and Polly.',
  capabilities: {
    kind: 'cloud',
    apiKeyEnvVar: 'AWS_SECRET_ACCESS_KEY',
    sharedWith: 'Bedrock and Polly',
    languages: TRANSCRIBE_LANGUAGES,
    languageHint: true,
    sendsAudioOffMachine: true,
    approxUsdPerAudioHour: 1.44,
    docsUrl: 'https://docs.aws.amazon.com/transcribe/latest/dg/streaming.html',
    apiKeyUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
  },
  models: [
    {
      id: 'speech_foundation_model',
      label: 'Speech Foundation Model (SFM)',
      note: 'The engine behind StartStreamTranscription — 100+ languages, real-time.',
      recommended: true,
    },
  ],
  defaultModel: 'speech_foundation_model',
  scopes: [
    {
      id: 'languageMode',
      label: 'Language mode',
      kind: 'select',
      default: 'fixed',
      choices: [
        { value: 'fixed', label: 'Fixed language', note: 'Fastest — uses the language selected above.' },
        {
          value: 'identify',
          label: 'Auto-identify',
          note: 'Detects among the candidates below. Roughly 3× slower in our testing.',
        },
      ],
    },
    {
      id: 'languageOptions',
      label: 'Identify candidates',
      kind: 'text',
      default: 'en-US,es-US,fr-FR,de-DE',
      placeholder: 'en-US,pl-PL,de-DE',
      help: 'Comma-separated locales. Transcribe allows at most one locale per language.',
      showWhen: { scope: 'languageMode', equals: ['identify'] },
    },
    {
      id: 'stabilization',
      label: 'Partial-results stabilization',
      kind: 'toggle',
      default: true,
      help: 'Freezes early words so the stream settles sooner. Recommended on for voice.',
    },
    {
      id: 'stability',
      label: 'Stability level',
      kind: 'select',
      default: 'high',
      choices: [
        { value: 'high', label: 'High', note: 'Lowest latency; commits early words aggressively.' },
        { value: 'medium', label: 'Medium', note: 'Balanced.' },
        { value: 'low', label: 'Low', note: 'Best accuracy when the model revises itself.' },
      ],
      showWhen: { scope: 'stabilization', equals: [true] },
    },
  ],

  isConfigured: () => isAmazonAudioAvailable(),
  unconfiguredDetail: 'AWS IAM keys are not configured',

  transport: 'custom',
  async handle(req) {
    const call = resolveVendorCall(amazonSpeechInput, req);
    const mode = scopeString(call.scopes, 'languageMode', 'fixed') === 'identify' ? 'identify' : 'fixed';
    const stability = scopeString(call.scopes, 'stability', 'high');

    const text = await transcribePcm16(req.pcm, {
      // Transcribe insists on a full locale; the shared setting is a language.
      languageCode: defaultLocale(call.language),
      languageMode: mode,
      languageOptions: scopeString(call.scopes, 'languageOptions', 'en-US'),
      stabilize: scopeBool(call.scopes, 'stabilization', true),
      stability: stability === 'low' || stability === 'medium' ? stability : 'high',
    });

    return { text, model: call.model };
  },
};
