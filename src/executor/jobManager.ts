/**
 * Job Manager — the bridge between MCP execute tools and the executor layer.
 *
 * Responsibilities:
 *   - Enforce concurrency cap (from config.settings.maxConcurrentJobs).
 *   - Take git checkpoint before each submit.
 *   - Create job DB row, spawn the active agent CLI, wire watcher + narrator.
 *   - Apply per-job timeout; kill + mark error on expiry.
 *   - Persist resume_id from the run's session_id on completion.
 *   - Keep in-memory map of active handles (cleared on completion).
 */

import { spawnAgent } from './agentProcess.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import {
  assertAgentAvailable,
  getActiveAgentActivity,
  getActiveAgentRun,
  registerAgentRun,
  releaseAgentRun,
  registerWorktreeAgent,
  releaseWorktreeAgent,
  killWorktreeAgent,
} from './agentSingleton.js';
import { Watcher } from './watcher.js';
import { getNarrator } from './narrator.js';
import { emitVoiceToolActivity } from '../realtime/voiceUiEvents.js';
import { checkpoint } from './git.js';
import { createJob, updateJob, getJob, type JobMode, type JobStatus } from '../state/jobs.js';
import type { Job } from '../state/jobs.js';
import { getDb } from '../state/db.js';
import { setProjectResumeId, getSessionState, type Project } from '../state/registry.js';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';
import type { AgentHandle } from './agentProcess.js';
import { notifyAuthRequired } from '../providers/agents/authNotify.js';

const log = childLogger('job-manager');

// ── In-memory active handles ──────────────────────────────────────────────

interface ActiveJob {
  handle: AgentHandle;
  watcher: Watcher;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

const activeJobs = new Map<string, ActiveJob>();
/** Voice/control session key → currently running job id (for status/stop without job_id). */
const sessionActiveJobs = new Map<string, string>();
/** Monotonic start time for grace-period checks (Nova parallel tool calls). */
const jobStartedAtMs = new Map<string, number>();

/** How long a job must run before agent_job_stop is honored (blocks parallel stop spam). */
export const JOB_STOP_GRACE_MS = 15_000;

/** Number of currently running jobs. */
export function getActiveJobCount(): number {
  return activeJobs.size;
}

/** Resolve the running job id for a voice session, if any. */
export function getActiveJobIdForSession(sessionKey: string): string | null {
  const jobId = sessionActiveJobs.get(sessionKey);
  if (!jobId || !activeJobs.has(jobId)) return null;
  return jobId;
}

/** Live activity summary for the session's running job (for agent_job_status intel). */
export function getActiveJobActivity(sessionKey: string): string | null {
  const jobId = getActiveJobIdForSession(sessionKey);
  if (!jobId) return null;
  const summary = activeJobs.get(jobId)?.watcher.getActivitySummary() ?? null;
  if (!summary) return null;
  const age = getJobRunAgeMs(jobId);
  return age !== null ? `${summary} (${Math.round(age / 1000)}s elapsed)` : summary;
}

/** Live activity for agent_ask or agent_submit. */
export function getActiveAgentJobActivity(sessionKey: string): string | null {
  const fromAsk = getActiveAgentRun();
  if (fromAsk?.sessionKey === sessionKey && fromAsk.kind === 'ask') {
    return getActiveAgentActivity();
  }
  return getActiveJobActivity(sessionKey);
}

// ── Submit ────────────────────────────────────────────────────────────────

export interface SubmitResult {
  jobId: string;
  project: string;
  sessionId: string | null;
  model: string;
  status: 'running';
  worktree?: string;
}

// ── Active job snapshots ──────────────────────────────────────────────────

export interface ActiveJobSummary {
  jobId: string;
  project: string;
  mode: string;
  prompt: string;
  pid: number;
  elapsedMs: number;
  activity: string | null;
  worktree?: string;
}

/** Snapshot of all currently running jobs (singleton + worktree pool). */
export function getAllActiveJobSummaries(): ActiveJobSummary[] {
  const result: ActiveJobSummary[] = [];
  for (const [jobId, aj] of activeJobs.entries()) {
    const job = getJob(jobId);
    const elapsedMs = getJobRunAgeMs(jobId) ?? 0;
    result.push({
      jobId,
      project: job?.project ?? 'unknown',
      mode: job?.mode ?? 'agent',
      prompt: (job?.prompt ?? '').slice(0, 100),
      pid: aj.handle.pid,
      elapsedMs,
      activity: aj.watcher.getActivitySummary(),
    });
  }
  return result;
}

// ── Job history ───────────────────────────────────────────────────────────

/**
 * Fetch recent jobs for a project.
 * statusFilter='all' returns jobs of any status; otherwise filters to that status.
 * Used by `list_jobs_history` in the MCP server.
 */
export function getJobsHistory(
  projectName: string | undefined,
  limit = 10,
  statusFilter: 'all' | 'done' | 'error' | 'stopped' = 'all',
): Job[] {
  type JobRow = {
    id: string;
    project: string;
    prompt: string;
    mode: string;
    status: string;
    pid: number | null;
    session_id: string | null;
    checkpoint: string | null;
    summary: string | null;
    diffstat: string | null;
    error: string | null;
    started_at: string;
    finished_at: string | null;
  };

  let rows: JobRow[];

  if (projectName && statusFilter !== 'all') {
    rows = getDb()
      .prepare(
        `SELECT * FROM job WHERE project = @project AND status = @status
         ORDER BY started_at DESC LIMIT @limit`,
      )
      .all({ project: projectName, status: statusFilter, limit }) as JobRow[];
  } else if (projectName) {
    rows = getDb()
      .prepare(`SELECT * FROM job WHERE project = @project ORDER BY started_at DESC LIMIT @limit`)
      .all({ project: projectName, limit }) as JobRow[];
  } else if (statusFilter !== 'all') {
    rows = getDb()
      .prepare(`SELECT * FROM job WHERE status = @status ORDER BY started_at DESC LIMIT @limit`)
      .all({ status: statusFilter, limit }) as JobRow[];
  } else {
    rows = getDb()
      .prepare(`SELECT * FROM job ORDER BY started_at DESC LIMIT @limit`)
      .all({ limit }) as JobRow[];
  }

  return rows.map((r) => ({
    id: r.id,
    project: r.project,
    prompt: r.prompt,
    mode: r.mode as JobMode,
    status: r.status as JobStatus,
    pid: r.pid,
    sessionId: r.session_id,
    checkpoint: r.checkpoint,
    summary: r.summary,
    diffstat: r.diffstat,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }));
}

/**
 * Submit a new worker job on the active agent CLI.
 * Returns immediately with a job_id; the job runs asynchronously.
 * Track progress with agent_job_status(job_id).
 *
 * Pass `worktree` to run in an isolated git worktree — bypasses the singleton
 * gate so multiple agents can run in parallel on separate worktrees.
 */
export async function submitJob(
  project: Project,
  sessionKey: string,
  prompt: string,
  mode: JobMode = 'agent',
  worktree?: string,
  browser?: boolean,
): Promise<SubmitResult> {
  const { settings } = getConfig();
  const session = getSessionState(sessionKey);
  assertModeSupported(mode);

  // Enforce global concurrency cap.
  if (activeJobs.size >= settings.maxConcurrentJobs) {
    throw new Error(
      `Concurrency limit reached (${settings.maxConcurrentJobs} job${settings.maxConcurrentJobs !== 1 ? 's' : ''} running). ` +
        'Wait for a job to finish or use stop_agent, or increase maxConcurrentJobs in config.',
    );
  }

  // Worktree agents bypass the singleton gate (each runs in an isolated tree).
  // Non-worktree agents still use the singleton to avoid working-tree conflicts.
  if (!worktree) {
    assertAgentAvailable();
  }

  // Git checkpoint — record HEAD before any writes.
  let checkpointSha: string | null = null;
  try {
    const cp = await checkpoint(project.path);
    checkpointSha = cp.sha;
  } catch (err) {
    log.warn({ project: project.name, err }, 'git checkpoint failed (project may not be a git repo)');
  }

  // Create job row in DB.
  const jobId = createJob({
    project: project.name,
    prompt,
    mode,
    checkpoint: checkpointSha ?? undefined,
  });

  // Spawn the agent process (with optional worktree for parallel execution).
  const handle = spawnAgent({ project, session, prompt, mode, worktree, browser });

  // Wire watcher → narrator.
  const watcher = new Watcher(jobId, project.name, () => {
    if (!settings.ghostKillEnabled) return;
    if (!activeJobs.has(jobId)) return;
    log.warn({ jobId, project: project.name }, 'ghost kill — terminating agent');
    stopJob(jobId, 'Stopped: agent tried to spawn subagents (budget protection)', 'error');
  });
  const narrator = getNarrator();
  watcher.onNarration((evt) => void narrator.receive(evt));
  handle.onEvent((evt) => watcher.process(evt));

  if (worktree) {
    registerWorktreeAgent({ refId: jobId, worktreeName: worktree, sessionKey, handle, watcher });
  } else {
    registerAgentRun({ kind: 'job', refId: jobId, sessionKey, handle, watcher });
  }
  updateJob(jobId, { pid: handle.pid });

  sessionActiveJobs.set(sessionKey, jobId);

  // Per-job timeout.
  const timeoutTimer = setTimeout(() => {
    if (activeJobs.has(jobId)) {
      log.warn({ jobId, timeoutMs: settings.jobTimeoutMs }, 'job timed out — killing');
      handle.kill();
      updateJob(jobId, {
        status: 'error',
        error: `Job timed out after ${settings.jobTimeoutMs / 1000}s`,
        finishedAt: new Date().toISOString(),
      });
      watcher.destroy();
      activeJobs.delete(jobId);
      jobStartedAtMs.delete(jobId);
      releaseAgentRun(handle);
      if (sessionActiveJobs.get(sessionKey) === jobId) {
        sessionActiveJobs.delete(sessionKey);
      }
    }
  }, settings.jobTimeoutMs);

  activeJobs.set(jobId, { handle, watcher, timeoutTimer });
  jobStartedAtMs.set(jobId, Date.now());

  // Completion handler — runs in the background.
  void handle.result.then((result) => {
    clearTimeout(timeoutTimer);
    watcher.destroy();
    activeJobs.delete(jobId);
    jobStartedAtMs.delete(jobId);
    if (worktree) {
      releaseWorktreeAgent(jobId);
    } else {
      releaseAgentRun(handle);
    }
    if (sessionActiveJobs.get(sessionKey) === jobId) {
      sessionActiveJobs.delete(sessionKey);
    }

    const existing = getJob(jobId);
    if (existing?.finishedAt) {
      log.debug({ jobId }, 'job already finalized — skipping completion update');
      return;
    }

    updateJob(jobId, {
      status: result.exitCode === 0 ? 'done' : 'error',
      sessionId: result.sessionId,
      summary: result.summary,
      error: result.error,
      finishedAt: new Date().toISOString(),
    });

    if (result.sessionId) {
      setProjectResumeId(project.name, result.sessionId);
      log.info({ jobId, project: project.name, sessionId: result.sessionId }, 'resume id persisted');
    }

    if (result.authRequired) {
      void notifyAuthRequired(`job ${jobId} on ${project.name}`);
    }
  });

  log.info(
    { jobId, project: project.name, mode, pid: handle.pid, worktree: worktree ?? null },
    'job submitted',
  );

  return {
    jobId,
    project: project.name,
    sessionId: null, // not yet known — check agent_job_status
    model: session.activeModel,
    status: 'running',
    ...(worktree ? { worktree } : {}),
  };
}

/** Milliseconds since the job process started, or null if not active. */
export function getJobRunAgeMs(jobId: string): number | null {
  const started = jobStartedAtMs.get(jobId);
  return started !== undefined ? Date.now() - started : null;
}

// ── Stop ──────────────────────────────────────────────────────────────────

/**
 * Kill a running job. Noop if the job is not in the active handle map
 * (already finished or belongs to a previous bridge process).
 */
export function stopJob(
  jobId: string,
  reason = 'Stopped by user',
  status: 'stopped' | 'error' = 'stopped',
): boolean {
  const active = activeJobs.get(jobId);
  if (!active) {
    // Job row may exist but singleton still holds ask — try global kill for ask-only edge case.
    return false;
  }

  clearTimeout(active.timeoutTimer);
  active.handle.kill();
  active.watcher.destroy();
  activeJobs.delete(jobId);
  jobStartedAtMs.delete(jobId);
  // Release from the worktree pool if it's a worktree job, otherwise the singleton.
  killWorktreeAgent(jobId, reason);
  releaseAgentRun(active.handle);

  for (const [sessionKey, id] of sessionActiveJobs.entries()) {
    if (id === jobId) sessionActiveJobs.delete(sessionKey);
  }

  updateJob(jobId, {
    status,
    error: reason,
    finishedAt: new Date().toISOString(),
  });

  log.info({ jobId, reason, status }, 'job stopped');
  return true;
}

// ── agent_ask (one-shot, synchronous) ────────────────────────────────────

/**
 * Refuse a mode the active CLI cannot actually enforce.
 *
 * `ask` must be read-only. Codex enforces it with `--sandbox read-only` and
 * Claude Code with plan mode; a CLI that can do neither would run a *writing*
 * agent under a read-only-sounding tool name, so it is refused outright rather
 * than silently downgraded.
 */
function assertModeSupported(mode: JobMode): void {
  const provider = getActiveProvider();
  if (provider.supportedModes().includes(mode)) return;
  throw new Error(
    `${provider.displayName} cannot enforce "${mode}" mode — it supports ${provider
      .supportedModes()
      .join(', ')}. Switch the agent client in Config, or use a mode it supports.`,
  );
}

/**
 * Run the active agent CLI in ask (read-only) mode and wait for the answer.
 * Shares the global agent singleton with submit jobs.
 */
export async function askQuestion(
  project: Project,
  sessionKey: string,
  question: string,
): Promise<string> {
  assertModeSupported('ask');
  assertAgentAvailable();

  const session = getSessionState(sessionKey);

  const handle = spawnAgent({
    project,
    session,
    prompt: question,
    mode: 'ask',
    oneShot: false, // stream-json — full multi-tool research runs to completion
  });

  log.info(
    { project: project.name, sessionKey, question: question.slice(0, 120), pid: handle.pid },
    'agent_ask started (headless CLI run — fresh session, not the IDE sidebar)',
  );

  const watcher = new Watcher('ask', project.name, undefined, false);
  handle.onEvent((evt) => watcher.process(evt));
  registerAgentRun({ kind: 'ask', refId: 'ask', sessionKey, handle, watcher });

  emitVoiceToolActivity({
    tool: 'agent_ask',
    phase: 'start',
    label: `${getActiveProvider().displayName} running (pid ${handle.pid}) — researching repo…`,
    detail: question.slice(0, 120),
  });

  try {
    const result = await handle.result;

    if (result.exitCode !== 0) {
      if (result.authRequired) {
        void notifyAuthRequired(`agent_ask on ${project.name}`);
      }
      throw new Error(
        result.error ?? `${getActiveProvider().displayName} exited with code ${result.exitCode}`,
      );
    }

    const answer = result.summary ?? `No answer returned from ${getActiveProvider().displayName}.`;
    log.info(
      { project: project.name, sessionKey, answerLen: answer.length },
      'agent_ask completed',
    );
    return answer;
  } finally {
    releaseAgentRun(handle);
  }
}

// ── Model list ────────────────────────────────────────────────────────────
//
// Live model fetching now lives on each AgentProvider (listModels()) — see
// src/providers/agents/*.ts and src/mcp/tools/model.ts. This module only
// spawns/tracks jobs; it no longer shells out to a hardcoded CLI for models.
