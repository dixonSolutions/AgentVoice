/**
 * Serve — manual self-hosting maintenance (no heartbeat, no auto-update).
 *
 * In-app actions: rebase onto origin/<branch> (default: origin's default
 * branch, else main), restart via scripts/restart.sh, health check, and live
 * journalctl logs. See docs/21-serve-self-hosting.md
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { simpleGit, type SimpleGit } from 'simple-git';
import { getConfig, type ServeSettings } from '../config.js';
import { childLogger } from '../log.js';
import { writeAudit } from '../state/db.js';
import {
  addServeEvent,
  type ServeEventStatus,
} from '../state/serveEvents.js';

const log = childLogger('serve');

/** Fallback when origin has no default branch advertised. */
const FALLBACK_TRACK_BRANCH = 'main';

/** Fixed unit name — never interpolated from user input. */
const SERVICE_UNIT = 'agentvoice.service';

export type ServeOutcome = 'ok' | 'skipped' | 'no_changes' | 'error';

export type ServeActionId = 'pull' | 'restart' | 'health';

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
  /** Currently checked-out branch (HEAD). */
  branch: string;
  /** Branch rebase will target (saved setting, else origin default, else main). */
  trackBranch: string;
  /** Origin's advertised default branch (`origin/HEAD`), when known. */
  defaultBranch: string | null;
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

/**
 * Origin's default branch (`git symbolic-ref refs/remotes/origin/HEAD`).
 * Origin is assumed to already exist on the host.
 */
async function detectDefaultBranch(git: SimpleGit): Promise<string | null> {
  try {
    const ref = (await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim();
    const match = /refs\/remotes\/origin\/(.+)$/.exec(ref);
    if (match?.[1]) return match[1];
  } catch {
    // origin/HEAD not set yet
  }
  try {
    const abbreviated = (await git.revparse(['--abbrev-ref', 'origin/HEAD'])).trim();
    const stripped = abbreviated.replace(/^origin\//, '').trim();
    return stripped || null;
  } catch {
    return null;
  }
}

function resolveTrackBranch(
  settings: ServeSettings,
  defaultBranch: string | null,
): string {
  return settings.branch?.trim() || defaultBranch?.trim() || FALLBACK_TRACK_BRANCH;
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

async function probeGit(repoDir: string, settings: ServeSettings): Promise<ServeGitSnapshot> {
  const git = simpleGit({ baseDir: repoDir });
  const defaultBranch = await detectDefaultBranch(git);
  const trackBranch = resolveTrackBranch(settings, defaultBranch);
  let headBranch = trackBranch;
  try {
    headBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim() || trackBranch;
  } catch {
    // keep trackBranch
  }

  let status;
  try {
    status = await git.status();
  } catch {
    return {
      repoDir,
      branch: headBranch,
      trackBranch,
      defaultBranch,
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
    branch: status.current || headBranch,
    trackBranch,
    defaultBranch,
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
 * Restart the entire service via scripts/restart.sh (build + systemd restart +
 * health check). Always spawned, even when agentvoice-watch.path is active.
 */
async function triggerRestart(repoDir: string, runId: string): Promise<ServeOutcome> {
  const script = join(repoDir, 'scripts/restart.sh');
  if (!existsSync(script)) {
    recordStep(runId, 'restart', 'warn', `restart script missing at ${script}`);
    return 'error';
  }
  const spawned = spawnDetachedFromService(repoDir, [script]);
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
 * Fetch origin and rebase onto origin/<trackBranch>.
 * Origin is the source of truth; dirty trees are stashed around the rebase.
 */
async function stepGitRebase(
  repoDir: string,
  settings: ServeSettings,
  runId: string,
): Promise<{ outcome: ServeOutcome; detail: string }> {
  const git = simpleGit({ baseDir: repoDir });
  let snapshot = await probeGit(repoDir, settings);
  _lastGit = snapshot;
  const branch = snapshot.trackBranch;
  recordStep(
    runId,
    'git_status',
    snapshot.dirty ? 'warn' : 'ok',
    `head=${snapshot.branch} track=${branch} default=${snapshot.defaultBranch ?? 'unset'} ahead=${snapshot.ahead} behind=${snapshot.behind} dirty=${snapshot.dirty}`,
  );

  try {
    await git.fetch('origin');
    try {
      await git.raw(['remote', 'set-head', 'origin', '-a']);
    } catch {
      // origin/HEAD refresh is best-effort — fetch already succeeded
    }
    snapshot = await probeGit(repoDir, settings);
    _lastGit = snapshot;
    recordStep(runId, 'git_fetch', 'ok', `origin/${snapshot.trackBranch}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'git_fetch', 'error', detail);
    return { outcome: 'error', detail: `Git fetch failed — ${detail}` };
  }

  const trackBranch = snapshot.trackBranch;
  const upstreamRef = `origin/${trackBranch}`;
  let upstreamCommit: string | null = null;
  try {
    upstreamCommit = (await git.revparse([upstreamRef])).trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'git_rebase', 'error', `missing ${upstreamRef}: ${detail}`);
    return {
      outcome: 'error',
      detail: `Upstream ${upstreamRef} not found — set a track branch or push ${FALLBACK_TRACK_BRANCH}`,
    };
  }

  if (snapshot.currentCommit && upstreamCommit && snapshot.currentCommit === upstreamCommit && !snapshot.ahead) {
    recordStep(runId, 'git_rebase', 'skip', `already at ${upstreamRef}`);
    return { outcome: 'no_changes', detail: `Already up to date with ${upstreamRef}` };
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
      return { outcome: 'error', detail: `Could not stash dirty tree — ${detail}` };
    }
  }

  try {
    // During rebase, "ours" is the upstream (origin). Trust origin on conflicts.
    await git.rebase(['-X', 'ours', upstreamRef]);
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
    _lastGit = await probeGit(repoDir, settings);
    return { outcome: 'error', detail: `Git rebase failed — ${detail}` };
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

  _lastGit = await probeGit(repoDir, settings);
  return { outcome: 'ok', detail: `Rebased onto ${upstreamRef}` };
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
  _lastGit = await probeGit(repoDir, settings.serve);
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
  const serveSettings = settings.serve;
  const repoDir = resolveRepoDir(serveSettings);

  return withServeLock('manual:rebase', async (runId) => {
    if (!assertRepoDir(repoDir, runId)) {
      return { runId, outcome: 'error' as const, detail: 'Invalid repo directory' };
    }
    const result = await stepGitRebase(repoDir, serveSettings, runId);
    recordStep(runId, 'finish', result.outcome === 'error' ? 'error' : 'ok', result.detail);
    _lastRun = {
      runId,
      trigger: 'manual',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outcome: result.outcome,
      summary: result.detail,
    };
    return { runId, outcome: result.outcome, detail: result.detail };
  });
}

export async function serveRestart(): Promise<ServeActionResult> {
  const { settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);

  return withServeLock('manual:restart', async (runId) => {
    const outcome = await triggerRestart(repoDir, runId);
    const detail = outcome === 'ok'
      ? 'Restart script spawned (build + systemd restart)'
      : 'Restart failed';
    recordStep(runId, 'finish', outcome === 'error' ? 'error' : 'ok', detail);
    _lastRun = {
      runId,
      trigger: 'manual',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outcome,
      summary: detail,
    };
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
    case 'restart':
      return serveRestart();
    case 'health':
      return serveHealthCheck();
    default:
      throw new Error(`Unknown serve action: ${String(action)}`);
  }
}

async function journalctlUnitArgs(): Promise<string[]> {
  const userArgs = ['--user', '-u', SERVICE_UNIT];
  try {
    const probe = await runCommand(process.cwd(), 'journalctl', [
      ...userArgs,
      '-n',
      '1',
      '--no-pager',
    ]);
    const text = probe.stdout.trim();
    // journalctl exits 0 for missing/empty units and prints "-- No entries --".
    if (probe.code === 0 && text && text !== '-- No entries --') return userArgs;
  } catch {
    // fall through to system unit
  }
  return ['-u', SERVICE_UNIT];
}

/**
 * Read recent systemd journal lines for the bridge service.
 * argv is fixed; only `lines` is clamped server-side.
 */
export async function getServeServiceLogs(lines = 80): Promise<ServeServiceLogs> {
  const n = Math.min(Math.max(Math.floor(lines) || 80, 1), 500);
  try {
    const unitArgs = await journalctlUnitArgs();
    const { code, stdout, stderr } = await runCommand(process.cwd(), 'journalctl', [
      ...unitArgs,
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

export interface ServeLogFollow {
  unit: string;
  stop: () => void;
}

/**
 * Follow journalctl -f for the bridge unit. Caller must stop() on disconnect.
 */
export async function followServeServiceLogs(opts: {
  lines?: number;
  onLine: (line: string) => void;
  onError: (detail: string) => void;
  onClose: (code: number | null) => void;
}): Promise<ServeLogFollow> {
  const n = Math.min(Math.max(Math.floor(opts.lines ?? 80) || 80, 1), 200);
  const unitArgs = await journalctlUnitArgs();
  const child: ChildProcess = spawn(
    'journalctl',
    [...unitArgs, '-n', String(n), '-f', '--no-pager', '-o', 'short-iso'],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let buffer = '';
  const flush = (chunk: string, emitPartial: boolean): void => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      if (line.length > 0) opts.onLine(line);
    }
    if (emitPartial && buffer.length > 0) {
      opts.onLine(buffer);
      buffer = '';
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    flush(chunk.toString(), false);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) opts.onError(text.slice(0, 400));
  });
  child.on('error', (err) => {
    opts.onError(err.message);
  });
  child.on('close', (code) => {
    flush('', true);
    opts.onClose(code);
  });

  return {
    unit: SERVICE_UNIT,
    stop: () => {
      if (child.killed || child.exitCode !== null) return;
      child.kill('SIGTERM');
    },
  };
}

/** Refresh git snapshot on boot (no scheduler). */
export async function startServe(): Promise<void> {
  try {
    await refreshGitSnapshot();
  } catch (err) {
    log.warn({ err }, 'initial git snapshot failed');
  }
}
