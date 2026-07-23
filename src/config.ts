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
});

// ── Voice settings (config.json) ─────────────────────────────────────────────

export const WakeWordsSchema = z.object({
  start: z.string().min(1).max(100),
  end: z.string().max(100).default('send'),
  /** Spoken during capture to abort the turn without sending — default "cancel". */
  cancel: z.string().max(100).default('cancel'),
});

export const TurnSubmitSchema = z.object({
  /** Ms of silence after last STT final before auto-submitting the buffered turn. */
  silenceMs: z.number().int().min(500).max(30_000).default(1500),
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
  cursorVoiceEnabled: z.boolean().default(true),
  /**
   * Barge-in behaviour: `pause` stops TTS on wake (cancel resumes, submit sends last_heard_words).
   * `deafen` and `stop` are legacy aliases — both map to pause.
   */
  interruptMode: z.enum(['pause', 'deafen', 'stop']).default('pause'),
  /** Volume multiplier (0–1) while assistant TTS plays after wake-word barge-in (deafen mode). */
  interruptDeafenFactor: z.number().min(0).max(1).default(0.2),
  /** Play error earcon on TTS failures, disconnects, and other voice pipeline errors. */
  errorSoundEnabled: z.boolean().default(true),
  /** Speak error messages aloud via TTS (independent of cursorVoiceEnabled). */
  errorSpeakEnabled: z.boolean().default(true),
  /** Server defaults for browser TTS — per-device overrides live in PWA localStorage. */
  webkit: WebkitTtsDefaultsSchema.default({}),
}).default({});

export const VoiceSettingsSchema = z.object({
  wakeWords: WakeWordsSchema,
  turnSubmit: TurnSubmitSchema.default({}),
  tts: VoiceTtsSchema,
});

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

export const WORKFLOW_IDS = ['cursor_native', 'llm_intelligence'] as const;
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

const LlmIntelligenceAudioSchema = z.object({
  /** Try WebKit STT first; fall back to Amazon Transcribe when unavailable. */
  preferWebkit: z.boolean().default(true),
  /**
   * Speech output (TTS) provider.
   * - browser: Web Speech API / speechSynthesis voices on the device
   * - amazon_polly: Amazon Polly (server-side)
   */
  ttsProvider: z.enum(['browser', 'amazon_polly']).default('browser'),
  /** AWS region for Polly + Transcribe (defaults to llm.region if omitted at runtime). */
  region: z.string().min(1).optional(),
  pollyVoiceId: z.string().min(1).default('Joanna'),
  pollyEngine: z.enum(['standard', 'neural', 'generative']).default('neural'),
  /**
   * Amazon Transcribe ASR model.
   * Only Speech Foundation Model (SFM) is exposed — it is AWS’s premier multi-billion
   * parameter ASR used by StartStreamTranscription (100+ languages). Bedrock has no
   * native real-time STT; Whisper-on-Marketplace is batch-oriented and slower for voice.
   */
  transcribeModel: z.enum(['speech_foundation_model']).default('speech_foundation_model'),
  /**
   * Language selection for Transcribe SFM.
   * - fixed: fastest — use transcribeLanguageCode
   * - identify: auto-detect among languageOptions (slower; one locale per language)
   */
  transcribeLanguageMode: z.enum(['fixed', 'identify']).default('fixed'),
  transcribeLanguageCode: z.string().min(2).default('en-US'),
  /** Comma-separated locales for identify mode — at most one locale per language (e.g. en-US,pl-PL). */
  transcribeLanguageOptions: z.string().min(2).default('en-US,es-US,fr-FR,de-DE'),
  /** Preferred language hint when identify mode is on (defaults to languageCode). */
  transcribePreferredLanguage: z.string().min(2).optional(),
  /** Reduce streaming latency (recommended on for voice). */
  transcribePartialResultsStabilization: z.boolean().default(true),
  /** high = lowest latency / more aggressive freeze of early words. */
  transcribePartialResultsStability: z.enum(['low', 'medium', 'high']).default('high'),
});

export const LlmIntelligenceWorkflowSchema = z.object({
  llm: LlmIntelligenceLlmSchema.default({}),
  audio: LlmIntelligenceAudioSchema.default({}),
  memory: LlmIntelligenceMemorySchema.default({}),
  /** Max chars returned to Claude from read_output / status payloads. */
  readOutputMaxChars: z.number().int().min(1000).max(32_768).default(8000),
});

export const WorkflowSettingsSchema = z.object({
  /** Active voice pipeline — cursor_native (default) or llm_intelligence. */
  default: z.enum(WORKFLOW_IDS).default('cursor_native'),
  llmIntelligence: LlmIntelligenceWorkflowSchema.default({}),
});

// ── Serve (self-hosting / auto-update) ────────────────────────────────────────

export const ServeSettingsSchema = z.object({
  /** Master switch for scheduled serve ticks. Manual runs always allowed. */
  enabled: z.boolean().default(false),
  /** Interval between scheduled runs (ms). Minimum 60s. */
  intervalMs: z.number().int().min(60_000).max(86_400_000).default(900_000),
  autoPull: z.boolean().default(true),
  autoInstallDeps: z.boolean().default(true),
  autoBuild: z.boolean().default(true),
  autoRestart: z.boolean().default(true),
  /** When true, abort before pull if the working tree has local changes. */
  abortOnLocalChanges: z.boolean().default(true),
  /** Git branch to track (defaults to current branch at runtime). */
  branch: z.string().min(1).max(128).optional(),
  /** Repository root (defaults to process working directory). */
  repoDir: z.string().min(1).optional(),
});

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
  /** Self-hosting auto-update sector. See docs/21-serve-self-hosting.md. */
  serve: ServeSettingsSchema.default({}),
  defaultMode: z.enum(['agent', 'plan']).default('agent'),
  /** Default cursor-agent model for new sessions (cursor_set_model global scope). */
  defaultActiveModel: z.string().min(1).default('auto'),
  maxConcurrentJobs: z.number().int().min(1).max(4).default(1),
  jobTimeoutMs: z.number().int().positive().default(600_000),
  planFirst: z.boolean().default(false),
  preRunFlags: z.array(z.string()).default(['--force', '--trust']),
  modelCacheTtlMs: z.number().int().positive().default(3_600_000),
  narratorEnabled: z.boolean().default(true),
  narratorCadenceMs: z.number().int().positive().default(15_000),
  narratorMaxBufferEvents: z.number().int().positive().default(50),
  /** Kill cursor-agent immediately if it tries to spawn Task/subagent sessions. */
  ghostKillEnabled: z.boolean().default(true),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  /** Optional name the voice agent uses when addressing the user. */
  userName: z.string().min(1).max(64).optional(),
  /**
   * Active agent client for worker and voice agent spawning.
   * All three clients support the cursor-voice global MCP server.
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
export type LlmIntelligenceWorkflow = z.infer<typeof LlmIntelligenceWorkflowSchema>;
export type WorkflowSettings = z.infer<typeof WorkflowSettingsSchema>;
export type ServeSettings = z.infer<typeof ServeSettingsSchema>;
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
      voice['turnSubmit'] = { silenceMs: 1500, vadEnabled: true };
    } else {
      const ts = voice['turnSubmit'] as Record<string, unknown>;
      if (ts['vadEnabled'] === undefined) ts['vadEnabled'] = true;
    }
    if (!voice['tts'] || typeof voice['tts'] !== 'object') {
      voice['tts'] = {
        cursorVoiceEnabled: true,
        interruptMode: 'deafen',
        interruptDeafenFactor: 0.2,
        errorSoundEnabled: true,
        errorSpeakEnabled: true,
        webkit: { rate: 1.02, pitch: 1, volume: 1, lang: 'en-US' },
      };
      log.info('Migrated config — added default settings.voice.tts');
    } else {
      const tts = voice['tts'] as Record<string, unknown>;
      if (tts['errorSoundEnabled'] === undefined) tts['errorSoundEnabled'] = true;
      if (tts['errorSpeakEnabled'] === undefined) tts['errorSpeakEnabled'] = true;
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
      s['workflow'] = { default: 'cursor_native' };
      log.info('Migrated config — added default workflow cursor_native');
    } else if (typeof s['workflow'] === 'object' && s['workflow'] !== null) {
      const wf = s['workflow'] as Record<string, unknown>;
      if (wf['default'] === 's2s_voice') {
        wf['default'] = 'cursor_native';
        log.info('Migrated workflow default s2s_voice → cursor_native');
      }
      delete wf['s2sVoice'];
      if (typeof wf['llmIntelligence'] === 'object' && wf['llmIntelligence'] !== null) {
        const li = wf['llmIntelligence'] as Record<string, unknown>;
        delete li['systemPrompts'];
        if (typeof li['audio'] === 'object' && li['audio'] !== null) {
          const audio = li['audio'] as Record<string, unknown>;
          if (audio['ttsProvider'] === undefined) {
            // Legacy: preferWebkit=false meant Polly-first for TTS.
            audio['ttsProvider'] =
              audio['preferWebkit'] === false ? 'amazon_polly' : 'browser';
            log.info(
              { ttsProvider: audio['ttsProvider'] },
              'Migrated config — added settings.workflow.llmIntelligence.audio.ttsProvider',
            );
          }
        }
      }
    }

    if (s['heartbeat'] && typeof s['heartbeat'] === 'object' && !s['serve']) {
      s['serve'] = s['heartbeat'];
      delete s['heartbeat'];
      log.info('Migrated config — renamed settings.heartbeat → settings.serve');
    }

    if (!s['serve'] || typeof s['serve'] !== 'object') {
      s['serve'] = {
        enabled: false,
        intervalMs: 900_000,
        autoPull: true,
        autoInstallDeps: true,
        autoBuild: true,
        autoRestart: true,
        abortOnLocalChanges: true,
      };
      log.info('Migrated config — added default settings.serve');
    }

    if (s['defaultActiveModel'] === undefined || String(s['defaultActiveModel']).trim() === '') {
      s['defaultActiveModel'] = 'auto';
      log.info('Migrated config — added default settings.defaultActiveModel');
    }

    if (s['agentClient'] === undefined) {
      s['agentClient'] = 'cursor';
      log.info('Migrated config — added default settings.agentClient');
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
