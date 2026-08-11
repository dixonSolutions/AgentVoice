/**
 * LAN hosting provider — bind 0.0.0.0 and advertise this machine's local
 * network IP. No CLI, no account, no public exposure: the phone must be on
 * the same Wi-Fi/network. Good for quick testing without any tunnel setup.
 *
 * Phone mic capture (`getUserMedia`) requires a secure context, and plain
 * HTTP over a LAN IP is not one. `settings.hosting.lan.useTls` generates a
 * mkcert cert for the LAN IP as a starting point; the bridge itself only
 * speaks HTTP today, so terminate TLS with a lightweight reverse proxy
 * (Caddy/nginx) in front using that cert — see docs/25-hosting-providers.md.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
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
const log = childLogger('provider:hosting:lan');

const mkcertResolver = createBinResolver({
  envVar: 'MKCERT_PATH',
  candidates: ['/usr/local/bin/mkcert', '/usr/bin/mkcert'],
  fallback: 'mkcert',
});

/** First non-loopback, non-VPN IPv4 address — skips tailscale0, wg/utun interfaces, and the CGNAT range. */
function findLanIp(): string | null {
  const interfaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs || /^(tailscale|wg|utun|docker|br-|veth)/i.test(name)) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('100.64.') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr.address)) {
        continue; // Tailscale's CGNAT range, in case the interface name didn't match above.
      }
      return addr.address;
    }
  }
  return null;
}

function backendPort(): number {
  return getRunModeInfo(getConfig().settings).backendPort;
}

async function detect(): Promise<HostingDetectResult> {
  const ip = findLanIp();
  if (!ip) return { active: false, installed: true, publicUrl: null, detail: 'No LAN interface found' };
  // The bridge itself only serves HTTP; a fronting reverse proxy owns HTTPS.
  return { active: true, installed: true, publicUrl: `http://${ip}:${backendPort()}` };
}

function hasHttpsMaterial(): boolean {
  const { HTTPS_CERT_PATH, HTTPS_KEY_PATH } = getConfig().env;
  return !!HTTPS_CERT_PATH && !!HTTPS_KEY_PATH && existsSync(HTTPS_CERT_PATH) && existsSync(HTTPS_KEY_PATH);
}

async function getPublicUrl(): Promise<string | null> {
  const result = await detect();
  return result.publicUrl;
}

async function sync(): Promise<void> {
  // Nothing to resync — the OS routes LAN traffic to whichever port we bind.
}

async function setup(
  _opts: HostingSetupOptions,
  onProgress: HostingProgressCallback,
): Promise<HostingSetupResult> {
  const report = (message: string) => {
    log.info({ message }, 'lan setup step');
    onProgress({ message });
  };

  const ip = findLanIp();
  if (!ip) {
    return { ok: false, publicUrl: null, detail: 'No non-loopback LAN interface found on this host.' };
  }
  report(`LAN IP detected: ${ip}`);

  const wantsTls = getConfig().settings.hosting.lan.useTls;
  const httpUrl = `http://${ip}:${backendPort()}`;

  if (!wantsTls) {
    persistPublicBaseUrl(httpUrl);
    onProgress({ message: 'Setup complete (plain HTTP — mic capture needs a secure context on most browsers).', done: true });
    return {
      ok: true,
      publicUrl: httpUrl,
      detail: 'HTTP-only. Enable useTls for mkcert cert generation, then front the bridge with a TLS-terminating reverse proxy.',
    };
  }

  if (hasHttpsMaterial()) {
    persistPublicBaseUrl(httpUrl);
    onProgress({ message: 'Setup complete — TLS material already present in .env.', done: true });
    return {
      ok: true,
      publicUrl: httpUrl,
      detail: 'HTTPS_CERT_PATH/HTTPS_KEY_PATH are set — point your reverse proxy at them; the bridge itself still serves plain HTTP on this port.',
    };
  }

  if (!mkcertResolver.isInstalled()) {
    return {
      ok: false,
      publicUrl: null,
      detail: 'useTls is on but no cert is configured and mkcert is not installed. Install: https://github.com/FiloSottile/mkcert',
    };
  }

  try {
    report(`Generating a local cert for ${ip} with mkcert...`);
    const certDir = `${process.cwd()}/certs`;
    await execFileAsync('mkdir', ['-p', certDir]).catch(() => {});
    const certPath = `${certDir}/lan-cert.pem`;
    const keyPath = `${certDir}/lan-key.pem`;
    await execFileAsync(
      mkcertResolver.resolve(),
      ['-cert-file', certPath, '-key-file', keyPath, ip, 'localhost', '127.0.0.1'],
      { timeout: 20_000, cwd: certDir },
    );
    persistPublicBaseUrl(httpUrl);
    onProgress({
      message: `Cert written to ${certPath}. Point a reverse proxy (Caddy/nginx) at it in front of ${httpUrl} for HTTPS.`,
      done: true,
    });
    return {
      ok: true,
      publicUrl: httpUrl,
      detail: `Cert generated but not wired into the bridge — front it with a reverse proxy:\n  cert: ${certPath}\n  key:  ${keyPath}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    onProgress({ message: `mkcert failed: ${detail}`, done: true, error: detail });
    return { ok: false, publicUrl: null, detail };
  }
}

async function doctor(): Promise<HostingDoctorResult> {
  const checks: HostingDoctorResult['checks'] = [];
  const ip = findLanIp();
  checks.push({ label: 'LAN interface found', ok: !!ip, detail: ip ?? undefined });
  checks.push({ label: 'Bridge binds 0.0.0.0 (serve mode)', ok: getConfig().settings.runMode === 'serve' });
  if (getConfig().settings.hosting.lan.useTls) {
    checks.push({ label: 'HTTPS cert/key configured', ok: hasHttpsMaterial() });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export const lanProvider: HostingProvider = {
  id: 'lan',
  displayName: 'Local network (LAN)',
  capabilities: {
    autoSetup: true,
    providesTls: false,
    publicExposure: false,
    cliRequired: false,
  } satisfies HostingCapabilities,
  detect,
  getPublicUrl,
  setup,
  sync,
  doctor,
};
