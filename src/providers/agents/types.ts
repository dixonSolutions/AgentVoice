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

export type { AgentClient };

// ── Spawn contract (shared with executor/cursorAgent.ts) ──────────────────

export interface SpawnOptions {
  project: Project;
  session: SessionState;
  prompt: string;
  mode?: 'agent' | 'plan' | 'ask' | 'debug';
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

  /** Build headless worker argv (jobManager / cursor_ask). */
  buildWorkerArgs(opts: SpawnOptions): string[];
  /**
   * Build the conversational voice-agent argv. `bootPrompt` is the fully
   * assembled system/boot text from voiceAgent.ts (cursor-voice rule body +
   * pending-turn block) — providers just place it as the final prompt arg.
   */
  buildVoiceArgs(project: Project, session: SessionState, pendingTurn: string | undefined, bootPrompt: string): string[];

  /** Optional `about`/version probe — not every CLI has an equivalent. */
  getAbout?(): Promise<AgentAbout | null>;
}
