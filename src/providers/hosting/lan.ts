/**
 * LAN hosting provider — bind 0.0.0.0 and advertise this machine's local
 * network IP. No CLI, no account, no public exposure: the phone must be on
 * the same Wi-Fi/network. Good for quick testing without any tunnel setup.
 *
 * Phone mic capture (`getUserMedia`) requires a secure context, and plain
 * HTTP over a LAN IP is not one. `settings.hosting.lan.useTls` generates a
 * mkcert cert for the LAN IP and writes its paths to HTTPS_CERT_PATH /
 * HTTPS_KEY_PATH, which the bridge serves directly (src/tls.ts) after a
 * restart — no reverse proxy needed. See docs/25-hosting-providers.md.
 *
 * The phone must still trust the mkcert CA, or the browser rejects the cert
 * before any mic prompt appears; `mkcert -CAROOT` holds the root to install.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { getConfig } from '../../config.js';
import { getRunModeInfo } from '../../runMode.js';
import { childLogger } from '../../log.js';
import { createBinResolver } from '../binResolve.js';
import { updateHostingEnvKeys } from '../../state/envFile.js';
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

/** https once a cert is configured and the bridge has been restarted with it. */
function lanUrl(ip: string): string {
  const scheme = getRunModeInfo(getConfig().settings).tls ? 'https' : 'http';
  return `${scheme}://${ip}:${backendPort()}`;
}

async function detect(): Promise<HostingDetectResult> {
  const ip = findLanIp();
  if (!ip) return { active: false, installed: true, publicUrl: null, detail: 'No LAN interface found' };
  return { active: true, installed: true, publicUrl: lanUrl(ip) };
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
  const httpsUrl = `https://${ip}:${backendPort()}`;

  if (!wantsTls) {
    persistPublicBaseUrl(httpUrl);
    onProgress({ message: 'Setup complete (plain HTTP — mic capture needs a secure context on most browsers).', done: true });
    return {
      ok: true,
      publicUrl: httpUrl,
      detail: 'HTTP-only. Enable useTls to generate a mkcert certificate and have the bridge serve HTTPS itself.',
    };
  }

  if (hasHttpsMaterial()) {
    persistPublicBaseUrl(httpsUrl);
    onProgress({ message: 'Setup complete — TLS material already present in .env.', done: true });
    return {
      ok: true,
      publicUrl: httpsUrl,
      detail: 'HTTPS_CERT_PATH/HTTPS_KEY_PATH are set and the bridge serves them directly. Restart it if you just changed the files.',
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
    // Wire the cert straight into .env so the bridge serves it on next boot;
    // without this the generated pair would sit on disk unused.
    updateHostingEnvKeys({ HTTPS_CERT_PATH: certPath, HTTPS_KEY_PATH: keyPath });
    persistPublicBaseUrl(httpsUrl);
    onProgress({
      message: `Cert written to ${certPath} and wired into .env. Restart the bridge to serve ${httpsUrl}.`,
      done: true,
    });
    return {
      ok: true,
      publicUrl: httpsUrl,
      detail:
        `Cert generated and configured:\n  cert: ${certPath}\n  key:  ${keyPath}\n` +
        'Restart the bridge to pick it up, and install the mkcert root CA on the phone ' +
        "(`mkcert -CAROOT`) — otherwise the browser rejects the certificate before it ever asks for the mic.",
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
    const configured = hasHttpsMaterial();
    checks.push({
      label: 'HTTPS cert/key configured',
      ok: configured,
      detail: configured ? undefined : 'Run setup to generate one with mkcert.',
    });
    // Configured-but-not-loaded means the cert was added after this process
    // booted; the listener stays HTTP until a restart, which is exactly the
    // state most likely to be mistaken for working HTTPS.
    const serving = !!getRunModeInfo(getConfig().settings).tls;
    checks.push({
      label: 'Bridge is serving HTTPS',
      ok: serving,
      detail: serving
        ? undefined
        : configured
          ? 'Cert configured but this process started without it — restart the bridge.'
          : 'Listener is plain HTTP; phone mic capture needs a secure context.',
    });
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
