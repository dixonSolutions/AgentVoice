/**
 * Speech-output domain model — the mirror image of input/types.ts.
 *
 * `SpeechOutputRequest` is vendor-free: text, a language, an abort signal.
 * Model and voice are resolved per vendor by its converter, which is what lets
 * one request travel down a fallback chain unchanged.
 *
 * `browser` is a provider id with no implementation here — speechSynthesis
 * runs on the device, and the orchestrator simply finds no specializer for it.
 *
 * See docs/30-speech-output-providers.md.
 */

import type { SpeechOutputProviderId } from '../../../config.js';
import type { HttpConverter } from '../../../orchestration/http.js';
import type { Availability, Specializer } from '../../../orchestration/types.js';
import type { ProviderScope } from '../../scopes.js';
import type { LanguageSupport } from '../languages.js';
import type { SpeechModelOption, SpeechProviderKind } from '../input/types.js';

export type { SpeechOutputProviderId };
export type { SpeechModelOption };

export interface SpeechVoiceOption {
  id: string;
  label: string;
  /** Narrower than the provider — most voices are bound to one language. */
  languages?: LanguageSupport;
  gender?: string;
  note?: string;
}

export interface SpeechOutputCapabilities {
  kind: SpeechProviderKind;
  apiKeyEnvVar: string | null;
  sharedWith?: string;
  /** Languages the provider can speak. Drives fallback routing. */
  languages: LanguageSupport;
  /** Text leaves this machine. False for device and self-hosted. */
  sendsTextOffMachine: boolean;
  /** Rough list price in USD per million characters. null = free/self-hosted. */
  approxUsdPerMillionChars: number | null;
  /** Voice catalog comes from a live API rather than the static list. */
  livesVoiceCatalog?: boolean;
  /**
   * Can hand back raw PCM as the vendor produces it (`stream: true` →
   * `SpeechOutputResult.pcm`), so the phone starts playing on the first chunk.
   * `false` is the explicit "whole file only" — such a vendor ignores `stream`.
   */
  streaming: boolean;
  docsUrl: string;
  apiKeyUrl?: string;
}

export interface SpeechOutputRequest {
  text: string;
  /** ISO-639-1 code — picks a voice and routes the fallback chain. */
  language?: string;
  signal?: AbortSignal;
  /** Preview-only overrides; a normal reply lets each vendor pick its own. */
  modelOverride?: string;
  voiceOverride?: string;
  /**
   * Ask for the audio as it is produced rather than as one file. Vendors with
   * `capabilities.streaming` answer with `pcm`; the rest return `audio` as usual.
   */
  stream?: boolean;
}

/** Headerless PCM16LE mono, chunk by chunk as the vendor sends it. */
export interface PcmStream {
  sampleRate: number;
  chunks: AsyncIterable<Buffer>;
}

export interface SpeechOutputResult {
  /** The whole file. Empty when the reply is streamed as `pcm`. */
  audio: Buffer;
  /** e.g. `audio/mpeg`, `audio/wav` — passed straight to the phone. */
  contentType: string;
  model: string;
  voice: string;
  /** Set only for a `stream` request to a streaming vendor. */
  pcm?: PcmStream;
}

export type SpeechOutputSpecializer = Specializer<
  SpeechOutputRequest,
  SpeechOutputResult,
  SpeechOutputCapabilities
>;

export type SpeechOutputConverter = HttpConverter<SpeechOutputRequest, SpeechOutputResult>;

export interface SpeechOutputVendorMeta {
  id: Exclude<SpeechOutputProviderId, 'browser'>;
  displayName: string;
  description: string;
  capabilities: SpeechOutputCapabilities;
  models: SpeechModelOption[];
  defaultModel: string;
  scopes: ProviderScope[];
  /** Static catalog, optionally narrowed by model. */
  voices(model?: string): SpeechVoiceOption[];
  defaultVoice(model?: string): string;
  /** Live catalog (Polly DescribeVoices, ElevenLabs /voices). */
  listVoices?(model?: string): Promise<SpeechVoiceOption[]>;
  isConfigured(): boolean;
  checkAvailability?(): Promise<Availability>;
  unconfiguredDetail?: string;
}

/** `custom` exists for Polly, which speaks the AWS SDK rather than REST. */
export type SpeechOutputTransport =
  | { transport: 'http'; converter: SpeechOutputConverter }
  | { transport: 'custom'; handle(req: SpeechOutputRequest): Promise<SpeechOutputResult> };

export type SpeechOutputVendor = SpeechOutputVendorMeta & SpeechOutputTransport;
