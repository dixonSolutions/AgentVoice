/**
 * Resume-thread safety net.
 *
 * `--resume <id>` is fatal when the CLI does not have that thread: it exits 1
 * before producing a single token, which for a voice turn means the user hears
 * nothing at all. Two ways that happens:
 *
 *   1. The id belongs to a *different* CLI. Resume ids used to be stored one
 *      per project, shared by every provider, so switching agentClient handed
 *      Claude Code a Cursor chat id ("No conversation found with session ID: …")
 *      and every turn died. Ids are now per (project, provider) — see
 *      state/registry.ts — and this module stops a leftover one from being used.
 *   2. The thread is genuinely gone (user deleted it, CLI pruned it, another
 *      machine).
 *
 * Both are handled the same way: drop the resume and start a fresh thread,
 * because a fresh answer is always better than silence.
 */

import { childLogger } from '../log.js';
import { clearProjectResumeId, type Project } from '../state/registry.js';
import { getActiveProvider } from '../providers/agents/registry.js';

const log = childLogger('resume-guard');

/**
 * CLI stderr for "that thread does not exist here". Kept broad on purpose —
 * each CLI words it differently, and a missed match only costs one failed spawn
 * (the pre-spawn check below is what normally prevents it).
 */
const STALE_SESSION_PATTERNS = [
  /no conversation found/i,
  /conversation .* not found/i,
  /no such (?:session|conversation|chat)/i,
  /session .* (?:not found|does not exist)/i,
  /chat .* not found/i,
  /unknown session id/i,
  /failed to (?:resume|load) (?:session|conversation|chat)/i,
];

export function isStaleSessionError(stderr: string): boolean {
  return STALE_SESSION_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * Drop the stored resume id when the active CLI can prove it does not have that
 * thread. Returns the project to actually spawn with.
 *
 * A provider that cannot inspect its store answers 'unknown', and we resume
 * anyway — a wrong guess here would silently throw away conversation history,
 * which is worse than the one failed spawn that `handleStaleSessionExit` cleans
 * up afterwards.
 */
export function guardResumeId(project: Project): Project {
  if (!project.resumeId) return project;

  const provider = getActiveProvider();
  const status = provider.sessionStatus?.(project, project.resumeId) ?? 'unknown';
  if (status !== 'absent') return project;

  log.warn(
    { project: project.name, provider: provider.id, resumeId: project.resumeId },
    'stored resume thread is not in this CLI\'s session store — starting a fresh thread',
  );
  clearProjectResumeId(project.name);
  return { ...project, resumeId: null };
}

/**
 * Post-mortem for a failed spawn: if the CLI died because the thread was gone,
 * forget it so the next turn starts clean instead of failing identically
 * forever. Returns true when that was the cause.
 */
export function handleStaleSessionExit(project: Project, exitCode: number, stderr: string): boolean {
  if (exitCode === 0 || !project.resumeId || !isStaleSessionError(stderr)) return false;

  const provider = getActiveProvider();
  log.warn(
    { project: project.name, provider: provider.id, resumeId: project.resumeId },
    'CLI rejected the resume thread — cleared; next run starts a fresh one',
  );
  clearProjectResumeId(project.name);
  return true;
}
