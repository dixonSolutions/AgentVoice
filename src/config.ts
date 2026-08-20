/**
 * Configuration loader — single source of truth for all settings.
 *
 * Split by sensitivity:
 *   .env        → secrets + machine-specific bootstrap paths (never committed)
 *   config.json → operational settings + project registry (non-secret)
 *
 * Voice settings (wake words, turn submit) live in config.json.
 * AWS IAM keys in .env power Polly, Transcribe, and Bedrock Converse.
 *
 * Precedence: .env > config.json > built-in defaults.
 * Both files are zod-validated at startup; invalid config fails fast.
 */

import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScopeMapSchema } from './providers/scopes.js';
import { childLogger } from './log.js';

const log = childLogger('config');

// ── .env schema (secrets + bootstrap) ────────────────────────────────────────

const EnvSchema = z.object({
  APP_TOKEN: z
    .string()
    .min(16, 'APP_TOKEN must be at least 16 characters — generate with: openssl rand -base64 32'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_BEARER_TOKEN_BEDROCK: z.string().optional(),
  AWS_REGION: z.string().optional(),
  PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  CONFIG_PATH: z.string().default('./config.json'),
  DB_PATH: z.string().default('./data/state.db'),
  /** Web Push VAPID keys — generate: npx web-push generate-vapid-keys */
  WEB_PUSH_VAPID_PUBLIC_KEY: z.string().optional(),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.string().optional(),
  WEB_PUSH_VAPID_SUBJECT: z.string().optional(),
  /** Apple Push Notification service (.p8 key) for native iOS app */
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_KEY: z.string().optional(),
  APNS_KEY_PATH: z.string().optional(),
  APNS_BUNDLE_ID: z.string().optional(),
  APNS_PRODUCTION: z.string().optional(),
  /** Override paths for alternative agent client binaries */
  CODEX_PATH: z.string().optional(),
  CLAUDE_CODE_PATH: z.string().optional(),
  /** Agent-provider auth credentials — set by the in-app login flow or manually. */
  CURSOR_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  /**
   * Speech-to-text provider keys. OPENAI_API_KEY / ANTHROPIC_API_KEY above are
   * shared with the agent CLIs — the rest are STT-only.
   * See docs/29-speech-to-text-providers.md.
   */
  GROQ_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  /** HostingProvider secrets — never in config.json since they grant tunnel access. */
  NGROK_AUTHTOKEN: z.string().optional(),
  CLOUDFLARE_TUNNEL_TOKEN: z.string().optional(),
  /** Optional TLS material for the `lan` hosting provider (e.g. mkcert-issued). */
  HTTPS_CERT_PATH: z.string().optional(),
  HTTPS_KEY_PATH: z.string().optional(),
});

// ── Voice settings (config.json) ─────────────────────────────────────────────

/** Legacy wake sensitivity presets — migrated to wakeConfidenceThreshold on read. */
export const LEGACY_WAKE_SENSITIVITY_THRESHOLD = {
  high: 0.45,
  balanced: 0.65,
  strict: 0.8,
} as const;

export const WakeWordsSchema = z
  .object({
    start: z.string().min(1).max(100),
    end: z.string().max(100).default('send'),
    /** Spoken during capture to abort the turn without sending — default "cancel". */
    cancel: z.string().max(100).default('cancel'),
    /** @deprecated — use wakeConfidenceThreshold; kept for config migration only. */
    sensitivity: z.enum(['high', 'balanced', 'strict']).optional(),
    /**
     * Minimum mean Vosk word confidence (0–1) to accept a wake phrase match.
     * Values below 0.55 also enable partial recognition for lower latency.
     */
    wakeConfidenceThreshold: z.number().min(0).max(1).optional(),
  })
  .transform(({ sensitivity, wakeConfidenceThreshold, ...rest }) => ({
    ...rest,
    wakeConfidenceThreshold:
      wakeConfidenceThreshold ??
      (sensitivity ? LEGACY_WAKE_SENSITIVITY_THRESHOLD[sensitivity] : 0.45),
  }));

/**
 * Previous default. Silero's `legacy` model quantised it to 15 x 96 ms frames,
 * so every turn ended with 1 440 ms of dead air. Kept so the migration below can
 * recognise an untouched config.
 */
export const LEGACY_TURN_SILENCE_MS = 1500;
/** With the v5 VAD (32 ms frames) this lands at 672 ms of real redemption. */
export const DEFAULT_TURN_SILENCE_MS = 700;

export const TurnSubmitSchema = z.object({
  /** Ms of silence after last STT final before auto-submitting the buffered turn. */
  silenceMs: z.number().int().min(500).max(30_000).default(DEFAULT_TURN_SILENCE_MS),
  /** When true, Silero VAD detects speech end; when false, use end wake phrase or silence timer. */
  vadEnabled: z.boolean().default(true),
});

/** Default WebKit speechSynthesis parameters (overridden per device in PWA localStorage). */
export const WebkitTtsDefaultsSchema = z.object({
  /** Speech rate — Web API range 0.1–10; we clamp to 0.5–2 in the UI. */
  rate: z.number().min(0.1).max(10).default(1.02),
  /** Pitch multiplier — Web API range 0–2, default 1. */
  pitch: z.number().min(0).max(2).default(1),
  /** Base volume — Web API range 0–1, default 1. */
  volume: z.number().min(0).max(1).default(1),
  /** BCP-47 language tag when no voiceURI is set. */
  lang: z.string().min(2).max(16).default('en-US'),
});

export const VoiceTtsSchema = z.object({
  /** When false, MCP speak() lines are shown in UI but not played aloud. */
  agentVoiceEnabled: z.boolean().default(true),
  /** Play error earcon on TTS failures, disconnects, and other voice pipeline errors. */
  errorSoundEnabled: z.boolean().default(true),
  /** Speak error messages aloud via TTS (independent of agentVoiceEnabled). */
  errorSpeakEnabled: z.boolean().default(true),
  /** Server defaults for browser TTS — per-device overrides live in PWA localStorage. */
  webkit: WebkitTtsDefaultsSchema.default({}),
}).default({});

export const VoiceSettingsSchema = z.object({
  wakeWords: WakeWordsSchema,
  turnSubmit: TurnSubmitSchema.default({}),
  tts: VoiceTtsSchema,
  /**
   * On-screen Speak / Cancel visibility while a session is live.
   * Cancel-processing (during submit/transcribe) is always shown — not gated by this.
   */
  touchControls: z.enum(['off', 'when_muted', 'always']).default('when_muted'),
  /** When false, skip Vosk start/end/cancel spotters — use on-screen Speak / Cancel. */
  wakeWordsEnabled: z.boolean().default(true),
  /** Apply this mute state when a voice session starts. */
  defaultMicMuted: z.boolean().default(false),
  /**
   * While a worker runs, the voice agent long-polls `next_voice_turn` for this many ms
   * before checking `get_agent_status` again. Speak only when there is a real milestone.
   */
  workerPollTimeoutMs: z.number().int().min(5_000).max(60_000).default(25_000),
});

export type TouchControlsMode = z.infer<typeof VoiceSettingsSchema>['touchControls'];

// ── Run mode (test vs serve) ────────────────────────────────────────────────

export const RUN_MODES = ['test', 'serve'] as const;
export type RunMode = (typeof RUN_MODES)[number];

const TestRunModeSchema = z.object({
  backendPort: z.number().int().min(1024).max(65535).default(5089),
  webPort: z.number().int().min(1024).max(65535).default(4200),
});

const ServeRunModeSchema = z.object({
  backendPort: z.number().int().min(1024).max(65535).default(8787),
  /** Optional public web entry port when frontend is split from the API (e.g. nginx → backend). */
  webPort: z.number().int().min(1024).max(65535).optional(),
  /** Public HTTPS origin (e.g. Tailscale serve URL). Shown in healthz / setup hints. */
  publicBaseUrl: z.string().url().optional(),
});

const RunModesSchema = z.object({
  test: TestRunModeSchema.default({}),
  serve: ServeRunModeSchema.default({}),
});

// ── Workflow config ───────────────────────────────────────────────────────────

/**
 * `agent_native` — the coding CLI itself is the brain (renamed from
 * `cursor_native`; migrated on read). `llm_intelligence` — a Bedrock model
 * orchestrates and the CLI is a worker.
 */
export const WORKFLOW_IDS = ['agent_native', 'llm_intelligence'] as const;
export type WorkflowId = (typeof WORKFLOW_IDS)[number];

const LlmIntelligenceMemorySchema = z.object({
  maxTurns: z.number().int().min(4).max(40).default(10),
  keepTurns: z.number().int().min(2).max(20).default(4),
  summarySentences: z.number().int().min(1).max(6).default(3),
});

const LlmIntelligenceLlmSchema = z.object({
  provider: z.enum(['bedrock']).default('bedrock'),
  model: z.string().min(1).default('us.anthropic.claude-sonnet-4-20250514-v1:0'),
  region: z.string().min(1).default('us-east-1'),
  maxTokens: z.number().int().min(256).max(8192).default(4096),
});

// ── Speech providers (docs/29-speech-to-text-providers.md, docs/30-…) ───────

/**
 * Speech-to-text engines. `browser` runs on the phone (SpeechRecognition);
 * everything else transcribes on the bridge. Vosk is absent on purpose — it
 * only spots wake phrases, it never transcribes the turn.
 */
export const SPEECH_INPUT_PROVIDERS = [
  'browser',
  'amazon_transcribe',
  'openai',
  'groq',
  'deepgram',
  'elevenlabs',
  'gemini',
  'openrouter',
  'local_whisper',
] as const;
export type SpeechInputProviderId = (typeof SPEECH_INPUT_PROVIDERS)[number];

/** Text-to-speech engines. `browser` is the device's own speechSynthesis voices. */
export const SPEECH_OUTPUT_PROVIDERS = [
  'browser',
  'amazon_polly',
  'openai',
  'elevenlabs',
  'deepgram',
  'groq',
  'gemini',
  'local_speech',
] as const;
export type SpeechOutputProviderId = (typeof SPEECH_OUTPUT_PROVIDERS)[number];

/**
 * The self-hosted OpenAI-compatible speech server. One container serves both
 * directions — `local_whisper` posts to `/audio/transcriptions`, `local_speech`
 * to `/audio/speech` — so there is a single lifecycle to manage.
 *
 * `container` lets the bridge pull the image and run it (Docker or Podman);
 * `external` points at a server you already run, here or on another host.
 *
 * Note: Ollama has no speech endpoint in either direction, so this goes through
 * a speech server image rather than Ollama.
 */
export const SpeechServerSchema = z.object({
  manage: z.enum(['container', 'external']).default('container'),
  runtime: z.enum(['auto', 'docker', 'podman']).default('auto'),
  image: z.string().min(1).default('ghcr.io/speaches-ai/speaches:latest-cpu'),
  containerName: z.string().min(1).max(64).default('agentvoice-speech'),
  /** Host port bound to 127.0.0.1 — never exposed beyond loopback. */
  port: z.number().int().min(1024).max(65535).default(8770),
  /** Port the server listens on inside the container. */
  containerPort: z.number().int().min(1).max(65535).default(8000),
  /** Explicit server root. Required for `external`; derived from `port` otherwise. */
  baseUrl: z.string().url().optional(),
  /** Path prefix where the server mounts the OpenAI-compatible API. */
  apiPath: z.string().min(1).default('/v1'),
  /** Pass the GPU through (docker --gpus all / podman --device nvidia.com/gpu=all). */
  gpu: z.boolean().default(false),
  /** Named volume for the weights cache, so re-pulling the image keeps models. */
  modelVolume: z.string().min(1).max(64).default('agentvoice-speech-models'),
  modelCachePath: z.string().min(1).default('/home/ubuntu/.cache/huggingface/hub'),
});

/**
 * Ordered fallback chain — the same shape in both directions.
 *
 * `provider` is tried first; each entry in `fallbacks` is tried in turn when
 * the one before it is unconfigured, unreachable, or cannot handle the
 * requested language. Per-provider tunables live in `scopes`
 * (see src/providers/scopes.ts) so adding an option never touches this schema.
 */
export const SpeechInputSchema = z.object({
  provider: z.enum(SPEECH_INPUT_PROVIDERS).default('browser'),
  fallbacks: z.array(z.enum(SPEECH_INPUT_PROVIDERS)).max(8).default(['amazon_transcribe']),
  /** ISO-639-1 hint (e.g. "en", "pl") or "auto" to let the provider detect. */
  language: z.string().min(2).max(16).default('auto'),
  /** provider id → model id. Missing entries use that provider's default. */
  models: z.record(z.string(), z.string()).default({}),
  /** provider id → its scope values. */
  scopes: ScopeMapSchema.default({}),
});

export const SpeechOutputSchema = z.object({
  provider: z.enum(SPEECH_OUTPUT_PROVIDERS).default('browser'),
  fallbacks: z.array(z.enum(SPEECH_OUTPUT_PROVIDERS)).max(8).default(['amazon_polly']),
  /**
   * Language the agent speaks. "auto" follows the speech-input language, which
   * is what you want when you talk to it in one language and expect the reply
   * in the same one.
   */
  language: z.string().min(2).max(16).default('auto'),
  models: z.record(z.string(), z.string()).default({}),
  /** provider id → voice id. Voice catalogs are per-provider, never a shared list. */
  voices: z.record(z.string(), z.string()).default({}),
  scopes: ScopeMapSchema.default({}),
});

const LlmIntelligenceAudioSchema = z.object({
  /** AWS region for Polly + Transcribe (defaults to llm.region if omitted at runtime). */
  region: z.string().min(1).optional(),
  /** Speech in: which engine transcribes a turn, plus its fallback chain. */
  stt: SpeechInputSchema.default({}),
  /** Speech out: which engine speaks a reply, plus its fallback chain. */
  tts: SpeechOutputSchema.default({}),
  /** Self-hosted server shared by `local_whisper` and `local_speech`. */
  speechServer: SpeechServerSchema.default({}),
});

export const LlmIntelligenceWorkflowSchema = z.object({
  llm: LlmIntelligenceLlmSchema.default({}),
  audio: LlmIntelligenceAudioSchema.default({}),
  memory: LlmIntelligenceMemorySchema.default({}),
  /** Max chars returned to Claude from read_output / status payloads. */
  readOutputMaxChars: z.number().int().min(1000).max(32_768).default(8000),
});

export const WorkflowSettingsSchema = z.object({
  /** Active voice pipeline — agent_native (default) or llm_intelligence. */
  default: z.enum(WORKFLOW_IDS).default('agent_native'),
  llmIntelligence: LlmIntelligenceWorkflowSchema.default({}),
});

// ── Serve (manual self-hosting — rebase / restart / health / journal) ────────

export const ServeSettingsSchema = z.object({
  /**
   * Branch to rebase onto (origin/<branch>). When unset, origin's default
   * branch is used, then `main`. Saved choice is remembered across restarts.
   * See docs/21-serve-self-hosting.md.
   */
  branch: z.string().min(1).max(128).optional(),
  /** Repository root (defaults to process working directory). */
  repoDir: z.string().min(1).optional(),
});

// ── Hosting (pluggable tunnel / reverse-proxy providers) ────────────────────

export const HOSTING_PROVIDERS = [
  'tailscale',
  'cloudflare',
  'ngrok',
  'devtunnel',
  'lan',
  'local',
  'manual',
] as const;
export type HostingProviderId = (typeof HOSTING_PROVIDERS)[number];

export const HostingSettingsSchema = z
  .object({
    /**
     * Explicit override. Undefined = auto-detect: an existing `*.ts.net`
     * runModes.serve.publicBaseUrl implies Tailscale (zero-touch migration for
     * current users); otherwise falls back to "manual". See registry.ts.
     */
    provider: z.enum(HOSTING_PROVIDERS).optional(),
    tailscale: z
      .object({
        /** `tailscale up --hostname=` — device name shown in the tailnet. */
        hostname: z.string().min(1).max(63).optional(),
        /** Headscale control-server URL; omit for the default coordination server. */
        loginServer: z.string().url().optional(),
      })
      .default({}),
    cloudflare: z
      .object({
        /** Named tunnel (stable hostname); omit to use a throwaway quick tunnel. */
        tunnelName: z.string().min(1).optional(),
        hostname: z.string().min(1).optional(),
      })
      .default({}),
    ngrok: z
      .object({
        /** Reserved domain (paid plans) for a stable URL; omit for a rotating one. */
        domain: z.string().min(1).optional(),
      })
      .default({}),
    devtunnel: z
      .object({
        tunnelId: z.string().min(1).optional(),
      })
      .default({}),
    lan: z
      .object({
        /** Phone mic capture requires a secure context — enable a self-signed/mkcert cert. */
        useTls: z.boolean().default(false),
      })
      .default({}),
  })
  .default({});

// ── config.json schema ───────────────────────────────────────────────────────

export const AGENT_CLIENTS = ['cursor', 'codex', 'claude-code'] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];

const SettingsSchema = z.object({
  /** `test` = localhost dev (backend + ng serve). `serve` = production / Tailscale. */
  runMode: z.enum(RUN_MODES).default('test'),
  runModes: RunModesSchema.default({}),
  /** Voice pipeline selection and per-workflow settings. See docs/15-llm-intelligence-workflow.md. */
  workflow: WorkflowSettingsSchema.default({}),
  voice: VoiceSettingsSchema,
  /** Manual self-hosting maintenance (rebase / build / restart / logs). See docs/21-serve-self-hosting.md. */
  serve: ServeSettingsSchema.default({}),
  /** Pluggable hosting/tunnel provider. See docs/25-hosting-providers.md. */
  hosting: HostingSettingsSchema,
  defaultMode: z.enum(['agent', 'plan']).default('agent'),
  /** Default model for new sessions on the active CLI (agent_set_model global scope). */
  defaultActiveModel: z.string().min(1).default('auto'),
  maxConcurrentJobs: z.number().int().min(1).max(4).default(1),
  jobTimeoutMs: z.number().int().positive().default(600_000),
  planFirst: z.boolean().default(false),
  preRunFlags: z.array(z.string()).default(['--force', '--trust']),
  modelCacheTtlMs: z.number().int().positive().default(3_600_000),
  narratorEnabled: z.boolean().default(true),
  narratorCadenceMs: z.number().int().positive().default(15_000),
  narratorMaxBufferEvents: z.number().int().positive().default(50),
  /** Kill the worker immediately if it tries to spawn Task/subagent sessions. */
  ghostKillEnabled: z.boolean().default(true),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  /** Optional name the voice agent uses when addressing the user. */
  userName: z.string().min(1).max(64).optional(),
  /**
   * Active agent client for worker and voice agent spawning.
   * Each client registers the agent-voice MCP server through its own provider.
   * See docs/23-multi-agent-client.md for installation and flag details.
   */
  agentClient: z.enum(AGENT_CLIENTS).default('cursor'),
});

const ProjectConfigSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z0-9_-]+$/,
      'Project name must be slug-safe (lowercase a–z, 0–9, hyphens, underscores)',
    ),
  path: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
});

export const ConfigFileSchema = z.object({
  settings: SettingsSchema,
  projects: z.array(ProjectConfigSchema).min(1, 'At least one project must be registered'),
});

// ── Exported types ────────────────────────────────────────────────────────────

export type AppEnv = z.infer<typeof EnvSchema>;
// AgentClient and AGENT_CLIENTS are exported above the schema definition.
export type WakeWords = z.infer<typeof WakeWordsSchema>;
export type TurnSubmit = z.infer<typeof TurnSubmitSchema>;
export type WebkitTtsDefaults = z.infer<typeof WebkitTtsDefaultsSchema>;
export type VoiceTtsSettings = z.infer<typeof VoiceTtsSchema>;
export type VoiceSettingsInput = z.infer<typeof VoiceSettingsSchema>;
export type VoiceSettings = VoiceSettingsInput;
export type RunModes = z.infer<typeof RunModesSchema>;
export type SpeechServerSettings = z.infer<typeof SpeechServerSchema>;
export type SpeechInputSettings = z.infer<typeof SpeechInputSchema>;
export type SpeechOutputSettings = z.infer<typeof SpeechOutputSchema>;
export type AudioSettings = z.infer<typeof LlmIntelligenceAudioSchema>;
export type LlmIntelligenceWorkflow = z.infer<typeof LlmIntelligenceWorkflowSchema>;
export type WorkflowSettings = z.infer<typeof WorkflowSettingsSchema>;
export type ServeSettings = z.infer<typeof ServeSettingsSchema>;
export type HostingSettings = z.infer<typeof HostingSettingsSchema>;
export type Settings = Omit<z.infer<typeof SettingsSchema>, 'voice' | 'workflow'> & {
  voice: VoiceSettings;
  workflow: WorkflowSettings;
};
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export interface AppConfig {
  env: AppEnv;
  settings: Settings;
  projects: ProjectConfig[];
}

// ── Migration ─────────────────────────────────────────────────────────────────


/** Read a nested object off a raw config node, creating it when absent. */
function rawObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

/**
 * Fold the pre-unification audio keys into `audio.stt` / `audio.tts` /
 * `audio.speechServer`.
 *
 * Before this, speech settings were spread across `preferWebkit`,
 * `ttsProvider`, `polly*` and seven `transcribe*` fields — one flat namespace
 * per vendor. They now live as a provider choice plus a scope map, so a new
 * engine adds no schema. Migration is one-way and lossless for every value the
 * new model still has a home for; `transcribeModel` is dropped because it only
 * ever had one legal value.
 */
const LEGACY_AUDIO_KEYS = [
  'preferWebkit',
  'ttsProvider',
  'pollyVoiceId',
  'pollyEngine',
  'transcribeModel',
  'transcribeLanguageMode',
  'transcribeLanguageCode',
  'transcribeLanguageOptions',
  'transcribePreferredLanguage',
  'transcribePartialResultsStabilization',
  'transcribePartialResultsStability',
] as const;

function migrateAudioSettings(audio: Record<string, unknown>): void {
  const stt = rawObject(audio, 'stt');

  // The self-hosted server moved up a level once it started serving TTS too.
  if (typeof stt['local'] === 'object' && stt['local'] !== null && audio['speechServer'] === undefined) {
    audio['speechServer'] = stt['local'];
  }
  delete stt['local'];

  const hasLegacy = LEGACY_AUDIO_KEYS.some((key) => key in audio);
  if (!hasLegacy) return;

  // ── Speech in ────────────────────────────────────────────────────────────
  const serverStt =
    typeof stt['provider'] === 'string' && stt['provider'] !== 'browser'
      ? (stt['provider'] as string)
      : 'amazon_transcribe';

  if (audio['preferWebkit'] === false) {
    stt['provider'] = serverStt;
    stt['fallbacks'] = [];
  } else {
    // preferWebkit defaulted to true: browser first, server as the fallback.
    stt['provider'] = 'browser';
    stt['fallbacks'] = [serverStt];
  }

  if (typeof audio['transcribeLanguageCode'] === 'string' && stt['language'] === undefined) {
    stt['language'] = audio['transcribeLanguageCode'];
  }

  const sttScopes = rawObject(stt, 'scopes');
  sttScopes['amazon_transcribe'] = {
    languageMode: audio['transcribeLanguageMode'] ?? 'fixed',
    languageOptions: audio['transcribeLanguageOptions'] ?? 'en-US,es-US,fr-FR,de-DE',
    stabilization: audio['transcribePartialResultsStabilization'] ?? true,
    stability: audio['transcribePartialResultsStability'] ?? 'high',
  };

  // ── Speech out ───────────────────────────────────────────────────────────
  const tts = rawObject(audio, 'tts');
  const wantsPolly =
    audio['ttsProvider'] === 'amazon_polly' ||
    (audio['ttsProvider'] === undefined && audio['preferWebkit'] === false);

  tts['provider'] = wantsPolly ? 'amazon_polly' : 'browser';
  tts['fallbacks'] = wantsPolly ? ['browser'] : ['amazon_polly'];

  if (typeof audio['pollyVoiceId'] === 'string') {
    rawObject(tts, 'voices')['amazon_polly'] = audio['pollyVoiceId'];
  }
  if (typeof audio['pollyEngine'] === 'string') {
    rawObject(rawObject(tts, 'scopes'), 'amazon_polly')['engine'] = audio['pollyEngine'];
  }

  for (const key of LEGACY_AUDIO_KEYS) delete audio[key];

  log.info(
    { sttProvider: stt['provider'], ttsProvider: tts['provider'] },
    'Migrated config — audio.{preferWebkit,ttsProvider,polly*,transcribe*} → audio.stt / audio.tts',
  );
}

function migrateRawConfig(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  const settings = obj['settings'];
  if (typeof settings !== 'object' || settings === null) return raw;

  const s = settings as Record<string, unknown>;

  if ('voice' in s && s['voice'] !== undefined) {
    const voice = s['voice'] as Record<string, unknown>;
    if (typeof voice['wakeWords'] === 'object' && voice['wakeWords'] !== null) {
      const ww = voice['wakeWords'] as Record<string, unknown>;
      delete ww['stop'];
      if (typeof ww['end'] !== 'string' || !String(ww['end']).trim()) {
        ww['end'] = 'send';
      }
    }
    if (!voice['turnSubmit'] || typeof voice['turnSubmit'] !== 'object') {
      voice['turnSubmit'] = {
        silenceMs: DEFAULT_TURN_SILENCE_MS,
        vadEnabled: true,
      };
    } else {
      const ts = voice['turnSubmit'] as Record<string, unknown>;
      if (ts['vadEnabled'] === undefined) ts['vadEnabled'] = true;
      // Only rewrite a value that is provably the old default — anything else is
      // a deliberate choice and stays untouched.
      if (ts['silenceMs'] === LEGACY_TURN_SILENCE_MS) {
        ts['silenceMs'] = DEFAULT_TURN_SILENCE_MS;
        log.info(
          { from: LEGACY_TURN_SILENCE_MS, to: DEFAULT_TURN_SILENCE_MS },
          'Migrated config — turnSubmit.silenceMs lowered for the v5 VAD',
        );
      }
    }
    if (!voice['tts'] || typeof voice['tts'] !== 'object') {
      voice['tts'] = {
        agentVoiceEnabled: true,
        errorSoundEnabled: true,
        errorSpeakEnabled: true,
        webkit: { rate: 1.02, pitch: 1, volume: 1, lang: 'en-US' },
      };
      log.info('Migrated config — added default settings.voice.tts');
    } else {
      const tts = voice['tts'] as Record<string, unknown>;
      // AgentVoice rename — the flag was never Cursor-specific.
      if ('cursorVoiceEnabled' in tts) {
        if (tts['agentVoiceEnabled'] === undefined) {
          tts['agentVoiceEnabled'] = tts['cursorVoiceEnabled'];
        }
        delete tts['cursorVoiceEnabled'];
        log.info('Migrated config — settings.voice.tts.cursorVoiceEnabled → agentVoiceEnabled');
      }
      if (tts['errorSoundEnabled'] === undefined) tts['errorSoundEnabled'] = true;
      if (tts['errorSpeakEnabled'] === undefined) tts['errorSpeakEnabled'] = true;
      // Drop legacy barge-in volume ducking (deafen) — always full volume; wake pauses TTS.
      if ('interruptMode' in tts || 'interruptDeafenFactor' in tts) {
        delete tts['interruptMode'];
        delete tts['interruptDeafenFactor'];
        log.info('Migrated config — removed legacy TTS interrupt deafen settings');
      }
    }
    if (voice['touchControls'] === undefined) {
      voice['touchControls'] = 'when_muted';
      log.info('Migrated config — added default settings.voice.touchControls=when_muted');
    }
    if (voice['wakeWordsEnabled'] === undefined) {
      voice['wakeWordsEnabled'] = true;
    }
    if (voice['defaultMicMuted'] === undefined) {
      voice['defaultMicMuted'] = false;
    }
    if (!voice['wakeWords'] || typeof voice['wakeWords'] !== 'object') {
      throw new Error(
        'config.json must include settings.voice.wakeWords.start — see config.example.json',
      );
    }

    // Strip legacy S2S voice provider fields.
    delete voice['defaultProvider'];
    delete voice['providers'];
    delete voice['systemPrompts'];
    delete voice['systemPrompt'];

    if (!s['workflow']) {
      s['workflow'] = { default: 'agent_native' };
      log.info('Migrated config — added default workflow agent_native');
    } else if (typeof s['workflow'] === 'object' && s['workflow'] !== null) {
      const wf = s['workflow'] as Record<string, unknown>;
      if (wf['default'] === 's2s_voice' || wf['default'] === 'cursor_native') {
        const from = wf['default'];
        wf['default'] = 'agent_native';
        log.info({ from }, 'Migrated workflow default → agent_native');
      }
      delete wf['s2sVoice'];
      if (typeof wf['llmIntelligence'] === 'object' && wf['llmIntelligence'] !== null) {
        const li = wf['llmIntelligence'] as Record<string, unknown>;
        delete li['systemPrompts'];
        if (typeof li['audio'] === 'object' && li['audio'] !== null) {
          migrateAudioSettings(li['audio'] as Record<string, unknown>);
        }
      }
    }

    if (s['heartbeat'] && typeof s['heartbeat'] === 'object' && !s['serve']) {
      s['serve'] = s['heartbeat'];
      delete s['heartbeat'];
      log.info('Migrated config — renamed settings.heartbeat → settings.serve');
    }

    if (!s['serve'] || typeof s['serve'] !== 'object') {
      s['serve'] = {};
      log.info('Migrated config — added default settings.serve');
    } else {
      const serve = s['serve'] as Record<string, unknown>;
      let stripped = false;
      for (const key of [
        'enabled',
        'intervalMs',
        'autoPull',
        'autoInstallDeps',
        'autoBuild',
        'autoRestart',
        'abortOnLocalChanges',
      ]) {
        if (key in serve) {
          delete serve[key];
          stripped = true;
        }
      }
      if (stripped) {
        log.info('Migrated config — removed settings.serve auto-update keys');
      }
    }

    if (s['defaultActiveModel'] === undefined || String(s['defaultActiveModel']).trim() === '') {
      s['defaultActiveModel'] = 'auto';
      log.info('Migrated config — added default settings.defaultActiveModel');
    }

    if (s['agentClient'] === undefined) {
      s['agentClient'] = 'cursor';
      log.info('Migrated config — added default settings.agentClient');
    }

    if (s['hosting'] === undefined) {
      // No explicit provider — registry.ts auto-detects Tailscale from an
      // existing *.ts.net publicBaseUrl, so current users need no edits here.
      s['hosting'] = {};
      log.info('Migrated config — added default settings.hosting (auto-detect)');
    }

    return raw;
  }

  throw new Error(
    'Missing settings.voice in config.json — see config.example.json (include wakeWords.start).',
  );
}

function resolveWorkflowSettings(
  workflow: z.infer<typeof WorkflowSettingsSchema>,
): WorkflowSettings {
  const llmIntelligenceRaw = workflow.llmIntelligence;
  const audioRegion = llmIntelligenceRaw.audio.region ?? llmIntelligenceRaw.llm.region;
  return {
    ...workflow,
    llmIntelligence: {
      ...llmIntelligenceRaw,
      audio: { ...llmIntelligenceRaw.audio, region: audioRegion },
    },
  };
}

// ── Loader (singleton) ────────────────────────────────────────────────────────

let _config: AppConfig | null = null;
let _configPath = './config.json';
/** Parsed config.json — kept in memory to avoid disk + Zod on every read. */
let _configFileCache: ConfigFile | null = null;

export function getConfigPath(): string {
  return _configPath;
}

function parseEnv(): AppEnv {
  const envResult = EnvSchema.safeParse(process.env);
  if (!envResult.success) {
    throw new Error(`Invalid environment variables:\n${envResult.error.message}`);
  }
  return envResult.data;
}

function parseConfigFileFromDisk(configPath: string): ConfigFile {
  if (!existsSync(configPath)) {
    throw new Error(
      `config.json not found at ${configPath}.\n` +
        'Copy config.example.json to config.json and edit it.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${String(err)}`);
  }

  parsed = migrateRawConfig(parsed);

  const cfgResult = ConfigFileSchema.safeParse(parsed);
  if (!cfgResult.success) {
    throw new Error(`Invalid config.json:\n${cfgResult.error.message}`);
  }

  return cfgResult.data;
}

function buildAppConfig(env: AppEnv, configFile: ConfigFile): AppConfig {
  const workflow = resolveWorkflowSettings(configFile.settings.workflow);

  const isDevelopment = process.env.NODE_ENV === 'development';
  const runMode = isDevelopment ? 'test' : configFile.settings.runMode;
  if (isDevelopment && configFile.settings.runMode !== 'test') {
    log.info(
      { configRunMode: configFile.settings.runMode, effectiveRunMode: 'test' },
      'development detected — overriding runMode to test (local dev profile)',
    );
  }

  return {
    env,
    settings: {
      ...configFile.settings,
      runMode,
      voice: configFile.settings.voice,
      workflow,
    },
    projects: configFile.projects,
  };
}

function loadFromDisk(): AppConfig {
  const env = parseEnv();
  _configPath = env.CONFIG_PATH;
  const configPath = resolve(env.CONFIG_PATH);
  const configFile = parseConfigFileFromDisk(configPath);
  _configFileCache = configFile;
  return buildAppConfig(env, configFile);
}

/** Fast read of validated config.json from memory (no disk I/O). */
export function getCachedConfigFile(): ConfigFile {
  if (!_configFileCache) {
    throw new Error('Config not loaded — call loadConfig() first');
  }
  return _configFileCache;
}

/** Clone for callers that mutate before write. */
export function cloneConfigFile(): ConfigFile {
  return structuredClone(getCachedConfigFile());
}

export function loadConfig(): AppConfig {
  if (_config) return _config;
  _config = loadFromDisk();

  log.info(
    {
      configPath: resolve(_configPath),
      projectCount: _config.projects.length,
      runMode: _config.settings.runMode,
      defaultWorkflow: _config.settings.workflow.default,
      logLevel: _config.settings.logLevel,
    },
    'config loaded',
  );

  return _config;
}

/**
 * Reload config from disk, or from an already-validated config.json object
 * (skips disk read + parse when the caller just wrote the file).
 */
export function reloadConfig(file?: ConfigFile): AppConfig {
  if (file !== undefined) {
    const validated = ConfigFileSchema.safeParse(file);
    if (!validated.success) {
      throw new Error(`Invalid config.json:\n${validated.error.message}`);
    }
    _configFileCache = validated.data;
    const env = _config?.env ?? parseEnv();
    _configPath = env.CONFIG_PATH;
    _config = buildAppConfig(env, validated.data);
    return _config;
  }

  _config = loadFromDisk();
  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
