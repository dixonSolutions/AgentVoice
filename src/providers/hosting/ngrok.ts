/**
 * ngrok hosting provider — `ngrok http <port>`. Simple and widely known, but
 * the free tier rotates the URL on every restart; a reserved domain
 * (`settings.hosting.ngrok.domain`, paid plans) gives a stable one.
 *
 * Requires NGROK_AUTHTOKEN in .env (never in config.json — it's a secret).
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { getConfig } from '../../config.js';
import { getRunModeInfo } from '../../runMode.js';
import { childLogger } from '../../log.js';
import { createBinResolver } from '../binResolve.js';
import { persistPublicBaseUrl } from './persist.js';
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
const log = childLogger('provider:hosting:ngrok');

const resolver = createBinResolver({
  envVar: 'NGROK_PATH',
  candidates: ['/usr/local/bin/ngrok', '/usr/bin/ngrok'],
  fallback: 'ngrok',
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

function startTunnel(port: number, domain?: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    stopRunner();
    const args = ['http', String(port), '--log=stdout', '--log-format=json'];
    if (domain) args.push(`--domain=${domain}`);

    const child = spawn(resolver.resolve(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    runner = child;
    let resolved = false;
    let buffer = '';

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (resolved) return;
      for (const line of buffer.split('\n')) {
        if (!line.includes('started tunnel')) continue;
        try {
          const parsed = JSON.parse(line) as { url?: string };
          if (parsed.url) {
            resolved = true;
            lastUrl = parsed.url;
            resolvePromise(parsed.url);
            return;
          }
        } catch {
          // not JSON yet — keep buffering
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('exit', (code) => {
      log.warn({ code }, 'ngrok process exited');
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
  if (!installed) return { active: false, installed: false, publicUrl: null, detail: 'ngrok not found' };
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
    log.info({ message }, 'ngrok setup step');
    onProgress({ message });
  };

  if (!resolver.isInstalled()) {
    return { ok: false, publicUrl: null, detail: 'ngrok not found. Install: https://ngrok.com/download' };
  }
  report('ngrok found.');

  const authtoken = getConfig().env.NGROK_AUTHTOKEN?.trim();
  if (!authtoken) {
    return {
      ok: false,
      publicUrl: null,
      detail: 'Set NGROK_AUTHTOKEN in .env first (from https://dashboard.ngrok.com/get-started/your-authtoken).',
    };
  }

  try {
    report('Applying auth token...');
    await execFileAsync(resolver.resolve(), ['config', 'add-authtoken', authtoken], { timeout: 10_000 });

    const domain = getConfig().settings.hosting.ngrok.domain?.trim() || undefined;
    report(domain ? `Starting tunnel on reserved domain ${domain}...` : 'Starting tunnel (rotating URL — reserve a domain for a stable one)...');
    const url = await startTunnel(backendPort(), domain);
    if (!url) {
      return { ok: false, publicUrl: null, detail: 'ngrok did not report a tunnel URL in time.' };
    }

    report(`Tunnel live at ${url}.`);
    persistPublicBaseUrl(url);
    onProgress({ message: 'Setup complete.', done: true });
    return {
      ok: true,
      publicUrl: url,
      detail: domain
        ? `Reserved domain ${domain} — stable across restarts.`
        : 'Free-tier URL rotates on restart — reserve a domain in ngrok for a stable one.',
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
  checks.push({ label: 'ngrok installed', ok: installed });
  if (!installed) return { ok: false, checks };

  checks.push({ label: 'NGROK_AUTHTOKEN set', ok: !!getConfig().env.NGROK_AUTHTOKEN });
  checks.push({ label: 'Tunnel process running', ok: runner !== null && !runner.killed });
  checks.push({ label: 'Public URL known', ok: !!lastUrl, detail: lastUrl ?? undefined });
  return { ok: checks.every((c) => c.ok), checks };
}

export const ngrokProvider: HostingProvider = {
  id: 'ngrok',
  displayName: 'ngrok',
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
