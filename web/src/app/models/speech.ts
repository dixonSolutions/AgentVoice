/**
 * Types for the speech provider API (/api/speech).
 * Mirror the backend Zod schemas and route return shapes.
 */

import type { EnvKeyStatus } from './admin-settings';

// ── Scopes (src/providers/scopes.ts) ───────────────────────────────────────

export type ScopeValue = string | number | boolean;
export type ScopeKind = 'select' | 'toggle' | 'number' | 'text';

export interface ScopeChoice {
  value: ScopeValue;
  label: string;
  note?: string;
}

export interface ProviderScope {
  id: string;
  label: string;
  kind: ScopeKind;
  default: ScopeValue;
  choices?: ScopeChoice[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  help?: string;
  showWhen?: { scope: string; equals: ScopeValue[] };
  advanced?: boolean;
}

export type ScopeValues = Record<string, ScopeValue>;

// ── Shared ─────────────────────────────────────────────────────────────────

export type SpeechInputProviderId =
  | 'browser'
  | 'amazon_transcribe'
  | 'openai'
  | 'groq'
  | 'deepgram'
  | 'elevenlabs'
  | 'gemini'
  | 'openrouter'
  | 'local_whisper';

export type SpeechOutputProviderId =
  | 'browser'
  | 'amazon_polly'
  | 'openai'
  | 'elevenlabs'
  | 'deepgram'
  | 'groq'
  | 'gemini'
  | 'local_speech';

export type SpeechProviderId = SpeechInputProviderId | SpeechOutputProviderId;

export type SpeechProviderKind = 'device' | 'cloud' | 'self_hosted';

export interface LanguageInfo {
  code: string;
  name: string;
  nativeName: string;
}

export interface SpeechModelOption {
  id: string;
  label: string;
  note?: string;
  recommended?: boolean;
}

export interface SpeechVoiceOption {
  id: string;
  label: string;
  languages?: string[] | 'all' | 'whisper';
  gender?: string;
  note?: string;
}

/** One step of the configured chain, with bridge-side readiness resolved. */
export interface SpeechChainEntry {
  id: string;
  label: string;
  device: boolean;
  ready: boolean;
}

interface SpeechProviderCommon {
  displayName: string;
  description: string;
  models: SpeechModelOption[];
  defaultModel: string;
  selectedModel: string;
  scopes: ProviderScope[];
  scopeValues: ScopeValues;
  /** ISO-639-1 codes this provider can handle with the selected model/voice. */
  languages: string[];
  keyStatus: EnvKeyStatus | null;
  configured: boolean;
  available: boolean;
  detail?: string;
}

export interface SpeechInputCapabilities {
  kind: SpeechProviderKind;
  apiKeyEnvVar: string | null;
  sharedWith?: string;
  languages: string[] | 'all' | 'whisper';
  languageHint: boolean;
  sendsAudioOffMachine: boolean;
  approxUsdPerAudioHour: number | null;
  docsUrl: string;
  apiKeyUrl?: string;
}

export interface SpeechOutputCapabilities {
  kind: SpeechProviderKind;
  apiKeyEnvVar: string | null;
  sharedWith?: string;
  languages: string[] | 'all' | 'whisper';
  sendsTextOffMachine: boolean;
  approxUsdPerMillionChars: number | null;
  livesVoiceCatalog?: boolean;
  docsUrl: string;
  apiKeyUrl?: string;
}

export interface SpeechInputProviderInfo extends SpeechProviderCommon {
  id: SpeechInputProviderId;
  capabilities: SpeechInputCapabilities;
}

export interface SpeechOutputProviderInfo extends SpeechProviderCommon {
  id: SpeechOutputProviderId;
  capabilities: SpeechOutputCapabilities;
  voices: SpeechVoiceOption[];
  defaultVoice: string;
  selectedVoice: string;
  /** The selected voice's own range — narrower than `languages` for bound voices. */
  voiceLanguages: string[];
}

// ── Self-hosted server ─────────────────────────────────────────────────────

export interface SpeechServerSettings {
  manage: 'container' | 'external';
  runtime: 'auto' | 'docker' | 'podman';
  image: string;
  containerName: string;
  port: number;
  containerPort: number;
  baseUrl?: string;
  apiPath: string;
  gpu: boolean;
  modelVolume: string;
  modelCachePath: string;
}

export interface ContainerRuntimeInfo {
  id: 'docker' | 'podman';
  version: string | null;
  usable: boolean;
  detail?: string;
}

export interface ContainerState {
  exists: boolean;
  running: boolean;
  image: string | null;
  status: string | null;
  startedAt: string | null;
}

export interface SpeechServerStatus {
  manage: 'container' | 'external';
  serverUrl: string;
  reachable: boolean;
  detail?: string;
  inputModel: string | null;
  outputModel: string | null;
  gpu: boolean;
  image: string;
  imagePresent: boolean;
  containerName: string;
  container: ContainerState;
  runtime: ContainerRuntimeInfo | null;
  runtimes: ContainerRuntimeInfo[];
  modelVolume: string;
  setupRunning: boolean;
  setupRunId: string | null;
}

export interface SpeechSetupProgressEvent {
  message: string;
  done?: boolean;
  error?: string;
}

export interface SpeechSetupResult {
  ok: boolean;
  detail: string;
  serverUrl: string | null;
}

export interface SpeechSetupRunStatus {
  runId: string;
  events: SpeechSetupProgressEvent[];
  done: boolean;
  result?: SpeechSetupResult;
}

// ── Top-level view ─────────────────────────────────────────────────────────

export interface SpeechInputView {
  provider: SpeechInputProviderId;
  fallbacks: SpeechInputProviderId[];
  language: string;
  chain: SpeechInputProviderId[];
  providers: SpeechInputProviderInfo[];
}

export interface SpeechOutputView {
  provider: SpeechOutputProviderId;
  fallbacks: SpeechOutputProviderId[];
  language: string;
  /** What `auto` resolves to right now (it follows the speech-in language). */
  effectiveLanguage: string;
  chain: SpeechOutputProviderId[];
  providers: SpeechOutputProviderInfo[];
}

export interface SpeechView {
  languages: LanguageInfo[];
  stt: SpeechInputView;
  tts: SpeechOutputView;
  server: SpeechServerSettings;
}

export interface SpeechInputPatch {
  provider?: SpeechInputProviderId;
  fallbacks?: SpeechInputProviderId[];
  language?: string;
  model?: string;
  scopes?: ScopeValues;
  scopeProvider?: SpeechInputProviderId;
  server?: Partial<SpeechServerSettings>;
}

export interface SpeechOutputPatch {
  provider?: SpeechOutputProviderId;
  fallbacks?: SpeechOutputProviderId[];
  language?: string;
  model?: string;
  voice?: string;
  scopes?: ScopeValues;
  scopeProvider?: SpeechOutputProviderId;
  server?: Partial<SpeechServerSettings>;
}

export interface SpeechInputTestResult {
  ok: boolean;
  provider: SpeechInputProviderId;
  model: string;
  latencyMs: number;
  /** Empty on success — the probe clip contains no speech. */
  transcript?: string;
  error?: string;
  note?: string;
}

export interface SpeechVoiceCatalog {
  provider: SpeechOutputProviderId;
  model: string;
  /** True when the list came from the provider's API rather than the static catalog. */
  live: boolean;
  voices: SpeechVoiceOption[];
  error?: string;
}
