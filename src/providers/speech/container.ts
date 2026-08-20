/**
 * Docker / Podman plumbing for the self-hosted Whisper server.
 *
 * Podman is treated as a first-class peer, not a fallback: it is the default on
 * Fedora/RHEL and needs no daemon or root, which matters for a bridge that
 * people run as a user service. The two CLIs are argument-compatible for
 * everything used here apart from GPU passthrough.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { childLogger } from '../../log.js';

const execFileAsync = promisify(execFile);
const log = childLogger('stt:container');

export type ContainerRuntimeId = 'docker' | 'podman';

export interface ContainerRuntimeInfo {
  id: ContainerRuntimeId;
  version: string | null;
  /** CLI on PATH *and* able to talk to its backend (daemon / user socket). */
  usable: boolean;
  detail?: string;
}

export interface ContainerState {
  exists: boolean;
  running: boolean;
  image: string | null;
  status: string | null;
  startedAt: string | null;
}

const VERSION_ARGS: Record<ContainerRuntimeId, string[]> = {
  docker: ['version', '--format', '{{.Server.Version}}'],
  podman: ['version', '--format', '{{.Version}}'],
};

async function probeRuntime(id: ContainerRuntimeId): Promise<ContainerRuntimeInfo> {
  try {
    const { stdout } = await execFileAsync(id, VERSION_ARGS[id], { timeout: 8_000 });
    const version = stdout.trim();
    return { id, version: version || null, usable: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const missing = /ENOENT|not found/i.test(message);
    return {
      id,
      version: null,
      usable: false,
      detail: missing
        ? `${id} is not installed`
        : `${id} is installed but not responding — is the service running?`,
    };
  }
}

export async function listContainerRuntimes(): Promise<ContainerRuntimeInfo[]> {
  return Promise.all([probeRuntime('docker'), probeRuntime('podman')]);
}

/**
 * Resolve the runtime to use. `auto` prefers Docker when both work, since its
 * `--gpus all` passthrough is the one most users already have configured.
 */
export async function resolveRuntime(
  preferred: 'auto' | ContainerRuntimeId,
): Promise<ContainerRuntimeInfo> {
  const runtimes = await listContainerRuntimes();
  const byId = (id: ContainerRuntimeId) => runtimes.find((r) => r.id === id)!;

  if (preferred !== 'auto') return byId(preferred);
  return byId('docker').usable ? byId('docker') : byId('podman');
}

export async function inspectContainer(
  runtime: ContainerRuntimeId,
  name: string,
): Promise<ContainerState> {
  try {
    const { stdout } = await execFileAsync(
      runtime,
      [
        'inspect',
        name,
        '--format',
        '{{.State.Running}}|{{.State.Status}}|{{.Config.Image}}|{{.State.StartedAt}}',
      ],
      { timeout: 10_000 },
    );
    const [running, status, image, startedAt] = stdout.trim().split('|');
    return {
      exists: true,
      running: running === 'true',
      image: image || null,
      status: status || null,
      startedAt: startedAt || null,
    };
  } catch {
    return { exists: false, running: false, image: null, status: null, startedAt: null };
  }
}

export async function imageExists(runtime: ContainerRuntimeId, image: string): Promise<boolean> {
  try {
    await execFileAsync(runtime, ['image', 'inspect', image], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Run a container command, streaming every stdout/stderr line to `onLine`. */
export function streamCommand(
  bin: string,
  args: string[],
  onLine: (line: string) => void,
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    let output = '';
    let settled = false;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buffer.trim()) onLine(buffer.trim());
      resolvePromise({ code, output });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      onLine(`Timed out after ${(opts.timeoutMs ?? 900_000) / 1000}s`);
      finish(124);
    }, opts.timeoutMs ?? 900_000);

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      buffer += text;
      // Image pulls redraw progress with \r — treat it as a line break so the
      // UI shows movement instead of one ever-growing line.
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) => {
      onLine(err.message);
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 0));
  });
}

export async function pullImage(
  runtime: ContainerRuntimeId,
  image: string,
  onLine: (line: string) => void,
): Promise<boolean> {
  log.info({ runtime, image }, 'pulling STT image');
  const { code } = await streamCommand(runtime, ['pull', image], onLine, { timeoutMs: 1_800_000 });
  return code === 0;
}

export interface RunContainerOptions {
  runtime: ContainerRuntimeId;
  name: string;
  image: string;
  hostPort: number;
  containerPort: number;
  modelVolume: string;
  modelCachePath: string;
  gpu: boolean;
}

export function buildRunArgs(opts: RunContainerOptions): string[] {
  const args = [
    'run',
    '-d',
    '--name',
    opts.name,
    '--restart',
    'unless-stopped',
    // Loopback-only: the bridge proxies transcription, the server is never
    // reachable from the network even when the bridge is tunnelled.
    '-p',
    `127.0.0.1:${opts.hostPort}:${opts.containerPort}`,
    '-v',
    `${opts.modelVolume}:${opts.modelCachePath}`,
  ];

  if (opts.gpu) {
    args.push(
      ...(opts.runtime === 'docker'
        ? ['--gpus', 'all']
        : ['--device', 'nvidia.com/gpu=all', '--security-opt', 'label=disable']),
    );
  }

  args.push(opts.image);
  return args;
}

export async function runContainer(
  opts: RunContainerOptions,
  onLine: (line: string) => void,
): Promise<boolean> {
  const args = buildRunArgs(opts);
  onLine(`${opts.runtime} ${args.join(' ')}`);
  const { code } = await streamCommand(opts.runtime, args, onLine, { timeoutMs: 120_000 });
  return code === 0;
}

export async function stopContainer(
  runtime: ContainerRuntimeId,
  name: string,
): Promise<void> {
  await execFileAsync(runtime, ['stop', name], { timeout: 60_000 }).catch(() => undefined);
}

export async function removeContainer(
  runtime: ContainerRuntimeId,
  name: string,
): Promise<void> {
  await execFileAsync(runtime, ['rm', '-f', name], { timeout: 60_000 }).catch(() => undefined);
}

export async function startExistingContainer(
  runtime: ContainerRuntimeId,
  name: string,
): Promise<boolean> {
  try {
    await execFileAsync(runtime, ['start', name], { timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

export async function containerLogs(
  runtime: ContainerRuntimeId,
  name: string,
  lines = 60,
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      runtime,
      ['logs', '--tail', String(lines), name],
      { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return `${stdout}${stderr}`.trim();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
