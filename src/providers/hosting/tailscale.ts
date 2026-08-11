/**
 * Tailscale (and Headscale) hosting provider — the default. Ports the logic
 * from scripts/setup.sh (L97-124) and scripts/sync-tailscale-serve.sh into TS
 * so the setup wizard and the bash scripts never drift apart.
 *
 * `tailscale up --hostname=` names this device in the tailnet; `--login-server=`
 * points at a self-hosted Headscale control server instead of Tailscale's own.
 * `tailscale serve` terminates HTTPS and reverse-proxies to the bridge's local
 * port — no separate cert management needed.
 */

import { execFile } from 'node:child_process';
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
const log = childLogger('provider:hosting:tailscale');

const resolver = createBinResolver({
  envVar: 'TAILSCALE_PATH',
  candidates: ['/usr/bin/tailscale', '/usr/local/bin/tailscale'],
  fallback: 'tailscale',
});

interface TailscaleStatusSelf {
  DNSName?: string;
  Online?: boolean;
}

async function readStatus(): Promise<{ dnsName: string | null; online: boolean } | null> {
  try {
    const { stdout } = await execFileAsync(resolver.resolve(), ['status', '--json'], {
      timeout: 8_000,
    });
    const parsed = JSON.parse(stdout) as { Self?: TailscaleStatusSelf };
    const dnsName = parsed.Self?.DNSName?.replace(/\.$/, '') || null;
    return { dnsName, online: parsed.Self?.Online === true };
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err) }, 'tailscale status failed');
    return null;
  }
}

async function serveTarget(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(resolver.resolve(), ['serve', 'status'], { timeout: 8_000 });
    const match = stdout.match(/127\.0\.0\.1:(\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function backendPort(): number {
  return getRunModeInfo(getConfig().settings).backendPort;
}

async function detect(): Promise<HostingDetectResult> {
  const installed = resolver.isInstalled();
  if (!installed) {
    return { active: false, installed: false, publicUrl: null, detail: 'tailscale CLI not found' };
  }
  const status = await readStatus();
  if (!status?.dnsName) {
    return { active: false, installed: true, publicUrl: null, detail: 'not signed in to a tailnet' };
  }
  const port = await serveTarget();
  const active = port === String(backendPort());
  return {
    active,
    installed: true,
    publicUrl: `https://${status.dnsName}`,
    detail: active ? undefined : `tailscale serve is not pointed at :${backendPort()} yet`,
  };
}

async function getPublicUrl(): Promise<string | null> {
  const configured = getConfig().settings.runModes.serve.publicBaseUrl;
  if (configured) return configured;
  const status = await readStatus();
  return status?.dnsName ? `https://${status.dnsName}` : null;
}

async function sync(): Promise<void> {
  const port = backendPort();
  const current = await serveTarget();
  if (current === String(port)) return;
  await execFileAsync(resolver.resolve(), ['serve', 'reset'], { timeout: 8_000 }).catch(() => {});
  await execFileAsync(resolver.resolve(), ['serve', '--bg', `http://127.0.0.1:${port}`], {
    timeout: 8_000,
  });
}

async function setup(
  opts: HostingSetupOptions,
  onProgress: HostingProgressCallback,
): Promise<HostingSetupResult> {
  const bin = resolver.resolve();
  const report = (message: string) => {
    log.info({ message }, 'tailscale setup step');
    onProgress({ message });
  };

  if (!resolver.isInstalled()) {
    return {
      ok: false,
      publicUrl: null,
      detail:
        'tailscale CLI not found. Install it first: curl -fsSL https://tailscale.com/install.sh | sh',
    };
  }
  report('Tailscale CLI found.');

  try {
    const upArgs = ['up'];
    if (opts.hostname) upArgs.push(`--hostname=${opts.hostname}`);
    if (opts.loginServer) upArgs.push(`--login-server=${opts.loginServer}`);

    const existing = await readStatus();
    if (!existing?.dnsName) {
      report('Signing in to your tailnet (this device will need approval if required)...');
      await execFileAsync(bin, upArgs, { timeout: 60_000 });
    } else if (opts.hostname || opts.loginServer) {
      report('Updating device name / login server...');
      await execFileAsync(bin, upArgs, { timeout: 60_000 });
    } else {
      report('Already signed in to a tailnet.');
    }

    if (opts.hostname || opts.loginServer) {
      persistHostingSection('tailscale', {
        hostname: opts.hostname,
        loginServer: opts.loginServer,
      });
    }

    await execFileAsync(bin, ['set', '--accept-dns=true'], { timeout: 10_000 }).catch(() => {
      log.warn('could not enable MagicDNS — run: tailscale set --accept-dns=true');
    });

    report('Configuring Tailscale Serve (HTTPS → this bridge)...');
    await sync();

    const status = await readStatus();
    if (!status?.dnsName) {
      return { ok: false, publicUrl: null, detail: 'Signed in, but no tailnet hostname was assigned yet.' };
    }

    const publicUrl = `https://${status.dnsName}`;
    persistPublicBaseUrl(publicUrl);
    report(`Bridge is reachable at ${publicUrl}.`);
    onProgress({ message: 'Setup complete.', done: true });
    return { ok: true, publicUrl, detail: 'Enable HTTPS certs in the Tailscale admin console if this is the first device.' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    onProgress({ message: `Setup failed: ${detail}`, done: true, error: detail });
    return { ok: false, publicUrl: null, detail };
  }
}

async function doctor(): Promise<HostingDoctorResult> {
  const checks: HostingDoctorResult['checks'] = [];

  const installed = resolver.isInstalled();
  checks.push({ label: 'tailscale CLI installed', ok: installed });
  if (!installed) return { ok: false, checks };

  const status = await readStatus();
  checks.push({ label: 'Signed in to a tailnet', ok: !!status?.dnsName, detail: status?.dnsName ?? undefined });
  checks.push({ label: 'Node is online', ok: status?.online === true });

  const port = await serveTarget();
  const wantPort = String(backendPort());
  checks.push({
    label: `tailscale serve → 127.0.0.1:${wantPort}`,
    ok: port === wantPort,
    detail: port ? `currently → 127.0.0.1:${port}` : 'not configured',
  });

  return { ok: checks.every((c) => c.ok), checks };
}

export const tailscaleProvider: HostingProvider = {
  id: 'tailscale',
  displayName: 'Tailscale',
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
