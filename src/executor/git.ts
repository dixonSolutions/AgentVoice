/**
 * Git integration via simple-git.
 *
 * Provides three operations needed by the MCP executor layer:
 *   - checkpoint: record HEAD SHA before each job (enables revert).
 *   - diff: current uncommitted changes (stat + optional full patch).
 *   - revert: undo to pre-job checkpoint (stash for uncommitted; reset --hard
 *     for agent-committed changes — the latter requires explicit confirmation).
 *
 * Paths come from the project registry only (never from caller input).
 * See docs/05-mcp-and-cursor-agent.md — Git strategy section.
 */

import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import { childLogger } from '../log.js';

const log = childLogger('git');

// ── Helpers ───────────────────────────────────────────────────────────────

function git(projectPath: string): SimpleGit {
  return simpleGit(projectPath, {
    binary: 'git',
    maxConcurrentProcesses: 2,
    trimmed: true,
  });
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface Checkpoint {
  sha: string;
  isClean: boolean; // working tree was clean when checkpoint was taken
}

export interface DiffResult {
  diffstat: string;
  patch: string | null;
  clean: boolean;
}

export type RevertMethod = 'stash' | 'reset_hard';

export interface RevertResult {
  revertedTo: string;
  files: string[];
  method: RevertMethod;
}

// ── checkpoint ────────────────────────────────────────────────────────────

/**
 * Record the current HEAD commit SHA and working-tree cleanliness before
 * launching a cursor-agent job. Stored on the `job.checkpoint` column so
 * we can revert to exactly this state.
 */
export async function checkpoint(projectPath: string): Promise<Checkpoint> {
  const g = git(projectPath);

  const sha = await g.revparse(['HEAD']);
  const status = await g.status();

  const cp: Checkpoint = {
    sha: sha.trim(),
    isClean: status.isClean(),
  };

  log.debug({ projectPath, ...cp }, 'git checkpoint recorded');
  return cp;
}

// ── diff ─────────────────────────────────────────────────────────────────

/**
 * Return the current uncommitted diff for a project workspace.
 * `diffstat` is always computed; `patch` is only included when `fullPatch` is true.
 */
export async function diff(projectPath: string, fullPatch = false): Promise<DiffResult> {
  const g = git(projectPath);
  const status = await g.status();

  if (status.isClean()) {
    return { diffstat: 'No changes.', patch: null, clean: true };
  }

  // --stat summary
  const statOutput = await g.diff(['--stat']);

  // Full patch (optional — may be large)
  let patch: string | null = null;
  if (fullPatch) {
    patch = await g.diff();
  }

  return {
    diffstat: statOutput || 'Changes present (no stat output).',
    patch,
    clean: false,
  };
}

// ── revert ────────────────────────────────────────────────────────────────

/**
 * Undo changes to the pre-job checkpoint.
 *
 * Strategy (safe default):
 *   - If changes are uncommitted → `git stash` (reversible; nothing is lost).
 *   - If the agent committed changes → `git reset --hard <checkpoint>` (destructive;
 *     requires `confirm: true` from the caller so the voice model has confirmed
 *     with the user before proceeding).
 *
 * @param confirm  Must be true for the destructive reset path. Safeguard against
 *                 accidental calls without user confirmation.
 */
export async function revert(
  projectPath: string,
  checkpointSha: string,
  confirm = false,
): Promise<RevertResult> {
  const g = git(projectPath);
  const status = await g.status();
  const currentHead = (await g.revparse(['HEAD'])).trim();

  // Determine if the agent made any commits since our checkpoint.
  const agentCommitted = currentHead !== checkpointSha;

  if (agentCommitted) {
    if (!confirm) {
      throw new Error(
        'cursor_revert: agent made commits since the checkpoint. ' +
          'Call with confirm=true after obtaining user confirmation to hard-reset.',
      );
    }

    log.warn(
      { projectPath, from: currentHead, to: checkpointSha },
      'hard-resetting to pre-job checkpoint (destructive)',
    );

    // Collect the files that will change before resetting.
    const changedFiles = await listChangedFiles(g, checkpointSha);

    await g.reset(['--hard', checkpointSha]);
    log.info({ checkpointSha }, 'git reset --hard complete');

    return { revertedTo: checkpointSha, files: changedFiles, method: 'reset_hard' };
  }

  // Uncommitted changes only → safe stash.
  if (status.isClean()) {
    log.info({ projectPath }, 'revert called but working tree already clean');
    return { revertedTo: checkpointSha, files: [], method: 'stash' };
  }

  const changedFiles = status.files.map((f) => f.path);
  await g.stash(['push', '-u', '-m', `agentvoice revert ${new Date().toISOString()}`]);
  log.info({ projectPath, files: changedFiles.length }, 'changes stashed');

  return { revertedTo: checkpointSha, files: changedFiles, method: 'stash' };
}

// ── helpers ───────────────────────────────────────────────────────────────

async function listChangedFiles(g: SimpleGit, fromSha: string): Promise<string[]> {
  try {
    const output = await g.diff(['--name-only', fromSha, 'HEAD']);
    return output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── is-git-repo guard ─────────────────────────────────────────────────────

/** Returns true if the path is inside a git repository. */
export async function isGitRepo(projectPath: string): Promise<boolean> {
  try {
    const g = git(projectPath);
    await g.revparse(['--git-dir']);
    return true;
  } catch {
    return false;
  }
}
