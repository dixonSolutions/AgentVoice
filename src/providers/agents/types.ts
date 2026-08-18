/**
 * AgentProvider — the abstraction every coding-CLI (Cursor, Codex, Claude Code)
 * implements. This is the ONLY contract the rest of the app depends on; CLI
 * quirks (flags, auth commands, output formats) are isolated inside each
 * provider file (cursor.ts / codex.ts / claude.ts).
 *
 * Open/Closed: adding a fourth CLI means adding one new file + one registry
 * entry — nothing else in the app changes.
 */

import type { AgentClient } from '../../config.js';
import type { Project, SessionState } from '../../state/registry.js';
import type { AgentStreamEvent } from './events.js';
import type { McpRegistrationContext, McpRegistrationResult } from './mcpRegistration.js';

export type { AgentClient };
export type { AgentStreamEvent };

// ── Spawn contract (shared with executor/agentProcess.ts) ─────────────────

export type AgentMode = 'agent' | 'plan' | 'ask' | 'debug';

export interface SpawnOptions {
  project: Project;
  session: SessionState;
  prompt: string;
  mode?: AgentMode;
  /** If true, use one-shot JSON output (no streaming) — for ask/oneshot calls. */
  oneShot?: boolean;
  /** Run in an isolated git worktree (parallel agents on the same project). */
  worktree?: string;
  /** Append browser snapshot instructions to the worker prompt. */
  browser?: boolean;
}

export interface ModelEntry {
  id: string;
  displayName: string;
}

export interface AgentAbout {
  cliVersion: string;
  model: string;
  osPlatform: string;
  osArch: string;
}

// ── Auth contract ───────────────────────────────────────────────────────────

/**
 * Every auth flow a provider can offer. The PWA renders a different card per
 * flow, but never needs provider-specific knowledge — it just follows the
 * descriptor.
 *
 *  - browser-url:  CLI prints a URL; open it on the phone, CLI polls/exits on success.
 *  - device-code:  CLI prints a URL + short code; open URL + enter code on the phone.
 *  - token-paste:  User generates a long-lived token elsewhere and pastes it into the PWA.
 *  - api-key:      User pastes a provider API key into the PWA (stored in .env).
 */
export type AuthFlowId = 'browser-url' | 'device-code' | 'token-paste' | 'api-key';

export interface AuthFlowDescriptor {
  id: AuthFlowId;
  label: string;
  description: string;
  /** Field label + placeholder when the flow needs a pasted value. */
  pasteLabel?: string;
  pastePlaceholder?: string;
}

export interface AuthCheckResult {
  authenticated: boolean;
  email: string | null;
  detail?: string;
}

export interface AuthStartResult {
  flow: AuthFlowId;
  /** Tappable URL for browser-url / device-code flows. */
  url?: string;
  /** Short one-time code for device-code flows. */
  code?: string;
  /** One sentence of guidance to show/speak to the user. */
  instructions: string;
  /** Resolves once the flow concludes (success or failure/timeout). */
  done: Promise<AuthCheckResult>;
  /** Abort an in-flight login attempt (e.g. user cancelled from the phone). */
  cancel(): void;
}

// ── Provider contract ───────────────────────────────────────────────────────

export interface AgentProvider {
  readonly id: AgentClient;
  readonly displayName: string;

  /** Resolve the CLI binary path (env override → common install dirs → PATH fallback). */
  resolveBin(): string;
  /** True if the binary was actually found (not just the bare PATH fallback name). */
  isInstalled(): boolean;

  /** Build the subprocess environment for this CLI (may strip conflicting provider keys). */
  env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

  /** Ask the CLI whether the user is currently authenticated. */
  checkAuth(): Promise<AuthCheckResult>;
  /** Which login flows this provider supports, in preferred order. */
  authFlows(): AuthFlowDescriptor[];
  /**
   * Start a login flow. For browser-url/device-code this spawns the CLI's own
   * login command; for token-paste/api-key it validates + persists the pasted
   * value and resolves `done` immediately.
   */
  startLogin(flowId: AuthFlowId, opts?: { pasted?: string }): Promise<AuthStartResult>;

  /** True if this exit code + stderr combination looks like an auth failure. */
  isAuthError(exitCode: number, stderr: string): boolean;

  /** Live model list (never hardcoded — always from the CLI or its config). */
  listModels(): Promise<ModelEntry[]>;
  /** False when the CLI manages its own model choice (no --model flag to pass). */
  supportsModelSelection(): boolean;

  /** Build headless worker argv (jobManager / agent_ask). */
  buildWorkerArgs(opts: SpawnOptions): string[];
  /**
   * Build the conversational voice-agent argv. `bootPrompt` is the fully
   * assembled system/boot text from voiceAgent.ts (AgentVoice system prompt +
   * pending-turn block) — providers just place it as the final prompt arg.
   */
  buildVoiceArgs(project: Project, session: SessionState, pendingTurn: string | undefined, bootPrompt: string): string[];

  /**
   * Execution modes this CLI can actually enforce.
   *
   * `agent` is mandatory. A provider that cannot enforce `ask` must say so —
   * `agent_ask` then refuses rather than silently running a *writing* agent
   * against the user's repo under a read-only-sounding tool name.
   */
  supportedModes(): readonly AgentMode[];

  /**
   * Translate one raw NDJSON stdout line into normalized events.
   * Returns `[]` for lines this provider does not care about.
   * See providers/agents/events.ts for why this exists.
   */
  parseStreamEvent(raw: Record<string, unknown>): AgentStreamEvent[];

  /**
   * Register the AgentVoice MCP server with this CLI's own configuration.
   * Called on every voice-session prepare — must be idempotent, and must strip
   * `ctx.legacyServerNames` so a stale entry can't register a second server.
   */
  ensureMcpRegistration(ctx: McpRegistrationContext): Promise<McpRegistrationResult>;

  /** Optional `about`/version probe — not every CLI has an equivalent. */
  getAbout?(): Promise<AgentAbout | null>;

  /**
   * Best-effort: does this CLI still hold `sessionId` for `project`?
   *
   * Resuming a thread the CLI does not have is fatal (exit 1 before a single
   * token is produced), so we check the CLI's own on-disk store first and drop
   * `--resume` when the answer is a confident no.
   *
   * `'unknown'` means "the store could not be inspected" (layout changed, dir
   * missing, permissions) — callers MUST treat that as "try the resume anyway"
   * rather than silently starting a fresh thread. Session stores are internal
   * to each CLI, so this is a heuristic and must never be the only safety net;
   * executor/resumeGuard.ts also recovers from the failure at runtime.
   */
  sessionStatus?(project: Project, sessionId: string): 'present' | 'absent' | 'unknown';

  /**
   * Pre-create a fresh conversation thread and return its id, if the CLI can.
   * When absent (or resolving null) `agent_new_session` just clears resume_id.
   */
  createSession?(project: Project): Promise<string | null>;
}
