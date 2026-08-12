/**
 * Serve — manual self-hosting maintenance (no auto-update scheduler).
 *
 * In-app actions: force pull+rebase onto main (or configured branch), install
 * deps, build, restart, health check, full "update service" pipeline, and
 * journalctl service logs. See docs/21-serve-self-hosting.md
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { getConfig, type ServeSettings } from '../config.js';
import { childLogger } from '../log.js';
import { writeAudit } from '../state/db.js';
import {
  addServeEvent,
  type ServeEventStatus,
} from '../state/serveEvents.js';

const log = childLogger('serve');

/** Default branch for force rebase when settings.serve.branch is unset. */
const DEFAULT_TRACK_BRANCH = 'main';

export type ServeOutcome = 'ok' | 'skipped' | 'no_changes' | 'error';

export type ServeActionId = 'pull' | 'deps' | 'build' | 'restart' | 'health';

export interface ServeRunResult {
  runId: string;
  trigger: 'manual';
  startedAt: string;
  finishedAt: string;
  outcome: ServeOutcome;
  summary: string;
}

export interface ServeActionResult {
  runId: string;
  outcome: ServeOutcome;
  detail: string;
}

export interface ServeGitSnapshot {
  repoDir: string;
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  currentCommit: string | null;
}

export interface ServeStatus {
  running: boolean;
  lastRun: ServeRunResult | null;
  git: ServeGitSnapshot | null;
}

export interface ServeServiceLogs {
  unit: string;
  lines: number;
  text: string;
  ok: boolean;
  detail?: string;
}

let _running = false;
let _lastRun: ServeRunResult | null = null;
let _lastGit: ServeGitSnapshot | null = null;

function resolveRepoDir(settings: ServeSettings): string {
  return resolve(settings.repoDir?.trim() || process.cwd());
}

function trackBranch(settings: ServeSettings, fallback?: string): string {
  return settings.branch?.trim() || fallback?.trim() || DEFAULT_TRACK_BRANCH;
}

function hashLockfile(repoDir: string): string | null {
  const lockPath = join(repoDir, 'package-lock.json');
  if (!existsSync(lockPath)) return null;
  const buf = readFileSync(lockPath);
  return createHash('sha256').update(buf).digest('hex');
}

function recordStep(
  runId: string,
  step: string,
  status: ServeEventStatus,
  detail?: string,
): void {
  addServeEvent({ runId, step, status, detail });
  log.info({ runId, step, status, detail }, 'serve step');
  writeAudit({
    tool: 'serve',
    result: status === 'error' ? 'error' : 'ok',
    reason: `${step}:${status}${detail ? ` — ${detail.slice(0, 120)}` : ''}`,
  });
}

function runCommand(
  cwd: string,
  command: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function probeGit(repoDir: string, branchHint?: string): Promise<ServeGitSnapshot> {
  const git = simpleGit({ baseDir: repoDir });
  const branch =
    branchHint?.trim() ||
    (await git.revparse(['--abbrev-ref', 'HEAD']).catch(() => 'HEAD'));
  let status;
  try {
    status = await git.status();
  } catch {
    return {
      repoDir,
      branch,
      dirty: false,
      ahead: 0,
      behind: 0,
      currentCommit: null,
    };
  }
  let currentCommit: string | null = null;
  try {
    currentCommit = (await git.revparse(['HEAD'])).trim();
  } catch {
    currentCommit = null;
  }
  return {
    repoDir,
    branch: status.current || branch,
    dirty: !status.isClean(),
    ahead: status.ahead,
    behind: status.behind,
    currentCommit,
  };
}

async function healthCheck(port: number): Promise<{ ok: boolean; detail?: string }> {
  const url = `http://127.0.0.1:${port}/healthz`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      return { ok: false, detail: `${res.status} ${res.statusText}` };
    }
    const body = (await res.json()) as { status?: string };
    if (body.status !== 'ok') {
      return { ok: false, detail: `status=${String(body.status)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run a maintenance script that will stop this very service.
 *
 * A plain detached child stays inside the service cgroup, so systemd kills it
 * the moment the unit stops — the bridge went down and never came back up.
 * `systemd-run --user --scope` moves the script into its own transient unit so
 * it survives. Plain spawn remains the fallback for non-systemd hosts.
 */
function spawnDetachedFromService(
  repoDir: string,
  scriptArgs: string[],
): { ok: boolean; detail: string } {
  const useScope = existsSync('/run/systemd/system');
  const [command, args] = useScope
    ? (['systemd-run', ['--user', '--scope', '--collect', 'bash', ...scriptArgs]] as const)
    : (['bash', scriptArgs] as const);
  try {
    const child = spawn(command, [...args], {
      cwd: repoDir,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return {
      ok: true,
      detail: useScope
        ? `spawned ${scriptArgs.join(' ')} in a transient scope`
        : `spawned ${scriptArgs.join(' ')}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Restart is always spawned, even when agentvoice-watch.path is active: the
 * watch unit is best-effort and a missed trigger used to leave the old process
 * serving stale code with no signal that anything was wrong. A duplicate
 * restart is cheap; systemd serialises them.
 */
async function triggerRestart(repoDir: string, runId: string): Promise<ServeOutcome> {
  const script = join(repoDir, 'scripts/restart.sh');
  if (!existsSync(script)) {
    recordStep(runId, 'restart', 'warn', `restart script missing at ${script}`);
    return 'error';
  }
  const spawned = spawnDetachedFromService(repoDir, [script, '--no-build']);
  recordStep(runId, 'restart', spawned.ok ? 'ok' : 'error', spawned.detail);
  return spawned.ok ? 'ok' : 'error';
}

function assertRepoDir(repoDir: string, runId: string): boolean {
  if (!existsSync(join(repoDir, 'package.json'))) {
    recordStep(runId, 'repo_check', 'error', 'package.json not found');
    return false;
  }
  return true;
}

/**
 * Fetch origin and rebase onto origin/<branch> (default main).
 * Dirty trees are stashed before rebase and popped after.
 */
async function stepGitRebase(
  repoDir: string,
  hb: ServeSettings,
  runId: string,
): Promise<{ outcome: ServeOutcome; detail: string; rebased: boolean }> {
  const git = simpleGit({ baseDir: repoDir });
  let snapshot = await probeGit(repoDir, hb.branch);
  _lastGit = snapshot;
  const branch = trackBranch(hb, snapshot.branch);
  recordStep(
    runId,
    'git_status',
    snapshot.dirty ? 'warn' : 'ok',
    `branch=${snapshot.branch} track=${branch} ahead=${snapshot.ahead} behind=${snapshot.behind} dirty=${snapshot.dirty}`,
  );

  try {
    await git.fetch('origin');
    recordStep(runId, 'git_fetch', 'ok', `origin/${branch}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'git_fetch', 'error', detail);
    return { outcome: 'error', detail: `Git fetch failed — ${detail}`, rebased: false };
  }

  snapshot = await probeGit(repoDir, hb.branch);
  _lastGit = snapshot;

  const upstreamRef = `origin/${branch}`;
  let upstreamCommit: string | null = null;
  try {
    upstreamCommit = (await git.revparse([upstreamRef])).trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'git_rebase', 'error', `missing ${upstreamRef}: ${detail}`);
    return {
      outcome: 'error',
      detail: `Upstream ${upstreamRef} not found — set settings.serve.branch or push main`,
      rebased: false,
    };
  }

  if (snapshot.currentCommit && upstreamCommit && snapshot.currentCommit === upstreamCommit && !snapshot.ahead) {
    recordStep(runId, 'git_rebase', 'skip', `already at ${upstreamRef}`);
    return { outcome: 'no_changes', detail: `Already up to date with ${upstreamRef}`, rebased: false };
  }

  let stashed = false;
  if (snapshot.dirty) {
    try {
      await git.stash(['push', '-u', '-m', `agentvoice serve rebase ${new Date().toISOString()}`]);
      stashed = true;
      recordStep(runId, 'git_stash', 'ok', 'stashed local changes before rebase');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordStep(runId, 'git_stash', 'error', detail);
      return { outcome: 'error', detail: `Could not stash dirty tree — ${detail}`, rebased: false };
    }
  }

  try {
    await git.rebase([upstreamRef]);
    recordStep(runId, 'git_rebase', 'ok', `rebased onto ${upstreamRef}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    try {
      await git.rebase(['--abort']);
    } catch {
      // already clean or no rebase in progress
    }
    recordStep(runId, 'git_rebase', 'error', detail);
    if (stashed) {
      try {
        await git.stash(['pop']);
        recordStep(runId, 'git_stash_pop', 'ok', 'restored stash after failed rebase');
      } catch (popErr) {
        const popDetail = popErr instanceof Error ? popErr.message : String(popErr);
        recordStep(runId, 'git_stash_pop', 'warn', popDetail);
      }
    }
    _lastGit = await probeGit(repoDir, hb.branch);
    return { outcome: 'error', detail: `Git rebase failed — ${detail}`, rebased: false };
  }

  if (stashed) {
    try {
      await git.stash(['pop']);
      recordStep(runId, 'git_stash_pop', 'ok', 'restored local stash after rebase');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordStep(runId, 'git_stash_pop', 'warn', detail);
    }
  }

  _lastGit = await probeGit(repoDir, hb.branch);
  return { outcome: 'ok', detail: `Rebased onto ${upstreamRef}`, rebased: true };
}

async function stepInstallDeps(
  repoDir: string,
  runId: string,
  reason: string,
): Promise<{ outcome: ServeOutcome; detail: string }> {
  try {
    const { code, stderr } = await runCommand(repoDir, 'npm', [
      'install',
      '--no-audit',
      '--legacy-peer-deps',
    ]);
    if (code !== 0) {
      const detail = stderr.slice(0, 500) || `exit ${code}`;
      recordStep(runId, 'npm_install', 'error', detail);
      return { outcome: 'error', detail: 'npm install failed' };
    }
    const rebuild = await runCommand(repoDir, 'npm', ['rebuild']);
    if (rebuild.code !== 0) {
      const detail = rebuild.stderr.slice(0, 500) || `exit ${rebuild.code}`;
      recordStep(runId, 'npm_rebuild', 'error', detail);
      return { outcome: 'error', detail: 'npm rebuild failed' };
    }
    recordStep(runId, 'npm_rebuild', 'ok');
    recordStep(runId, 'npm_install', 'ok', reason);
    return { outcome: 'ok', detail: 'Dependencies installed and rebuilt' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'npm_install', 'error', detail);
    return { outcome: 'error', detail: `npm install failed — ${detail}` };
  }
}

async function stepBuild(
  repoDir: string,
  runId: string,
): Promise<{ outcome: ServeOutcome; detail: string }> {
  try {
    const { code, stderr } = await runCommand(repoDir, 'npm', ['run', 'build']);
    if (code !== 0) {
      const detail = stderr.slice(0, 500) || `exit ${code}`;
      recordStep(runId, 'npm_build', 'error', detail);
      return { outcome: 'error', detail: 'npm run build failed' };
    }
    recordStep(runId, 'npm_build', 'ok');
    return { outcome: 'ok', detail: 'Build completed' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'npm_build', 'error', detail);
    return { outcome: 'error', detail: `Build failed — ${detail}` };
  }
}

async function withServeLock<T>(
  label: string,
  fn: (runId: string) => Promise<T>,
): Promise<T> {
  if (_running) {
    throw new Error('Serve is already running');
  }
  _running = true;
  const runId = randomUUID();
  recordStep(runId, 'start', 'ok', label);
  try {
    return await fn(runId);
  } finally {
    _running = false;
  }
}

export async function refreshGitSnapshot(): Promise<ServeGitSnapshot> {
  const { settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);
  _lastGit = await probeGit(repoDir, settings.serve.branch);
  return _lastGit;
}

export function getServeStatus(): ServeStatus {
  return {
    running: _running,
    lastRun: _lastRun,
    git: _lastGit,
  };
}

export async function serveGitPull(): Promise<ServeActionResult> {
  const { settings } = getConfig();
  const hb = settings.serve;
  const repoDir = resolveRepoDir(hb);

  return withServeLock('manual:pull-rebase', async (runId) => {
    if (!assertRepoDir(repoDir, runId)) {
      return { runId, outcome: 'error' as const, detail: 'Invalid repo directory' };
    }
    const result = await stepGitRebase(repoDir, hb, runId);
    recordStep(runId, 'finish', result.outcome === 'error' ? 'error' : 'ok', result.detail);
    return { runId, outcome: result.outcome, detail: result.detail };
  });
}

export async function serveInstallDeps(): Promise<ServeActionResult> {
  const { settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);

  return withServeLock('manual:deps', async (runId) => {
    if (!assertRepoDir(repoDir, runId)) {
      return { runId, outcome: 'error' as const, detail: 'Invalid repo directory' };
    }
    const result = await stepInstallDeps(repoDir, runId, 'manual');
    recordStep(runId, 'finish', result.outcome === 'error' ? 'error' : 'ok', result.detail);
    return { runId, ...result };
  });
}

export async function serveBuild(): Promise<ServeActionResult> {
  const { settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);

  return withServeLock('manual:build', async (runId) => {
    if (!assertRepoDir(repoDir, runId)) {
      return { runId, outcome: 'error' as const, detail: 'Invalid repo directory' };
    }
    const result = await stepBuild(repoDir, runId);
    recordStep(runId, 'finish', result.outcome === 'error' ? 'error' : 'ok', result.detail);
    return { runId, ...result };
  });
}

export async function serveRestart(): Promise<ServeActionResult> {
  const { settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);

  return withServeLock('manual:restart', async (runId) => {
    const outcome = await triggerRestart(repoDir, runId);
    const detail = outcome === 'ok' ? 'Restart spawned' : 'Restart failed';
    recordStep(runId, 'finish', outcome === 'error' ? 'error' : 'ok', detail);
    return { runId, outcome, detail };
  });
}

export async function serveHealthCheck(): Promise<ServeActionResult> {
  const { env, settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);

  return withServeLock('manual:health', async (runId) => {
    try {
      await refreshGitSnapshot();
    } catch {
      // non-fatal
    }
    const health = await healthCheck(env.PORT);
    recordStep(
      runId,
      'health_check',
      health.ok ? 'ok' : 'warn',
      health.detail ?? 'ok',
    );
    const detail = health.ok
      ? `Healthy — ${repoDir}`
      : `Health check failed — ${health.detail ?? 'unknown'}`;
    recordStep(runId, 'finish', health.ok ? 'ok' : 'warn', detail);
    return {
      runId,
      outcome: health.ok ? 'ok' : 'error',
      detail,
    };
  });
}

export async function runServeAction(action: ServeActionId): Promise<ServeActionResult> {
  switch (action) {
    case 'pull':
      return serveGitPull();
    case 'deps':
      return serveInstallDeps();
    case 'build':
      return serveBuild();
    case 'restart':
      return serveRestart();
    case 'health':
      return serveHealthCheck();
    default:
      throw new Error(`Unknown serve action: ${String(action)}`);
  }
}

/** Full manual update: rebase → deps (if lock changed) → build → restart → health. */
export async function runServe(): Promise<ServeRunResult> {
  if (_running) {
    throw new Error('Serve is already running');
  }

  const { settings, env } = getConfig();
  const hb = settings.serve;

  _running = true;
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const repoDir = resolveRepoDir(hb);
  let outcome: ServeOutcome = 'ok';
  let summary = 'Serve completed';
  const lockBefore = hashLockfile(repoDir);

  recordStep(runId, 'start', 'ok', `manual update — repo ${repoDir}`);

  try {
    if (!assertRepoDir(repoDir, runId)) {
      outcome = 'error';
      summary = 'Invalid repo directory — package.json missing';
      return finishRun(runId, startedAt, outcome, summary);
    }

    const rebaseResult = await stepGitRebase(repoDir, hb, runId);
    if (rebaseResult.outcome === 'error') {
      return finishRun(runId, startedAt, 'error', rebaseResult.detail);
    }

    const lockAfter = hashLockfile(repoDir);
    const lockChanged = lockBefore !== null && lockAfter !== null && lockBefore !== lockAfter;

    if (lockChanged || rebaseResult.rebased) {
      // Always reinstall when we moved commits or the lockfile changed.
      if (lockChanged) {
        const depsResult = await stepInstallDeps(repoDir, runId, 'lockfile changed');
        if (depsResult.outcome === 'error') {
          return finishRun(runId, startedAt, 'error', depsResult.detail);
        }
      } else {
        recordStep(runId, 'npm_install', 'skip', 'lockfile unchanged');
      }
    } else {
      recordStep(runId, 'npm_install', 'skip', 'no rebase and lockfile unchanged');
    }

    const buildResult = await stepBuild(repoDir, runId);
    if (buildResult.outcome === 'error') {
      return finishRun(runId, startedAt, 'error', buildResult.detail);
    }

    await triggerRestart(repoDir, runId);

    const health = await healthCheck(env.PORT);
    recordStep(
      runId,
      'health_check',
      health.ok ? 'ok' : 'warn',
      health.detail ?? 'ok',
    );

    if (rebaseResult.outcome === 'no_changes' && !lockChanged) {
      outcome = 'no_changes';
      summary = 'No git updates — rebuilt and restarted anyway';
    } else {
      summary = rebaseResult.detail;
    }

    return finishRun(runId, startedAt, outcome, summary);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'fatal', 'error', detail);
    outcome = 'error';
    summary = detail;
    return finishRun(runId, startedAt, outcome, summary);
  } finally {
    _running = false;
  }
}

function finishRun(
  runId: string,
  startedAt: string,
  outcome: ServeOutcome,
  summary: string,
): ServeRunResult {
  const result: ServeRunResult = {
    runId,
    trigger: 'manual',
    startedAt,
    finishedAt: new Date().toISOString(),
    outcome,
    summary,
  };
  recordStep(runId, 'finish', outcome === 'error' ? 'error' : 'ok', summary);
  _lastRun = result;
  return result;
}

/** Fixed unit name — never interpolated from user input. */
const SERVICE_UNIT = 'agentvoice.service';

/**
 * Read recent systemd user journal lines for the bridge service.
 * argv is fixed; only `lines` is clamped server-side.
 */
export async function getServeServiceLogs(lines = 80): Promise<ServeServiceLogs> {
  const n = Math.min(Math.max(Math.floor(lines) || 80, 1), 500);
  try {
    const { code, stdout, stderr } = await runCommand(process.cwd(), 'journalctl', [
      '--user',
      '-u',
      SERVICE_UNIT,
      '-n',
      String(n),
      '--no-pager',
      '-o',
      'short-iso',
    ]);
    if (code !== 0) {
      const detail = (stderr || stdout).trim().slice(0, 400) || `exit ${code}`;
      return { unit: SERVICE_UNIT, lines: n, text: '', ok: false, detail };
    }
    return { unit: SERVICE_UNIT, lines: n, text: stdout.trimEnd(), ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { unit: SERVICE_UNIT, lines: n, text: '', ok: false, detail };
  }
}

/** Refresh git snapshot on boot (no scheduler). */
export async function startServe(): Promise<void> {
  try {
    await refreshGitSnapshot();
  } catch (err) {
    log.warn({ err }, 'initial git snapshot failed');
  }
}

/** @deprecated No-op — scheduler removed. Kept so call sites compile during migration. */
export function stopServeScheduler(): void {
  // intentionally empty
}

export function spawnInstallSystemd(repoDir: string): { ok: boolean; detail: string } {
  const script = join(repoDir, 'scripts/install-systemd.sh');
  if (!existsSync(script)) {
    return { ok: false, detail: `Missing ${script}` };
  }
  const runId = randomUUID();
  const spawned = spawnDetachedFromService(repoDir, [script]);
  recordStep(runId, 'install_systemd', spawned.ok ? 'ok' : 'error', spawned.detail);
  return { ok: spawned.ok, detail: spawned.detail };
}
