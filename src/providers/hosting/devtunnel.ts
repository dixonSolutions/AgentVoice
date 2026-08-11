/**
 * Azure Dev Tunnels (`devtunnel` CLI) hosting provider — Microsoft-hosted
 * tunnels with a persistent tunnel ID across restarts (unlike ngrok's free
 * tier or cloudflared quick tunnels). Requires `devtunnel user login` once
 * (interactive; run manually on the host if headless login fails).
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { getConfig } from '../../config.js';
import { getRunModeInfo } from '../../runMode.js';
import { childLogger } from '../../log.js';
import { createBinResolver } from '../binResolve.js';
import { persistHostingSection, persistPublicBaseUrl } from './persist.js';
import type {
  HostingCapabilities,
  HostingDetectResult,
  HostingDoctorResult,
  HostingProgressCallback,
  HostingProvider,
  HostingSetupOptions,
  HostingSetupResult,
} from './types.js';

const execFileAsync = promisify(execFile);
const log = childLogger('provider:hosting:devtunnel');

const resolver = createBinResolver({
  envVar: 'DEVTUNNEL_PATH',
  candidates: ['/usr/local/bin/devtunnel', '/usr/bin/devtunnel'],
  fallback: 'devtunnel',
});

let runner: ChildProcess | null = null;
let lastUrl: string | null = null;

function backendPort(): number {
  return getRunModeInfo(getConfig().settings).backendPort;
}

function stopRunner(): void {
  if (runner && !runner.killed) runner.kill();
  runner = null;
}

async function isLoggedIn(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(resolver.resolve(), ['user', 'show'], { timeout: 8_000 });
    return !/not logged in/i.test(stdout);
  } catch {
    return false;
  }
}

function hostTunnel(tunnelId: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    stopRunner();
    const child = spawn(resolver.resolve(), ['host', tunnelId], { stdio: ['ignore', 'pipe', 'pipe'] });
    runner = child;
    let resolved = false;
    let buffer = '';

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (resolved) return;
      const match = buffer.match(/https:\/\/\S+\.devtunnels\.ms\S*/);
      if (match) {
        resolved = true;
        lastUrl = match[0].trim();
        resolvePromise(match[0].trim());
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('exit', (code) => {
      log.warn({ code }, 'devtunnel host process exited');
      if (runner === child) runner = null;
      if (!resolved) {
        resolved = true;
        resolvePromise(null);
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolvePromise(null);
      }
    }, 15_000);
  });
}

async function detect(): Promise<HostingDetectResult> {
  const installed = resolver.isInstalled();
  if (!installed) return { active: false, installed: false, publicUrl: null, detail: 'devtunnel CLI not found' };
  const running = runner !== null && !runner.killed;
  return {
    active: running,
    installed: true,
    publicUrl: running ? lastUrl : null,
    detail: running ? undefined : 'no tunnel process running in this bridge session',
  };
}

async function getPublicUrl(): Promise<string | null> {
  return lastUrl ?? getConfig().settings.runModes.serve.publicBaseUrl ?? null;
}

async function sync(): Promise<void> {
  // Local upstream is fixed at spawn time; nothing to resync short of a full setup() re-run.
}

async function setup(
  _opts: HostingSetupOptions,
  onProgress: HostingProgressCallback,
): Promise<HostingSetupResult> {
  const report = (message: string) => {
    log.info({ message }, 'devtunnel setup step');
    onProgress({ message });
  };

  if (!resolver.isInstalled()) {
    return {
      ok: false,
      publicUrl: null,
      detail: 'devtunnel CLI not found. Install: https://aka.ms/devtunnels/download',
    };
  }
  report('devtunnel CLI found.');

  try {
    if (!(await isLoggedIn())) {
      report('Not logged in — attempting `devtunnel user login` (needs a browser)...');
      await execFileAsync(resolver.resolve(), ['user', 'login'], { timeout: 60_000 });
    }

    let tunnelId = getConfig().settings.hosting.devtunnel.tunnelId?.trim();
    if (!tunnelId) {
      report('Creating a new tunnel...');
      const { stdout } = await execFileAsync(resolver.resolve(), ['create', '--allow-anonymous'], {
        timeout: 20_000,
      });
      const match = stdout.match(/Tunnel ID\s*:?\s*([\w-]+)/i);
      tunnelId = match?.[1];
      if (!tunnelId) {
        return { ok: false, publicUrl: null, detail: 'Could not parse a tunnel ID from `devtunnel create` output.' };
      }
      persistHostingSection('devtunnel', { tunnelId });
    }

    report(`Registering port ${backendPort()}...`);
    await execFileAsync(
      resolver.resolve(),
      ['port', 'create', '-t', tunnelId, '-p', String(backendPort()), '--protocol', 'https'],
      { timeout: 20_000 },
    ).catch((err) => log.debug({ err: String(err) }, 'port create (may already exist)'));

    report('Starting the tunnel host...');
    const url = await hostTunnel(tunnelId);
    if (!url) {
      return { ok: false, publicUrl: null, detail: 'devtunnel did not report a connect URL in time.' };
    }

    report(`Tunnel live at ${url}.`);
    persistPublicBaseUrl(url);
    onProgress({ message: 'Setup complete.', done: true });
    return {
      ok: true,
      publicUrl: url,
      detail: `tunnelId=${tunnelId} — saved to settings.hosting.devtunnel.tunnelId for reuse.`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    onProgress({ message: `Setup failed: ${detail}`, done: true, error: detail });
    return { ok: false, publicUrl: null, detail };
  }
}

async function doctor(): Promise<HostingDoctorResult> {
  const checks: HostingDoctorResult['checks'] = [];
  const installed = resolver.isInstalled();
  checks.push({ label: 'devtunnel CLI installed', ok: installed });
  if (!installed) return { ok: false, checks };

  checks.push({ label: 'Logged in', ok: await isLoggedIn() });
  checks.push({ label: 'Tunnel process running', ok: runner !== null && !runner.killed });
  checks.push({ label: 'Public URL known', ok: !!lastUrl, detail: lastUrl ?? undefined });
  return { ok: checks.every((c) => c.ok), checks };
}

export const devtunnelProvider: HostingProvider = {
  id: 'devtunnel',
  displayName: 'Azure Dev Tunnels',
  capabilities: {
    autoSetup: true,
    providesTls: true,
    publicExposure: true,
    cliRequired: true,
  } satisfies HostingCapabilities,
  detect,
  getPublicUrl,
  setup,
  sync,
  doctor,
};
