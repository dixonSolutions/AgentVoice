/**
 * Session tools — agent_new_session, agent_session_info
 *
 * agent_new_session: clear the project's resume_id so next submit starts fresh.
 * agent_session_info: read persisted session state without running the CLI.
 */

import {
  clearProjectResumeId,
  setProjectResumeId,
  getProjectByName,
} from '../../state/registry.js';
import { getLatestJobForProject } from '../../state/jobs.js';
import { resolveProjectOrThrow } from './project.js';
import { childLogger } from '../../log.js';
import { getActiveProvider } from '../../providers/agents/registry.js';

const log = childLogger('tool:session');

// ── agent_new_session ─────────────────────────────────────────────────────

export interface NewSessionArgs {
  project?: string;
}

export interface NewSessionResult {
  project: string;
  session_id: string | null;
  message: string;
}

/**
 * Clear the project's resume_id so the next agent_submit starts a fresh
 * conversation thread.
 *
 * Only some CLIs can mint a thread id up front (Cursor's `create-chat`); the
 * rest simply drop the resume id and let the next run create its own. Either
 * way this must never shell out to a hardcoded binary — the previous version
 * ran `cursor-agent create-chat` even when Codex or Claude Code was active.
 */
export async function handleNewSession(
  args: NewSessionArgs,
  activeProject: string | null,
): Promise<NewSessionResult> {
  const project = resolveProjectOrThrow(args.project, activeProject);

  const provider = getActiveProvider();
  let newSessionId: string | null = null;

  if (provider.createSession) {
    try {
      newSessionId = await provider.createSession(project);
    } catch (err) {
      log.warn({ err, provider: provider.id }, 'createSession failed — clearing resume_id only');
    }
  }

  if (newSessionId) {
    setProjectResumeId(project.name, newSessionId);
    log.info({ project: project.name, provider: provider.id, sessionId: newSessionId }, 'new session pre-created');
  } else {
    clearProjectResumeId(project.name);
    log.info({ project: project.name, provider: provider.id }, 'resume_id cleared — next run starts a fresh thread');
  }

  return {
    project: project.name,
    session_id: newSessionId,
    message: newSessionId
      ? `New session started on ${project.name} (id: ${newSessionId}).`
      : `Session cleared on ${project.name}. Next submit will start a fresh thread.`,
  };
}

// ── agent_session_info ────────────────────────────────────────────────────

export interface SessionInfoArgs {
  project?: string;
}

export interface SessionInfoResult {
  project: string;
  resume_id: string | null;
  last_job_id: string | null;
  last_run_at: string | null;
}

/**
 * Read the persisted session state for a project without running the CLI.
 * Useful for the voice model to narrate "you were last working on X N minutes ago".
 */
export function handleSessionInfo(
  args: SessionInfoArgs,
  activeProject: string | null,
): SessionInfoResult {
  const project = resolveProjectOrThrow(args.project, activeProject);
  const row = getProjectByName(project.name);
  const lastJob = getLatestJobForProject(project.name);

  return {
    project: project.name,
    resume_id: row?.resumeId ?? null,
    last_job_id: lastJob?.id ?? null,
    last_run_at: lastJob?.startedAt ?? null,
  };
}
