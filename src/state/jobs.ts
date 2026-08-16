/**
 * Job state management helpers.
 *
 * One row per cursor_submit invocation. Job events are the streaming progress
 * records used for narration and cursor_status responses.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { childLogger } from '../log.js';

const log = childLogger('jobs');

// ── Types ─────────────────────────────────────────────────────────────────────

export type JobStatus = 'running' | 'done' | 'error' | 'stopped';
export type JobMode = 'agent' | 'plan' | 'ask';
export type JobEventKind =
  | 'job_started'
  | 'file_write'
  | 'file_read'
  | 'shell_run'
  | 'progress_tick'
  | 'job_done'
  | 'job_error'
  | 'ghost_killed'
  | 'system_init'
  | 'raw';

export interface Job {
  id: string;
  project: string;
  prompt: string;
  mode: JobMode;
  status: JobStatus;
  pid: number | null;
  sessionId: string | null;
  checkpoint: string | null;
  summary: string | null;
  diffstat: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface JobEvent {
  id: number;
  jobId: string;
  ts: string;
  kind: JobEventKind;
  payload: string | null;
}

// ── Row mapping ───────────────────────────────────────────────────────────────

interface JobRow {
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
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    project: row.project,
    prompt: row.prompt,
    mode: row.mode as JobMode,
    status: row.status as JobStatus,
    pid: row.pid,
    sessionId: row.session_id,
    checkpoint: row.checkpoint,
    summary: row.summary,
    diffstat: row.diffstat,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/** Create a new job row (status = running). Returns the job id. */
export function createJob(params: {
  project: string;
  prompt: string;
  mode: JobMode;
  pid?: number;
  checkpoint?: string;
}): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO job (id, project, prompt, mode, status, pid, checkpoint)
       VALUES (@id, @project, @prompt, @mode, 'running', @pid, @checkpoint)`,
    )
    .run({
      id,
      project: params.project,
      prompt: params.prompt,
      mode: params.mode,
      pid: params.pid ?? null,
      checkpoint: params.checkpoint ?? null,
    });
  log.debug({ jobId: id, project: params.project, mode: params.mode }, 'job created');
  return id;
}

/** Fetch a job by ID. Returns null if not found. */
export function getJob(id: string): Job | null {
  const row = getDb().prepare('SELECT * FROM job WHERE id = ?').get(id) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

/** Update mutable fields on a job. Undefined fields are not touched. */
export function updateJob(
  id: string,
  patch: Partial<{
    status: JobStatus;
    pid: number | null;
    sessionId: string | null;
    checkpoint: string | null;
    summary: string | null;
    diffstat: string | null;
    error: string | null;
    finishedAt: string | null;
  }>,
): void {
  const sets: string[] = [];
  const values: Record<string, unknown> = { id };

  if (patch.status !== undefined) {
    sets.push('status = @status');
    values['status'] = patch.status;
  }
  if (patch.pid !== undefined) {
    sets.push('pid = @pid');
    values['pid'] = patch.pid;
  }
  if (patch.sessionId !== undefined) {
    sets.push('session_id = @sessionId');
    values['sessionId'] = patch.sessionId;
  }
  if (patch.checkpoint !== undefined) {
    sets.push('checkpoint = @checkpoint');
    values['checkpoint'] = patch.checkpoint;
  }
  if (patch.summary !== undefined) {
    sets.push('summary = @summary');
    values['summary'] = patch.summary;
  }
  if (patch.diffstat !== undefined) {
    sets.push('diffstat = @diffstat');
    values['diffstat'] = patch.diffstat;
  }
  if (patch.error !== undefined) {
    sets.push('error = @error');
    values['error'] = patch.error;
  }
  if (patch.finishedAt !== undefined) {
    sets.push('finished_at = @finishedAt');
    values['finishedAt'] = patch.finishedAt;
  }

  if (sets.length === 0) return;

  getDb()
    .prepare(`UPDATE job SET ${sets.join(', ')} WHERE id = @id`)
    .run(values);
}

/** Mark all `running` jobs as `error` — called on bridge startup to reap orphans. */
export function markOrphanedJobs(): number {
  const result = getDb()
    .prepare(
      `UPDATE job SET
         status = 'error',
         error  = 'Bridge restarted — process lost',
         finished_at = datetime('now')
       WHERE status = 'running'`,
    )
    .run();
  if (result.changes > 0) {
    log.warn({ count: result.changes }, 'marked orphaned running jobs as error');
  }
  return result.changes;
}

// ── Job events ────────────────────────────────────────────────────────────────

/** Append a progress event for a job. */
export function addJobEvent(jobId: string, kind: JobEventKind, payload?: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO job_event (job_id, kind, payload) VALUES (@jobId, @kind, @payload)`,
    )
    .run({
      jobId,
      kind,
      payload: payload !== undefined ? JSON.stringify(payload) : null,
    });
}

/** Fetch all events for a job, ordered by insertion time. */
export function getJobEvents(jobId: string): JobEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM job_event WHERE job_id = ? ORDER BY id ASC')
    .all(jobId) as { id: number; job_id: string; ts: string; kind: string; payload: string | null }[];

  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    ts: r.ts,
    kind: r.kind as JobEventKind,
    payload: r.payload,
  }));
}

/** Return the most recent job for a project (any status). */
export function getLatestJobForProject(projectName: string): Job | null {
  const row = getDb()
    .prepare(
      'SELECT * FROM job WHERE project = ? ORDER BY started_at DESC LIMIT 1',
    )
    .get(projectName) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export interface CursorSessionSummary {
  sessionId: string;
  lastPrompt: string;
  lastStatus: JobStatus;
  lastRunAt: string;
  jobCount: number;
}

/**
 * Distinct cursor-agent session threads for a project (from job.session_id).
 * Newest activity first. Used by the Voice tab session picker.
 */
export function listCursorSessionsForProject(
  projectName: string,
  limit = 40,
): CursorSessionSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT
         j.session_id AS session_id,
         MAX(j.started_at) AS last_run_at,
         COUNT(*) AS job_count,
         (
           SELECT prompt FROM job j2
           WHERE j2.project = j.project AND j2.session_id = j.session_id
           ORDER BY j2.started_at DESC LIMIT 1
         ) AS last_prompt,
         (
           SELECT status FROM job j2
           WHERE j2.project = j.project AND j2.session_id = j.session_id
           ORDER BY j2.started_at DESC LIMIT 1
         ) AS last_status
       FROM job j
       WHERE j.project = @project
         AND j.session_id IS NOT NULL
         AND TRIM(j.session_id) != ''
       GROUP BY j.session_id
       ORDER BY last_run_at DESC
       LIMIT @limit`,
    )
    .all({ project: projectName, limit }) as {
      session_id: string;
      last_run_at: string;
      job_count: number;
      last_prompt: string;
      last_status: string;
    }[];

  return rows.map((r) => ({
    sessionId: r.session_id,
    lastPrompt: r.last_prompt,
    lastStatus: r.last_status as JobStatus,
    lastRunAt: r.last_run_at,
    jobCount: r.job_count,
  }));
}

export type SessionLogLevel = 'info' | 'warn' | 'error';

export interface SessionLogLine {
  at: string;
  level: SessionLogLevel;
  summary: string;
  detail?: string;
}

function formatJobEventLine(
  kind: JobEventKind,
  payload: string | null,
  jobPrompt: string,
): { level: SessionLogLevel; summary: string; detail?: string } | null {
  let parsed: Record<string, unknown> = {};
  if (payload) {
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      parsed = { raw: payload };
    }
  }

  switch (kind) {
    case 'job_started':
      return { level: 'info', summary: 'Job started', detail: jobPrompt.slice(0, 200) };
    case 'file_write': {
      const path = String(parsed['path'] ?? parsed['file'] ?? 'file');
      return { level: 'info', summary: `Wrote ${path}` };
    }
    case 'file_read': {
      const path = String(parsed['path'] ?? parsed['file'] ?? 'file');
      return { level: 'info', summary: `Read ${path}` };
    }
    case 'shell_run': {
      const cmd = String(parsed['command'] ?? parsed['cmd'] ?? parsed['shell'] ?? 'command');
      return { level: 'info', summary: `Ran ${cmd.slice(0, 120)}` };
    }
    case 'progress_tick': {
      const text = String(parsed['text'] ?? parsed['message'] ?? '');
      return text ? { level: 'info', summary: text.slice(0, 200) } : null;
    }
    case 'job_done':
      return { level: 'info', summary: 'Job finished' };
    case 'job_error': {
      const err = String(parsed['message'] ?? parsed['error'] ?? 'Job failed');
      return { level: 'error', summary: err.slice(0, 200) };
    }
    case 'ghost_killed':
      return { level: 'warn', summary: 'Ghost agent killed' };
    case 'system_init':
      return { level: 'info', summary: 'Cursor session initialized' };
    case 'raw':
      return payload
        ? { level: 'info', summary: payload.slice(0, 200) }
        : null;
    default: {
      const label = String(kind).replace(/_/g, ' ');
      return { level: 'info', summary: label };
    }
  }
}

/**
 * Persisted job_event history for a cursor session thread (newest jobs first, events chronological).
 * Used by the Voice tab when the user selects an existing session.
 */
export function listSessionEventLog(
  projectName: string,
  sessionId: string,
  limit = 500,
): SessionLogLine[] {
  const rows = getDb()
    .prepare(
      `SELECT
         j.prompt AS job_prompt,
         j.started_at AS job_started_at,
         e.ts AS event_ts,
         e.kind AS event_kind,
         e.payload AS event_payload
       FROM job j
       INNER JOIN job_event e ON e.job_id = j.id
       WHERE j.project = @project
         AND j.session_id = @sessionId
       ORDER BY e.id ASC
       LIMIT @limit`,
    )
    .all({ project: projectName, sessionId, limit }) as {
      job_prompt: string;
      job_started_at: string;
      event_ts: string;
      event_kind: string;
      event_payload: string | null;
    }[];

  const lines: SessionLogLine[] = [];
  let lastJobPrompt = '';

  for (const row of rows) {
    if (row.job_prompt !== lastJobPrompt) {
      lastJobPrompt = row.job_prompt;
      lines.push({
        at: row.job_started_at,
        level: 'info',
        summary: `Prompt: ${row.job_prompt.slice(0, 200)}`,
      });
    }

    const formatted = formatJobEventLine(
      row.event_kind as JobEventKind,
      row.event_payload,
      row.job_prompt,
    );
    if (!formatted) continue;

    lines.push({
      at: row.event_ts,
      level: formatted.level,
      summary: formatted.summary,
      detail: formatted.detail,
    });
  }

  return lines;
}

/** True if this session id has been used on a job for the project. */
export function projectHasCursorSession(projectName: string, sessionId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS ok FROM job
       WHERE project = @project AND session_id = @sessionId
       LIMIT 1`,
    )
    .get({ project: projectName, sessionId }) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

// ── Voice agent runs (agent_native conversational loop) ─────────────────────

export type VoiceAgentRunStatus = 'running' | 'done' | 'error' | 'stopped';

export interface VoiceAgentRun {
  id: string;
  project: string;
  pid: number | null;
  sessionId: string | null;
  mcpSession: string | null;
  status: VoiceAgentRunStatus;
  startedAt: string;
  endedAt: string | null;
}

interface VoiceAgentRunRow {
  id: string;
  project: string;
  pid: number | null;
  session_id: string | null;
  mcp_session: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
}

function rowToVoiceAgentRun(row: VoiceAgentRunRow): VoiceAgentRun {
  return {
    id: row.id,
    project: row.project,
    pid: row.pid,
    sessionId: row.session_id,
    mcpSession: row.mcp_session,
    status: row.status as VoiceAgentRunStatus,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/** Create a voice agent run row (status = running). Returns the run id. */
export function createVoiceAgentRun(params: { project: string; pid?: number }): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO voice_agent_run (id, project, pid, status)
       VALUES (@id, @project, @pid, 'running')`,
    )
    .run({ id, project: params.project, pid: params.pid ?? null });
  log.debug({ runId: id, project: params.project }, 'voice agent run created');
  return id;
}

export function getVoiceAgentRun(id: string): VoiceAgentRun | null {
  const row = getDb()
    .prepare('SELECT * FROM voice_agent_run WHERE id = ?')
    .get(id) as VoiceAgentRunRow | undefined;
  return row ? rowToVoiceAgentRun(row) : null;
}

export function getActiveVoiceAgentRun(): VoiceAgentRun | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM voice_agent_run WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`,
    )
    .get() as VoiceAgentRunRow | undefined;
  return row ? rowToVoiceAgentRun(row) : null;
}

export function updateVoiceAgentRun(
  id: string,
  patch: Partial<{
    pid: number | null;
    sessionId: string | null;
    mcpSession: string | null;
    status: VoiceAgentRunStatus;
    endedAt: string | null;
  }>,
): void {
  const sets: string[] = [];
  const values: Record<string, unknown> = { id };

  if (patch.pid !== undefined) {
    sets.push('pid = @pid');
    values['pid'] = patch.pid;
  }
  if (patch.sessionId !== undefined) {
    sets.push('session_id = @sessionId');
    values['sessionId'] = patch.sessionId;
  }
  if (patch.mcpSession !== undefined) {
    sets.push('mcp_session = @mcpSession');
    values['mcpSession'] = patch.mcpSession;
  }
  if (patch.status !== undefined) {
    sets.push('status = @status');
    values['status'] = patch.status;
  }
  if (patch.endedAt !== undefined) {
    sets.push('ended_at = @endedAt');
    values['endedAt'] = patch.endedAt;
  }

  if (sets.length === 0) return;

  getDb()
    .prepare(`UPDATE voice_agent_run SET ${sets.join(', ')} WHERE id = @id`)
    .run(values);
}

/** Mark orphaned voice agent runs after bridge restart. */
export function markOrphanedVoiceAgentRuns(): number {
  const result = getDb()
    .prepare(
      `UPDATE voice_agent_run SET
         status = 'error',
         ended_at = datetime('now')
       WHERE status = 'running'`,
    )
    .run();
  if (result.changes > 0) {
    log.warn({ count: result.changes }, 'marked orphaned voice agent runs as error');
  }
  return result.changes;
}
