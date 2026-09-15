/**
 * Surviving a bridge restart (docs/36 §5, #55).
 *
 * What used to happen: `shutdown()` killed the active agent and the voice
 * agent, the systemd unit's default KillMode would have killed the children
 * anyway, and `markOrphanedJobs()` failed every running row on the next boot.
 * A `systemctl restart` in the middle of a long unattended task threw the task
 * away with no record of what it had been doing.
 *
 * Two mechanisms were designed:
 *
 *   **Resume** — park running jobs as `interrupted` on the way down, then
 *   respawn them on boot against the same CLI conversation with a prompt that
 *   says the bridge restarted. Implemented here, for all four providers.
 *
 *   **Keep alive** — launch agents under `systemd-run --user --scope
 *   --collect` so they outlive the bridge, with stdout to a file instead of a
 *   pipe. Not implemented: the design names its own blocker, which is that the
 *   MCP transports are in-memory, so a surviving CLI gets a 404 on `/mcp` and
 *   `bindVoiceAgentMcpSession` ("first connection wins") has no way to re-bind
 *   the right process. `keepAliveSupport()` reports that honestly, and the
 *   policy falls back to resume rather than silently doing nothing.
 *
 * The in-flight tool call is lost either way, which is why the resume prompt
 * tells the agent to check `git status` before carrying on.
 */

import { execFileSync } from 'node:child_process';
import { getConfig, type RestartPolicy } from '../config.js';
import { childLogger } from '../log.js';
import {
  markJobsInterrupted,
  listInterruptedJobs,
  settleInterruptedJob,
  type Job,
} from '../state/jobs.js';
import { getProjectByName } from '../state/registry.js';
import { getActiveJobCount, submitJob } from './jobManager.js';

const log = childLogger('restart-survival');

/** Prepended to the original prompt when a run is picked back up. */
export const RESUME_PROMPT_PREFIX =
  'The AgentVoice bridge restarted while you were part-way through this task, so ' +
  'the tool call you were running was lost. Before doing anything else, run ' +
  '`git status` and `git diff` to see what you had already changed, then continue ' +
  'from there. Do not start over and do not revert your own earlier work.\n\n' +
  'The original request was:\n\n';

export interface KeepAliveSupport {
  supported: boolean;
  reason: string;
}

/**
 * Can this host keep an agent alive across a bridge restart?
 *
 * Even where `systemd-run --user` exists, the answer is currently no: a
 * detached CLI keeps its MCP session pointed at a transport that died with the
 * old process. Reported as a first-class "unsupported, and why" rather than a
 * setting that appears to work.
 */
export function keepAliveSupport(): KeepAliveSupport {
  if (process.platform === 'win32') {
    return { supported: false, reason: 'no systemd on Windows' };
  }
  try {
    execFileSync('systemd-run', ['--version'], { stdio: 'ignore' });
  } catch {
    return { supported: false, reason: 'systemd-run --user is not available on this host' };
  }
  return {
    supported: false,
    reason:
      'the AgentVoice MCP transports are in-memory, so a surviving CLI cannot re-attach ' +
      'to /mcp after the bridge restarts',
  };
}

/** The policy actually in force, after falling back from anything unsupported. */
export function effectiveRestartPolicy(): { policy: RestartPolicy; fellBackFrom: RestartPolicy | null } {
  const configured = getConfig().settings.session.onBridgeRestart;
  if (configured !== 'keep_alive') return { policy: configured, fellBackFrom: null };
  const support = keepAliveSupport();
  if (support.supported) return { policy: 'keep_alive', fellBackFrom: null };
  log.info({ reason: support.reason }, 'keep_alive unsupported — falling back to resume');
  return { policy: 'resume', fellBackFrom: 'keep_alive' };
}

/**
 * Called from the shutdown path, before the agents are killed.
 *
 * Returns the number of runs parked for resume. With policy `kill` nothing is
 * parked and the existing orphan reaper handles them on the next boot.
 */
export function parkRunsForRestart(): number {
  const { policy } = effectiveRestartPolicy();
  if (policy === 'kill') {
    log.info('restart policy is kill — running work will be failed on next boot');
    return 0;
  }
  const parked = markJobsInterrupted();
  log.info({ parked, policy }, 'parked running jobs before shutdown');
  return parked;
}

export interface ResumeOutcome {
  resumed: number;
  abandoned: number;
  details: Array<{ jobId: string; project: string; outcome: 'resumed' | 'abandoned'; reason?: string }>;
}

/** How often a queued relaunch re-checks for a free worker slot. */
const SLOT_POLL_MS = 2_000;

/**
 * Wait until the concurrency cap has room for one more run.
 *
 * `submitJob` returns as soon as its worker is spawned, so the slot it took is
 * still held when the next parked run comes up. Returns false if nothing freed
 * up within one job timeout — the point at which the executor kills whatever
 * is holding the slot, so a longer wait would never be rewarded.
 */
async function waitForJobSlot(): Promise<boolean> {
  const { maxConcurrentJobs, jobTimeoutMs } = getConfig().settings;
  const deadline = Date.now() + jobTimeoutMs;
  while (getActiveJobCount() >= maxConcurrentJobs) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, SLOT_POLL_MS));
  }
  return true;
}

/**
 * Pick interrupted runs back up on boot.
 *
 * Deliberately sequential and bounded by the same concurrency cap as ordinary
 * submissions: a bridge that restarts under four parallel workers must not
 * relaunch four CLIs at once into a machine that may still be settling. The
 * ones over the cap queue behind the others rather than being thrown away.
 */
export async function resumeInterruptedJobs(): Promise<ResumeOutcome> {
  const outcome: ResumeOutcome = { resumed: 0, abandoned: 0, details: [] };
  const { policy } = effectiveRestartPolicy();
  const interrupted = listInterruptedJobs();
  if (interrupted.length === 0) return outcome;

  if (policy === 'kill') {
    for (const job of interrupted) {
      settleInterruptedJob(job.id, 'abandoned');
      outcome.abandoned++;
      outcome.details.push({ jobId: job.id, project: job.project, outcome: 'abandoned', reason: 'policy is kill' });
    }
    return outcome;
  }

  for (const job of interrupted) {
    const reason = (await waitForJobSlot())
      ? await resumeOne(job)
      : 'no worker slot came free before the job timeout elapsed';
    if (reason === null) {
      outcome.resumed++;
      outcome.details.push({ jobId: job.id, project: job.project, outcome: 'resumed' });
    } else {
      settleInterruptedJob(job.id, 'abandoned');
      outcome.abandoned++;
      outcome.details.push({ jobId: job.id, project: job.project, outcome: 'abandoned', reason });
    }
  }

  log.info({ resumed: outcome.resumed, abandoned: outcome.abandoned }, 'interrupted runs settled');
  return outcome;
}

/** Returns null on success, or a human reason the run could not be resumed. */
async function resumeOne(job: Job): Promise<string | null> {
  const project = getProjectByName(job.project);
  if (!project) return `project ${job.project} is no longer registered`;

  // The active CLI must be the one that owns the conversation, or the resume
  // id means nothing to it.
  const activeProvider = getConfig().settings.agentClient;
  if (job.provider && job.provider !== activeProvider) {
    return `it ran on ${job.provider} and the active client is now ${activeProvider}`;
  }

  try {
    await submitJob(
      // The conversation to continue is the one this job was running, not
      // whatever thread the project last finished: a worktree worker never
      // writes the project resume id, and a run that was interrupted never
      // reached the completion path that would.
      { ...project, resumeId: job.sessionId },
      'default',
      RESUME_PROMPT_PREFIX + job.prompt,
      job.mode,
      job.worktree ?? undefined,
      false,
      { resumedFrom: job.id },
    );
    // Only once the replacement run exists: settling first would record the
    // row as continued in a run that a failed spawn never started, and the
    // abandon update below would no longer match it.
    settleInterruptedJob(job.id, 'resumed');
    log.info(
      { from: job.id, project: job.project, worktree: job.worktree, resumeId: job.sessionId },
      'interrupted run resumed',
    );
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, jobId: job.id }, 'could not resume interrupted run');
    return message;
  }
}
