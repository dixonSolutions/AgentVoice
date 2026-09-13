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

/**
 * Speech settings live under /api/speech, not the workflow block — only the AWS
 * region for Polly/Transcribe stays here. See models/speech.ts.
 */
export interface AudioSettings {
  region?: string;
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

export type WorkflowDefault = 'agent_native' | 'llm_intelligence';

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
  branch?: string;
  repoDir?: string;
}

export type ServeOutcome = 'ok' | 'skipped' | 'no_changes' | 'error';

/**
 * `update` and `stash-update` both run scripts/update.sh — the single update
 * path (fetch, rebase, deps, build, restart). `stash-update` stashes local
 * changes first and pops them afterwards.
 */
export type ServeActionId = 'update' | 'stash-update' | 'restart' | 'health';

export interface ServeRunResult {
  runId: string;
  trigger: 'manual';
  startedAt: string;
  finishedAt: string;
  outcome: ServeOutcome;
  summary: string;
}

export interface ServeGitSnapshot {
  repoDir: string;
  branch: string;
  trackBranch: string;
  defaultBranch: string | null;
  dirty: boolean;
  /** Commits on HEAD that origin/<trackBranch> does not have. */
  ahead: number;
  /** Commits on origin/<trackBranch> that HEAD does not have. */
  behind: number;
  currentCommit: string | null;
  shortCommit: string | null;
  commitSubject: string | null;
  commitDate: string | null;
  upstreamCommit: string | null;
  /** Modified, staged and untracked paths, capped at 100. */
  localChanges: string[];
  /** Uncapped count — localChanges may be truncated. */
  localChangeCount: number;
  /** How many files the incoming commits touch. */
  incomingCount: number;
  /** localChanges ∩ files the incoming commits touch — what a rebase fights over. */
  conflictFiles: string[];
  /** Uncapped count — conflictFiles may be truncated. */
  conflictCount: number;
  fetchedAt: string | null;
}

export interface ServeStatus {
  running: boolean;
  lastRun: ServeRunResult | null;
  git: ServeGitSnapshot | null;
  /** Run id of the update currently in flight, if any. */
  updateRunId: string | null;
}

export interface ServeServiceLogs {
  unit: string;
  lines: number;
  text: string;
  ok: boolean;
  detail?: string;
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

/**
 * Same shape for every credential the bridge stores in .env — the AWS name is
 * historical. Aliased so non-AWS screens read sensibly.
 */
export type EnvKeyStatus = AwsKeyStatus;

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

export type AgentClientId = 'cursor' | 'codex' | 'claude-code' | 'codewhale';

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

// ── Pluggable hosting/tunnel providers (distinct from HostingSettings above,
//    which is only ports + runMode). See docs/25-hosting-providers.md. ──────

export type HostingProviderId =
  | 'tailscale'
  | 'cloudflare'
  | 'ngrok'
  | 'devtunnel'
  | 'lan'
  | 'local'
  | 'manual';

export interface HostingCapabilities {
  autoSetup: boolean;
  providesTls: boolean;
  publicExposure: boolean;
  cliRequired: boolean;
}

export interface HostingDetectResult {
  active: boolean;
  installed: boolean;
  publicUrl: string | null;
  detail?: string;
}

export interface HostingProviderInfo {
  id: HostingProviderId;
  displayName: string;
  capabilities: HostingCapabilities;
  detected: HostingDetectResult;
}

export interface HostingProvidersResponse {
  active: HostingProviderId;
  providers: HostingProviderInfo[];
}

export interface HostingSetupProgressEvent {
  message: string;
  done?: boolean;
  error?: string;
}

export interface HostingSetupResult {
  ok: boolean;
  publicUrl: string | null;
  detail: string;
}

export interface HostingSetupRunStatus {
  runId: string;
  provider: HostingProviderId;
  events: HostingSetupProgressEvent[];
  done: boolean;
  result?: HostingSetupResult;
}

export interface HostingDoctorCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface HostingDoctorResult {
  provider?: HostingProviderId;
  ok: boolean;
  checks: HostingDoctorCheck[];
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
