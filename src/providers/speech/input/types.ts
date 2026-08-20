/**
 * Speech-input domain model.
 *
 * `SpeechInputRequest` is deliberately vendor-free: audio, a language, an
 * abort signal. Model choice and per-provider options are *not* in it, because
 * they differ per vendor — each converter resolves its own from settings. That
 * is what lets one request travel down a fallback chain unchanged.
 *
 * Vosk is not a vendor here: it only spots wake phrases and never transcribes
 * the turn. `browser` is a provider id with no implementation — it runs in the
 * PWA, and the orchestrator simply finds no specializer for it.
 *
 * See docs/29-speech-to-text-providers.md and docs/31-service-orchestrator-converter.md.
 */

import type { SpeechInputProviderId } from '../../../config.js';
import type { HttpConverter } from '../../../orchestration/http.js';
import type { Availability, Specializer } from '../../../orchestration/types.js';
import type { ProviderScope } from '../../scopes.js';
import type { LanguageSupport } from '../languages.js';

export type { SpeechInputProviderId };
export type { Availability };

export type SpeechProviderKind = 'device' | 'cloud' | 'self_hosted';

export interface SpeechModelOption {
  id: string;
  label: string;
  /** One-line trade-off note shown under the model picker. */
  note?: string;
  recommended?: boolean;
  /** Narrower language support than the provider as a whole (English-only, …). */
  languages?: LanguageSupport;
  /** Options that exist only for this model. Merged after the provider's own. */
  scopes?: ProviderScope[];
}

export interface SpeechInputCapabilities {
  kind: SpeechProviderKind;
  /**
   * Env var holding the credential, or null when none is needed. `sharedWith`
   * names other features using the same key so the UI can warn before
   * replacing it.
   */
  apiKeyEnvVar: string | null;
  sharedWith?: string;
  /** Languages the provider can handle. Drives fallback routing. */
  languages: LanguageSupport;
  /** Accepts an explicit language hint (otherwise auto-detect only). */
  languageHint: boolean;
  /** Audio leaves this machine. False for device and self-hosted. */
  sendsAudioOffMachine: boolean;
  /** Rough list price in USD per hour of audio. null = free/self-hosted. */
  approxUsdPerAudioHour: number | null;
  docsUrl: string;
  apiKeyUrl?: string;
}

/** What the service asks for. No vendor vocabulary. */
export interface SpeechInputRequest {
  /** One utterance of 16 kHz mono PCM16LE. */
  pcm: Buffer;
  /** ISO-639-1 code, or undefined to let the provider detect. */
  language?: string;
  signal?: AbortSignal;
  /**
   * Force a model instead of the configured one. Only the "test provider"
   * flow sets this — a normal turn lets each vendor pick its own.
   */
  modelOverride?: string;
}

export interface SpeechInputResult {
  /** Empty string when the audio held no speech. That is not an error. */
  text: string;
  /** The model that actually ran, for the log and the UI. */
  model: string;
}

export type SpeechInputSpecializer = Specializer<
  SpeechInputRequest,
  SpeechInputResult,
  SpeechInputCapabilities
>;

export type SpeechInputConverter = HttpConverter<SpeechInputRequest, SpeechInputResult>;

/**
 * One vendor, declared in one file: what it is, what it can do, how to reach
 * it, and how to translate. The registry turns this into a Specializer.
 */
export interface SpeechInputVendorMeta {
  id: Exclude<SpeechInputProviderId, 'browser'>;
  displayName: string;
  /** One sentence for the provider picker. */
  description: string;
  capabilities: SpeechInputCapabilities;
  /** Curated catalog. Free-text model ids are still accepted by the API. */
  models: SpeechModelOption[];
  defaultModel: string;
  /** Provider-level tunables. Per-model extras come from SpeechModelOption. */
  scopes: ProviderScope[];
  isConfigured(): boolean;
  /** Override when readiness is more than "the key is present". */
  checkAvailability?(): Promise<Availability>;
  /** Shown when `isConfigured()` is false. */
  unconfiguredDetail?: string;
}

/**
 * How the vendor is reached.
 *
 * `http` is the common case and only needs a converter — transport, auth,
 * timeouts and error classification come from the shared HTTP specializer.
 * `custom` exists because Amazon Transcribe streams over the AWS SDK rather
 * than a REST call; it still converts settings → native request internally,
 * it just owns its own transport.
 */
export type SpeechInputTransport =
  | { transport: 'http'; converter: SpeechInputConverter }
  | { transport: 'custom'; handle(req: SpeechInputRequest): Promise<SpeechInputResult> };

export type SpeechInputVendor = SpeechInputVendorMeta & SpeechInputTransport;
