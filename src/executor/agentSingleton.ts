/**
 * cursor-agent process registry.
 *
 * Tracks two categories of workers:
 *   - Singleton (active): the primary worker agent for the current session.
 *     At most one at a time; agent_ask and agent_submit share this slot.
 *   - Worktree pool: additional parallel agents running in isolated git worktrees.
 *     No concurrency limit beyond maxConcurrentJobs; each uses a separate tree.
 *
 * Voice agent (src/executor/voiceAgent.ts) is tracked separately and is always
 * excluded from these lists — use getActiveVoiceAgent() for the voice loop.
 */

import { childLogger } from '../log.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import type { AgentHandle } from './agentProcess.js';
import type { Watcher } from './watcher.js';

const log = childLogger('agent-singleton');

export type AgentRunKind = 'ask' | 'job' | 'worktree';

export interface ActiveAgentRun {
  kind: AgentRunKind;
  /** Job UUID or literal "ask". */
  refId: string;
  sessionKey: string;
  pid: number;
  handle: AgentHandle;
  /** Live stream watcher (agent_ask and agent_submit). */
  watcher?: Watcher;
  /** Worktree name, if this is a worktree worker. */
  worktreeName?: string;
  startedAt: Date;
}

// ── Singleton (primary worker) ────────────────────────────────────────────

let active: ActiveAgentRun | null = null;

export function getActiveAgentRun(): Readonly<ActiveAgentRun> | null {
  return active;
}

/** Human-readable snapshot of what cursor-agent is doing right now, if any. */
export function getActiveAgentActivity(): string | null {
  if (!active?.watcher) return null;
  const summary = active.watcher.getSummary();
  const elapsedSec = Math.round((Date.now() - summary.startedAt.getTime()) / 1000);
  return `${active.watcher.getActivitySummary()} (${elapsedSec}s elapsed)`;
}

export function isAgentBusy(): boolean {
  return active !== null;
}

/** Throw if a cursor-agent process is already running. Call before spawnAgent. */
export function assertAgentAvailable(): void {
  if (!active) return;
  const label = active.kind === 'ask' ? 'answering a question' : 'running a job';
  const hint =
    active.kind === 'ask'
      ? 'Wait for the answer — use agent_job_status for live progress; do not retry agent_ask.'
      : 'Wait for it to finish or call stop_agent, or use spawn_agent with use_worktree: true to run in parallel.';
  throw new Error(`${getActiveProvider().displayName} is already busy (${label}, pid ${active.pid}). ${hint}`);
}

/** Claim the singleton immediately after spawnAgent (before any await). */
export function registerAgentRun(params: {
  kind: AgentRunKind;
  refId: string;
  sessionKey: string;
  handle: AgentHandle;
  watcher?: Watcher;
}): void {
  if (active) {
    throw new Error('Agent singleton race — slot already held');
  }
  active = {
    kind: params.kind,
    refId: params.refId,
    sessionKey: params.sessionKey,
    pid: params.handle.pid,
    handle: params.handle,
    watcher: params.watcher,
    startedAt: new Date(),
  };
  log.info(
    { kind: params.kind, refId: params.refId, pid: params.handle.pid },
    'agent slot acquired',
  );
}

export function releaseAgentRun(handle: AgentHandle): void {
  if (active?.handle !== handle) return;
  active.watcher?.destroy();
  log.info({ kind: active.kind, refId: active.refId, pid: active.pid }, 'agent slot released');
  active = null;
}

/** Kill whatever is running and clear the slot (agent_job_stop / shutdown). */
export function killActiveAgent(reason: string): boolean {
  if (!active) return false;
  const { pid, kind, refId } = active;
  log.warn({ pid, kind, refId, reason }, 'killing active cursor-agent');
  active.watcher?.destroy();
  active.handle.kill();
  active = null;
  return true;
}

// ── Worktree worker pool (parallel agents) ────────────────────────────────

/** jobId → ActiveAgentRun for worktree-isolated parallel workers. */
const worktreePool = new Map<string, ActiveAgentRun>();

/** Register a worktree worker. Multiple can run concurrently. */
export function registerWorktreeAgent(params: {
  refId: string;
  worktreeName: string;
  sessionKey: string;
  handle: AgentHandle;
  watcher?: Watcher;
}): void {
  const run: ActiveAgentRun = {
    kind: 'worktree',
    refId: params.refId,
    sessionKey: params.sessionKey,
    pid: params.handle.pid,
    handle: params.handle,
    watcher: params.watcher,
    worktreeName: params.worktreeName,
    startedAt: new Date(),
  };
  worktreePool.set(params.refId, run);
  log.info(
    { refId: params.refId, worktree: params.worktreeName, pid: params.handle.pid },
    'worktree agent registered',
  );
}

/** Release a worktree worker (called on completion or stop). */
export function releaseWorktreeAgent(refId: string): void {
  const run = worktreePool.get(refId);
  if (!run) return;
  run.watcher?.destroy();
  worktreePool.delete(refId);
  log.info({ refId, worktree: run.worktreeName, pid: run.pid }, 'worktree agent released');
}

/** Kill a worktree worker by job ID. Returns false if not found. */
export function killWorktreeAgent(refId: string, reason: string): boolean {
  const run = worktreePool.get(refId);
  if (!run) return false;
  log.warn({ refId, worktree: run.worktreeName, pid: run.pid, reason }, 'killing worktree agent');
  run.watcher?.destroy();
  run.handle.kill();
  worktreePool.delete(refId);
  return true;
}

/** Number of worktree agents currently running. */
export function getWorktreeAgentCount(): number {
  return worktreePool.size;
}

// ── Combined view ─────────────────────────────────────────────────────────

/**
 * Return all currently running worker agents (singleton + all worktree workers).
 * Excludes the voice agent — call getActiveVoiceAgent() for that.
 */
export function getAllActiveRuns(): ReadonlyArray<Readonly<ActiveAgentRun>> {
  const result: ActiveAgentRun[] = [];
  if (active) result.push(active);
  for (const run of worktreePool.values()) {
    result.push(run);
  }
  return result;
}
