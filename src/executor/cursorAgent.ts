/**
 * Agent executor — spawn, parse, kill. CLI-neutral: delegates every CLI-specific
 * decision (binary path, env, argv, auth-error detection) to the active
 * AgentProvider (src/providers/agents/). This module owns only the shared
 * process lifecycle: spawn, NDJSON stdout parsing, stderr capture, kill.
 *
 * Key design rules from docs/03-security.md and docs/05:
 *   - `shell: false` always — no shell interpolation.
 *   - `--workspace` / `--cd` comes from the registry, never from the caller.
 *   - The prompt string is the ONLY caller-controlled argv element.
 *   - `strip-ansi` run defensively before JSON.parse.
 *   - Session IDs captured from structured output, not TTY scraping.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import stripAnsi from 'strip-ansi';
import { AGENT_CLIENTS, type AgentClient } from '../config.js';
import { childLogger } from '../log.js';
import { getActiveProvider, getProvider } from '../providers/agents/registry.js';
import { cursorProvider } from '../providers/agents/cursor.js';
import type { SpawnOptions } from '../providers/agents/types.js';
import type { StreamJsonEvent } from './watcher.js';

export { AGENT_CLIENTS };
export type { AgentClient, SpawnOptions };

const log = childLogger('executor');

/**
 * Env for Cursor CLI subprocesses specifically — used by the Cursor-only
 * diagnostic tools (cursor_mcp_list, cursor_mcp_tools, cursor_new_session's
 * create-chat) and the /healthz version probe, which always target the
 * Cursor CLI regardless of the active agentClient.
 */
export function buildCursorAgentEnv(): NodeJS.ProcessEnv {
  return cursorProvider.env(process.env);
}

export function resolveCursorAgentPath(): string {
  return cursorProvider.resolveBin();
}

export function isCursorAgentAvailable(): boolean {
  return cursorProvider.isInstalled();
}

export function resolveCodexPath(): string {
  return getProvider('codex').resolveBin();
}

export function resolveClaudeCodePath(): string {
  return getProvider('claude-code').resolveBin();
}

/** Resolve the binary path for the given agent client. */
export function resolveAgentBin(client: AgentClient): string {
  return getProvider(client).resolveBin();
}

/** Check whether a given agent client binary is available on the system. */
export function isAgentClientAvailable(client: AgentClient): boolean {
  return getProvider(client).isInstalled();
}

/** Return the resolved binary path if found, or null if only the fallback name is available. */
export function resolvedAgentBinPath(client: AgentClient): string | null {
  const provider = getProvider(client);
  return provider.isInstalled() ? provider.resolveBin() : null;
}

/** Prevent spawn ENOENT/EACCES from becoming an uncaught exception (crashes the bridge). */
export function attachCursorAgentSpawnGuard(
  child: ChildProcess,
  context?: Record<string, unknown>,
): void {
  child.on('error', (err) => {
    log.error({ err, ...context }, 'agent process error');
  });
}

export function cursorAgentSpawnErrorMessage(client: AgentClient = 'cursor'): string {
  const provider = getProvider(client);
  return (
    `${provider.displayName} CLI not found — install it and make sure it's on PATH, ` +
    'or set the *_PATH override in .env (see docs/23-multi-agent-client.md)'
  );
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface AgentHandle {
  pid: number;
  /** Resolves when the process exits (exit code, captured session_id, and final summary). */
  result: Promise<AgentResult>;
  /** Kill the process (SIGTERM → SIGKILL after 5 s). */
  kill(): void;
  /** Subscribe to parsed stream-json events (called for each line). */
  onEvent: (cb: (event: StreamJsonEvent) => void) => void;
}

export interface AgentResult {
  exitCode: number;
  sessionId: string | null;
  summary: string | null;
  error: string | null;
  /** True when the failure looks like an auth problem (per the active provider's heuristics). */
  authRequired: boolean;
}

// ── Spawn ─────────────────────────────────────────────────────────────────

/**
 * Spawn the active provider's agent process and return a handle for lifecycle management.
 *
 * stdout: NDJSON events (readline), forwarded to event subscribers.
 * stderr: buffered for error capture + auth-failure classification.
 */
export function spawnAgent(opts: SpawnOptions): AgentHandle {
  const provider = getActiveProvider();
  const args = provider.buildWorkerArgs(opts);

  log.info(
    {
      project: opts.project.name,
      mode: opts.mode ?? 'agent',
      resume: opts.project.resumeId ?? 'none',
      model: opts.session.activeModel,
      client: provider.id,
    },
    'spawning agent',
  );
  log.debug({ client: provider.id, args }, 'agent args');

  const agentBin = provider.resolveBin();
  const child = spawn(agentBin, args, {
    cwd: opts.project.path,
    shell: false, // SECURITY: never true
    env: provider.env(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  attachCursorAgentSpawnGuard(child, { project: opts.project.name, mode: opts.mode ?? 'agent', client: provider.id });

  const pid = child.pid;
  if (!pid) {
    throw new Error(`${provider.displayName} agent failed to spawn (no pid) — check the binary is installed and on PATH`);
  }

  const eventListeners: Array<(event: StreamJsonEvent) => void> = [];

  // ── stdout readline parser ─────────────────────────────────────────────

  let capturedSessionId: string | null = null;
  let capturedSummary: string | null = null;

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

  rl.on('line', (raw: string) => {
    // Defensive: strip ANSI escape codes before parsing.
    const clean = stripAnsi(raw).trim();
    if (!clean) return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(clean) as Record<string, unknown>;
    } catch {
      log.debug({ raw: clean }, 'non-JSON line from agent (ignored)');
      return;
    }

    // Capture session_id wherever it appears (system:init or result).
    if (typeof event['session_id'] === 'string') {
      capturedSessionId = event['session_id'];
    }

    // Capture summary from result event (field name varies by CLI version).
    if (event['type'] === 'result') {
      if (typeof event['result'] === 'string' && event['result'].trim()) {
        capturedSummary = event['result'];
      } else {
        const msg = event['message'];
        if (typeof msg === 'string') {
          capturedSummary = msg;
        } else if (
          typeof msg === 'object' &&
          msg !== null &&
          'content' in msg &&
          Array.isArray((msg as { content: unknown[] }).content)
        ) {
          const textPart = (msg as { content: Array<{ text?: string }> }).content.find(
            (c) => typeof c.text === 'string',
          );
          if (textPart?.text) capturedSummary = textPart.text;
        }
      }
    }

    // Fallback: last assistant text turn (stream-json ask/agent).
    if (event['type'] === 'assistant') {
      const msg = event['message'];
      if (
        typeof msg === 'object' &&
        msg !== null &&
        'content' in msg &&
        Array.isArray((msg as { content: unknown[] }).content)
      ) {
        const textPart = (msg as { content: Array<{ text?: string }> }).content.find(
          (c) => typeof c.text === 'string',
        );
        if (textPart?.text?.trim()) capturedSummary = textPart.text;
      }
    }

    // Forward the typed event to all subscribers.
    const typed = event as StreamJsonEvent;
    for (const cb of eventListeners) {
      cb(typed);
    }
  });

  // ── stderr capture ─────────────────────────────────────────────────────

  const stderrChunks: Buffer[] = [];
  child.stderr!.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  // ── Process lifecycle ──────────────────────────────────────────────────

  let killTimer: ReturnType<typeof setTimeout> | null = null;

  function kill(): void {
    log.info({ pid }, 'sending SIGTERM to agent');
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      log.warn({ pid }, 'agent did not exit after SIGTERM — sending SIGKILL');
      child.kill('SIGKILL');
    }, 5000);
  }

  const result: Promise<AgentResult> = new Promise((resolve) => {
    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      rl.close();

      const exitCode = code ?? -1;
      const stderr = stripAnsi(Buffer.concat(stderrChunks).toString('utf-8')).trim();
      const authRequired = exitCode !== 0 && provider.isAuthError(exitCode, stderr);

      if (exitCode !== 0) {
        log.warn({ pid, exitCode, authRequired, stderr: stderr.slice(0, 500) }, 'agent exited with error');
      } else {
        log.info({ pid, sessionId: capturedSessionId }, 'agent completed');
      }

      resolve({
        exitCode,
        sessionId: capturedSessionId,
        summary: capturedSummary,
        error: exitCode !== 0 ? (stderr || `Process exited with code ${exitCode}`) : null,
        authRequired,
      });
    });
  });

  return {
    pid,
    result,
    kill,
    onEvent: (cb) => eventListeners.push(cb),
  };
}

// ── Model list parsing (legacy Cursor-specific helpers — kept for callers
// that inspect Cursor's own output shape directly; new code should use
// getActiveProvider().listModels() / getAbout() instead). ─────────────────

export interface ModelEntry {
  id: string;
  displayName: string;
}

export function parseModelsOutput(raw: string): ModelEntry[] {
  return raw
    .split('\n')
    .map((line) => stripAnsi(line).trim())
    .filter(
      (line) =>
        line.includes(' - ') &&
        !line.startsWith('Tip:') &&
        !line.startsWith('Available models'),
    )
    .map((line) => {
      const dashIdx = line.indexOf(' - ');
      return {
        id: line.slice(0, dashIdx).trim(),
        displayName: line.slice(dashIdx + 3).trim(),
      };
    })
    .filter((m) => m.id.length > 0 && m.displayName.length > 0);
}

export interface AgentAbout {
  cliVersion: string;
  model: string;
  osPlatform: string;
  osArch: string;
}

export function parseAboutJson(raw: string): AgentAbout | null {
  try {
    const parsed = JSON.parse(stripAnsi(raw).trim()) as Partial<AgentAbout>;
    if (!parsed.cliVersion) return null;
    return {
      cliVersion: parsed.cliVersion ?? '',
      model: parsed.model ?? '',
      osPlatform: parsed.osPlatform ?? '',
      osArch: parsed.osArch ?? '',
    };
  } catch {
    return null;
  }
}
