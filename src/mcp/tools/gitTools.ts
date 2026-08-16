/**
 * Git tools — agent_diff, agent_revert
 *
 * Thin wrappers around src/executor/git.ts that resolve the project first.
 */

import { diff, revert } from '../../executor/git.js';
import { resolveProjectOrThrow } from './project.js';

// ── agent_diff ───────────────────────────────────────────────────────────

export interface DiffArgs {
  project?: string;
  full_patch?: boolean;
}

export interface DiffResult {
  project: string;
  diffstat: string;
  patch: string | null;
  clean: boolean;
}

export async function handleCursorDiff(
  args: DiffArgs,
  activeProject: string | null,
): Promise<DiffResult> {
  const project = resolveProjectOrThrow(args.project, activeProject);
  const result = await diff(project.path, args.full_patch ?? false);

  return {
    project: project.name,
    diffstat: result.diffstat,
    patch: result.patch,
    clean: result.clean,
  };
}

// ── agent_revert ─────────────────────────────────────────────────────────

export interface RevertArgs {
  project?: string;
  confirm?: boolean;
}

export interface RevertResult {
  project: string;
  reverted_to: string;
  files: string[];
  method: 'stash' | 'reset_hard';
  message: string;
}

/**
 * Undo changes to the pre-job checkpoint.
 *
 * The voice model MUST confirm with the user before calling with confirm=true,
 * as reset_hard is irreversible.
 */
export async function handleCursorRevert(
  args: RevertArgs,
  activeProject: string | null,
): Promise<RevertResult> {
  const project = resolveProjectOrThrow(args.project, activeProject);

  // Find the most recent job's checkpoint for this project
  const { getLatestJobForProject } = await import('../../state/jobs.js');
  const lastJob = getLatestJobForProject(project.name);

  if (!lastJob?.checkpoint) {
    throw new Error(
      `No checkpoint found for ${project.name}. ` +
        'A checkpoint is recorded when agent_submit is called. ' +
        'If no job has run, there is nothing to revert.',
    );
  }

  const result = await revert(project.path, lastJob.checkpoint, args.confirm ?? false);

  return {
    project: project.name,
    reverted_to: result.revertedTo,
    files: result.files,
    method: result.method,
    message:
      result.method === 'reset_hard'
        ? `Hard reset to ${result.revertedTo.slice(0, 8)} — ${result.files.length} file(s) reverted.`
        : `Stashed ${result.files.length} file(s) — changes are recoverable via git stash pop.`,
  };
}
