/**
 * Agent executor — spawn, parse, kill. CLI-neutral: delegates every CLI-specific
 * decision (binary path, env, argv, auth-error detection) to the active
 * AgentProvider (src/providers/agents/). This module owns only the shared
 * process lifecycle: spawn, NDJSON stdout parsing, stderr capture, kill.
 *
 * Key design rules from docs/03-security.md and docs/05:
 *   - `shell: false` always — no shell interpolation.
 *   - `--workspace` / `--cd` / cwd come from the registry, never from the caller.
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
import type { SpawnOptions } from '../providers/agents/types.js';
import type { AgentStreamEvent } from '../providers/agents/events.js';

export { AGENT_CLIENTS };
export type { AgentClient, SpawnOptions };

const log = childLogger('executor');

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
  /** Subscribe to normalized agent events (see providers/agents/events.ts). */
  onEvent: (cb: (event: AgentStreamEvent) => void) => void;
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
    // Worktree runs must start inside the worktree: only Cursor takes a
    // worktree flag, so cwd is what keeps Codex/Claude Code off the main tree.
    cwd: opts.worktree ?? opts.project.path,
    shell: false, // SECURITY: never true
    env: provider.env(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  attachCursorAgentSpawnGuard(child, { project: opts.project.name, mode: opts.mode ?? 'agent', client: provider.id });

  const pid = child.pid;
  if (!pid) {
    throw new Error(`${provider.displayName} agent failed to spawn (no pid) — check the binary is installed and on PATH`);
  }

  const eventListeners: Array<(event: AgentStreamEvent) => void> = [];

  // ── stdout readline parser ─────────────────────────────────────────────
  //
  // Raw NDJSON is handed straight to the provider: each CLI speaks its own
  // dialect and only the provider knows how to read it. Everything below works
  // on normalized events, so session capture and narration behave identically
  // for Cursor, Codex and Claude Code.

  let capturedSessionId: string | null = null;
  let capturedSummary: string | null = null;

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

  rl.on('line', (raw: string) => {
    // Defensive: strip ANSI escape codes before parsing.
    const clean = stripAnsi(raw).trim();
    if (!clean) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(clean) as Record<string, unknown>;
    } catch {
      log.debug({ raw: clean.slice(0, 200) }, 'non-JSON line from agent (ignored)');
      return;
    }

    let events: AgentStreamEvent[];
    try {
      events = provider.parseStreamEvent(parsed);
    } catch (err) {
      log.warn({ err, client: provider.id }, 'provider failed to parse stream event');
      return;
    }

    for (const event of events) {
      if (event.kind === 'session') {
        capturedSessionId = event.sessionId;
      } else if (event.kind === 'result' && event.text) {
        capturedSummary = event.text;
      } else if (event.kind === 'assistant_text') {
        // Fallback summary: the last thing the agent actually said.
        capturedSummary = event.text;
      }

      for (const cb of eventListeners) {
        cb(event);
      }
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
