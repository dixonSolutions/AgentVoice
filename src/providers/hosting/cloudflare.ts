/**
 * Cloudflare Tunnel (`cloudflared`) hosting provider.
 *
 * Two modes:
 *  - Quick tunnel (no hostname given): `cloudflared tunnel --url` prints a
 *    random *.trycloudflare.com URL — zero config, but the URL rotates every
 *    run and the tunnel only lives as long as this bridge process does.
 *  - Named tunnel (hostname given): requires `cloudflared tunnel login`
 *    (interactive browser auth — must be run once on a machine with a
 *    browser, or via `cloudflared tunnel login` on the host itself), then
 *    `tunnel create` + `route dns` give a stable hostname. We keep the runner
 *    process alive for the life of the bridge; wire it into your own systemd
 *    unit (see docs/25-hosting-providers.md) for a fully persistent setup.
 *
 * Public exposure warning: anyone with the URL can reach the bridge. Prefer
 * Cloudflare Access (Zero Trust) in front of named tunnels for real deployments.
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
const log = childLogger('provider:hosting:cloudflare');

const resolver = createBinResolver({
  envVar: 'CLOUDFLARED_PATH',
  candidates: ['/usr/local/bin/cloudflared', '/usr/bin/cloudflared'],
  fallback: 'cloudflared',
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

/** Spawn `cloudflared tunnel --url ...` (quick) or `tunnel run <name>` (named), scraping the URL. */
function startTunnel(args: string[], scrapeUrl: boolean): Promise<string | null> {
  return new Promise((resolvePromise) => {
    stopRunner();
    const child = spawn(resolver.resolve(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    runner = child;
    let resolved = false;
    let buffer = '';

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (!scrapeUrl || resolved) return;
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        resolved = true;
        lastUrl = match[0];
        resolvePromise(match[0]);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('exit', (code) => {
      log.warn({ code }, 'cloudflared tunnel process exited');
      if (runner === child) runner = null;
      if (!resolved) {
        resolved = true;
        resolvePromise(null);
      }
    });

    if (!scrapeUrl) {
      // Named tunnel — URL is the pre-registered hostname, not scraped from output.
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolvePromise(null);
        }
      }, 3_000);
    } else {
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolvePromise(null);
        }
      }, 20_000);
    }
  });
}

async function detect(): Promise<HostingDetectResult> {
  const installed = resolver.isInstalled();
  if (!installed) {
    return { active: false, installed: false, publicUrl: null, detail: 'cloudflared not found' };
  }
  const running = runner !== null && !runner.killed;
  return {
    active: running,
    installed: true,
    publicUrl: running ? lastUrl ?? getConfig().settings.runModes.serve.publicBaseUrl ?? null : null,
    detail: running ? undefined : 'no tunnel process running in this bridge session',
  };
}

async function getPublicUrl(): Promise<string | null> {
  return lastUrl ?? getConfig().settings.runModes.serve.publicBaseUrl ?? null;
}

async function sync(): Promise<void> {
  // Quick/named tunnels re-point automatically since the local upstream URL
  // (127.0.0.1:PORT) is fixed at spawn time; nothing to resync unless the
  // port itself changed, which requires a full setup() re-run.
}

async function setup(
  opts: HostingSetupOptions,
  onProgress: HostingProgressCallback,
): Promise<HostingSetupResult> {
  const report = (message: string) => {
    log.info({ message }, 'cloudflare setup step');
    onProgress({ message });
  };

  if (!resolver.isInstalled()) {
    return {
      ok: false,
      publicUrl: null,
      detail:
        'cloudflared not found. Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    };
  }
  report('cloudflared found.');

  const port = backendPort();
  const hostname = opts.hostname?.trim();

  try {
    if (!hostname) {
      report('Starting a quick tunnel (rotating *.trycloudflare.com URL)...');
      const url = await startTunnel(['tunnel', '--url', `http://127.0.0.1:${port}`], true);
      if (!url) {
        return { ok: false, publicUrl: null, detail: 'cloudflared did not print a tunnel URL in time.' };
      }
      report(`Quick tunnel live at ${url}.`);
      persistPublicBaseUrl(url);
      onProgress({ message: 'Setup complete.', done: true });
      return {
        ok: true,
        publicUrl: url,
        detail: 'Quick tunnel URL rotates on every bridge restart — use a named tunnel for a stable URL.',
      };
    }

    report('Named tunnel requested — checking for an existing Cloudflare login...');
    const tunnelName = `cursor-voice-${hostname.replace(/[^a-z0-9-]/gi, '-')}`;
    await execFileAsync(resolver.resolve(), ['tunnel', 'create', tunnelName], { timeout: 30_000 }).catch(
      (err) => log.debug({ err: String(err) }, 'tunnel create (may already exist)'),
    );
    report(`Routing DNS for ${hostname}...`);
    await execFileAsync(resolver.resolve(), ['tunnel', 'route', 'dns', tunnelName, hostname], {
      timeout: 30_000,
    });

    report('Starting the tunnel runner...');
    await startTunnel(['tunnel', 'run', '--url', `http://127.0.0.1:${port}`, tunnelName], false);
    const publicUrl = `https://${hostname}`;
    lastUrl = publicUrl;
    persistPublicBaseUrl(publicUrl);
    onProgress({ message: 'Setup complete.', done: true });
    return {
      ok: true,
      publicUrl,
      detail: 'Named tunnel started for this session — add cloudflared as a systemd unit for persistence across restarts.',
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
  checks.push({ label: 'cloudflared installed', ok: installed });
  if (!installed) return { ok: false, checks };

  checks.push({ label: 'Tunnel process running', ok: runner !== null && !runner.killed });
  checks.push({ label: 'Public URL known', ok: !!lastUrl, detail: lastUrl ?? undefined });
  return { ok: checks.every((c) => c.ok), checks };
}

export const cloudflareProvider: HostingProvider = {
  id: 'cloudflare',
  displayName: 'Cloudflare Tunnel',
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
