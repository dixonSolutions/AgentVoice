/**
 * TypeScript types for the admin settings API responses.
 * Mirror the backend Zod schemas and route return shapes.
 */

// ── Workflow ───────────────────────────────────────────────────────────────

export interface LlmSettings {
  model: string;
  region: string;
  maxTokens: number;
}

export type TtsProvider = 'browser' | 'amazon_polly';

export type TranscribeModelId = 'speech_foundation_model';
export type TranscribeLanguageMode = 'fixed' | 'identify';
export type TranscribePartialStability = 'low' | 'medium' | 'high';

export interface AudioSettings {
  preferWebkit: boolean;
  ttsProvider: TtsProvider;
  region?: string;
  pollyVoiceId: string;
  pollyEngine: 'standard' | 'neural' | 'generative';
  transcribeModel: TranscribeModelId;
  transcribeLanguageMode: TranscribeLanguageMode;
  transcribeLanguageCode: string;
  transcribeLanguageOptions: string;
  transcribePreferredLanguage?: string;
  transcribePartialResultsStabilization: boolean;
  transcribePartialResultsStability: TranscribePartialStability;
}

export interface TranscribeModelInfo {
  id: TranscribeModelId;
  label: string;
  description: string;
  recommended: boolean;
}

export interface PollyVoiceInfo {
  id: string;
  name: string;
  languageCode: string;
  languageName: string;
  gender: string;
  supportedEngines: string[];
}

export interface MemorySettings {
  maxTurns: number;
  keepTurns: number;
  summarySentences: number;
}

export interface LlmIntelligenceSettings {
  llm: LlmSettings;
  audio: AudioSettings;
  memory: MemorySettings;
  readOutputMaxChars: number;
}

export type WorkflowDefault = 'cursor_native' | 'llm_intelligence';

export interface WorkflowSettings {
  default: WorkflowDefault;
  llmIntelligence: LlmIntelligenceSettings;
}

// ── Hosting ────────────────────────────────────────────────────────────────

export type RunMode = 'test' | 'serve';

export interface TestModeSettings {
  backendPort: number;
  webPort: number;
}

export interface ServeModeSettings {
  backendPort: number;
  publicBaseUrl?: string;
}

export interface RunModes {
  test: TestModeSettings;
  serve: ServeModeSettings;
}

export interface HostingSettings {
  runMode: RunMode;
  runModes: RunModes;
}

// ── Serve ───────────────────────────────────────────────────────────────────

export interface ServeSettings {
  enabled: boolean;
  intervalMs: number;
  autoPull: boolean;
  autoInstallDeps: boolean;
  autoBuild: boolean;
  autoRestart: boolean;
  abortOnLocalChanges: boolean;
  branch?: string;
  repoDir?: string;
}

export type ServeOutcome = 'ok' | 'skipped' | 'no_changes' | 'error';

export type ServeActionId = 'pull' | 'deps' | 'build' | 'restart' | 'health';

export interface ServeRunResult {
  runId: string;
  trigger: 'manual' | 'scheduled';
  startedAt: string;
  finishedAt: string;
  outcome: ServeOutcome;
  summary: string;
}

export interface ServeGitSnapshot {
  repoDir: string;
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  currentCommit: string | null;
}

export interface ServeStatus {
  running: boolean;
  schedulerActive: boolean;
  lastRun: ServeRunResult | null;
  git: ServeGitSnapshot | null;
}

export interface ServeEvent {
  id: number;
  run_id: string;
  ts: string;
  step: string;
  status: 'ok' | 'skip' | 'warn' | 'error';
  detail: string | null;
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export type DefaultMode = 'agent' | 'plan';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface JobSettings {
  defaultMode: DefaultMode;
  maxConcurrentJobs: number;
  jobTimeoutMs: number;
  planFirst: boolean;
  preRunFlags: string[];
  modelCacheTtlMs: number;
  ghostKillEnabled: boolean;
  logLevel: LogLevel;
}

// ── Narrator ───────────────────────────────────────────────────────────────

export interface NarratorSettings {
  narratorEnabled: boolean;
  narratorCadenceMs: number;
  narratorMaxBufferEvents: number;
}

// ── AWS Keys ───────────────────────────────────────────────────────────────

export interface AwsKeyStatus {
  envVar: string;
  label: string;
  secret: boolean;
  optional: boolean;
  configured: boolean;
  complete: boolean;
}

export interface KeysStatus {
  keys: AwsKeyStatus[];
  viable: boolean;
  configured: boolean;
}

export interface KeysTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

// ── Projects (admin) ───────────────────────────────────────────────────────

export interface AdminProject {
  name: string;
  path: string;
  description: string | null;
  aliases: string[];
  enabled: boolean;
  resumeId: string | null;
  model: string | null;
  pathExists: boolean;
  updatedAt: string;
}

// ── Agent Client ───────────────────────────────────────────────────────────

export type AgentClientId = 'cursor' | 'codex' | 'claude-code';

export interface AgentClientInfo {
  id: AgentClientId;
  label: string;
  available: boolean;
  binPath: string | null;
}

export interface AgentClientSettings {
  active: AgentClientId;
  clients: AgentClientInfo[];
}

// ── Database ───────────────────────────────────────────────────────────────

export interface DbStats {
  counts: Record<string, number>;
  sizeBytes: number;
  dbPath: string;
}

export interface AuditEntry {
  id: number;
  tool: string;
  result: string;
  reason: string | null;
  created_at: string;
}
