/**
 * Job tools — agent_job_status, agent_job_stop
 *
 * Backed by SQLite job rows + in-memory job handles.
 */

import { getJob, getJobEvents } from '../../state/jobs.js';
import {
  getActiveAgentJobActivity,
  getActiveJobIdForSession,
  getJobRunAgeMs,
  JOB_STOP_GRACE_MS,
  stopJob,
} from '../../executor/jobManager.js';
import { getActiveAgentRun } from '../../executor/agentSingleton.js';
import { getSessionState } from '../../state/registry.js';
import { childLogger } from '../../log.js';

const log = childLogger('tool:job');

// ── agent_job_status ─────────────────────────────────────────────────────────

export interface StatusArgs {
  job_id?: string;
}

export interface ProgressEntry {
  ts: string;
  kind: string;
  text: string | null;
}

export interface StatusResult {
  job_id: string;
  status: string;
  project: string;
  model: string | null;
  session_id: string | null;
  summary: string | null;
  /** What Cursor is doing right now (live, for running jobs). */
  activity: string | null;
  /** Headless cursor-agent process id when running. */
  cli_pid?: number | null;
  diffstat: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  progress: ProgressEntry[];
  /** True when returned from cache — do not speak aloud again. */
  rate_limited?: boolean;
}

function resolveJobId(args: StatusArgs, sessionKey: string): string | null {
  return args.job_id ?? getActiveJobIdForSession(sessionKey);
}

function syntheticStatus(status: string, activity: string): StatusResult {
  return {
    job_id: '',
    status,
    project: '',
    model: null,
    session_id: null,
    summary: null,
    activity,
    diffstat: null,
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    progress: [],
  };
}

const STATUS_MIN_INTERVAL_MS = 20_000;
const lastStatusBySession = new Map<string, { at: number; result: StatusResult }>();

export function handleCursorStatus(args: StatusArgs, sessionKey: string): StatusResult {
  const active = getActiveAgentRun();
  if (active?.kind === 'ask' && active.sessionKey === sessionKey) {
    const cached = lastStatusBySession.get(sessionKey);
    if (cached && Date.now() - cached.at < STATUS_MIN_INTERVAL_MS) {
      return {
        ...cached.result,
        activity:
          `${cached.result.activity ?? 'Still researching.'} ` +
          `(checked ${Math.round((Date.now() - cached.at) / 1000)}s ago — wait before calling again)`,
        rate_limited: true,
      };
    }
    const session = getSessionState(sessionKey);
    const activity =
      getActiveAgentJobActivity(sessionKey) ?? 'Cursor is researching your question.';
    const progress = (active.watcher?.getRecentProgress() ?? []).map((e) => ({
      ts: e.ts,
      kind: e.kind,
      text: e.text,
    }));
    const result: StatusResult = {
      job_id: 'ask',
      status: 'asking',
      project: session.activeProject ?? '',
      model: session.activeModel,
      session_id: null,
      summary: null,
      activity,
      cli_pid: active.pid,
      diffstat: null,
      error: null,
      started_at:
        active.watcher?.getSummary().startedAt.toISOString() ?? new Date().toISOString(),
      finished_at: null,
      progress,
    };
    lastStatusBySession.set(sessionKey, { at: Date.now(), result });
    return result;
  }

  const jobId = resolveJobId(args, sessionKey);
  if (!jobId) {
    return syntheticStatus(
      'idle',
      'Nothing is running. agent_ask and agent_submit both report live progress while active.',
    );
  }
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job "${jobId}" not found.`);
  }

  const events = getJobEvents(jobId);
  const progress: ProgressEntry[] = events.map((e) => {
    let text: string | null = null;
    if (e.payload) {
      try {
        const parsed = JSON.parse(e.payload) as Record<string, unknown>;
        text =
          typeof parsed['text'] === 'string'
            ? parsed['text']
            : typeof parsed['summary'] === 'string'
              ? parsed['summary']
              : typeof parsed['path'] === 'string'
                ? parsed['path']
                : e.payload;
      } catch {
        text = e.payload;
      }
    }
    return { ts: e.ts, kind: e.kind, text };
  });

  const activity =
    job.status === 'running' ? getActiveAgentJobActivity(sessionKey) : null;

  return {
    job_id: job.id,
    status: job.status,
    project: job.project,
    model: job.sessionId ? null : null,
    session_id: job.sessionId,
    summary: job.summary,
    activity,
    diffstat: job.diffstat,
    error: job.error,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    progress,
  };
}

// ── agent_job_stop ───────────────────────────────────────────────────────────

export interface StopArgs {
  job_id?: string;
}

export interface StopResult {
  status: 'stopped' | 'not_running';
  job_id: string;
  message: string;
}

export function handleCursorStop(args: StopArgs, sessionKey: string): StopResult {
  const jobId = args.job_id ?? getActiveJobIdForSession(sessionKey);

  if (jobId) {
    const job = getJob(jobId);
    if (!job) {
      throw new Error(`Job "${jobId}" not found.`);
    }

    if (job.status !== 'running') {
      return {
        status: 'not_running',
        job_id: jobId,
        message: `Job is not running (status: ${job.status}).`,
      };
    }

    const runAgeMs = getJobRunAgeMs(jobId);
    if (runAgeMs !== null && runAgeMs < JOB_STOP_GRACE_MS) {
      return {
        status: 'not_running',
        job_id: jobId,
        message:
          `Job started ${Math.round(runAgeMs / 1000)}s ago — not cancelled. ` +
          'The wake phrase "cursor stop" is NOT agent_job_stop. ' +
          'Wait for the job or ask the user to explicitly say "cancel the job".',
      };
    }

    const stopped = stopJob(jobId);
    if (stopped) {
      log.info({ jobId, sessionKey }, 'agent_job_stop invoked — job killed');
    }
    return {
      status: stopped ? 'stopped' : 'not_running',
      job_id: jobId,
      message: stopped ? 'Job stopped.' : 'Job was already finished.',
    };
  }

  const active = getActiveAgentRun();
  if (active?.kind === 'ask') {
    return {
      status: 'not_running',
      job_id: 'ask',
      message:
        'A read-only question is in progress — wait for the answer. ' +
        'agent_job_stop only cancels background jobs from agent_submit, not agent_ask.',
    };
  }

  throw new Error('No active job to stop.');
}
