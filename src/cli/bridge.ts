/**
 * Finding the running bridge and asking it how it is.
 *
 * Port resolution mirrors src/runMode.ts — `settings.runMode` picks which entry
 * of `settings.runModes` supplies the port — with one deliberate difference:
 * the bridge lets `NODE_ENV=development` force the test profile, and the CLI
 * cannot see the environment the *service* was started with. So when the
 * configured port is silent we also probe the other profile's port and say so,
 * rather than reporting "down" about a bridge that is plainly up on 8787.
 *
 * node:http(s) rather than fetch, because a bring-your-own-cert listener is
 * typically mkcert- or self-signed and fetch gives no way to relax
 * verification. Identity is not what this probe establishes — it is a liveness
 * check against 127.0.0.1, where reaching the port at all is the assurance.
 */

import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { envValue, readConfig, type ConfigRead } from './home.js';

export interface Health {
  status?: string;
  db?: string;
  projects?: number;
  cliVersion?: string | null;
  agentClient?: string;
  appVersion?: string;
  gitCommit?: string | null;
  runMode?: string;
  backendUrl?: string;
  webUrl?: string;
  publicBaseUrl?: string | null;
  useDevWebServer?: boolean;
}

export interface Endpoint {
  url: string;
  port: number;
  /** Which config profile this port came from. */
  from: string;
}

/** Does the bridge terminate TLS itself? Mirrors src/tls.ts's two env vars. */
function servesHttps(home: string): boolean {
  const cert = envValue(home, 'HTTPS_CERT_PATH')?.trim();
  const key = envValue(home, 'HTTPS_KEY_PATH')?.trim();
  return Boolean(cert && key && existsSync(cert) && existsSync(key));
}

/**
 * Every address the bridge could plausibly be listening on, best guess first.
 * The configured profile leads; the other profile follows because `npm run dev`
 * overrides runMode from the environment.
 */
export function candidateEndpoints(home: string, cfg: ConfigRead): Endpoint[] {
  const settings = cfg.config?.settings;
  const runMode = settings?.runMode === 'serve' ? 'serve' : 'test';
  const servePort = settings?.runModes?.serve?.backendPort;
  const testPort = settings?.runModes?.test?.backendPort;
  const scheme = servesHttps(home) ? 'https' : 'http';

  const ordered: Array<[number | undefined, string]> =
    runMode === 'serve'
      ? [
          [servePort, 'config.json settings.runModes.serve.backendPort'],
          [testPort, 'config.json settings.runModes.test.backendPort'],
        ]
      : [
          [testPort, 'config.json settings.runModes.test.backendPort'],
          [servePort, 'config.json settings.runModes.serve.backendPort'],
        ];

  const envPort = Number(envValue(home, 'PORT'));
  if (Number.isInteger(envPort) && envPort > 0) ordered.push([envPort, '.env PORT']);

  const seen = new Set<number>();
  const endpoints: Endpoint[] = [];
  for (const [port, from] of ordered) {
    if (!port || seen.has(port)) continue;
    seen.add(port);
    // Test mode never terminates TLS itself (src/runMode.ts), so only the serve
    // profile inherits the https scheme.
    const https = scheme === 'https' && from.includes('serve');
    endpoints.push({ port, from, url: `${https ? 'https' : 'http'}://127.0.0.1:${port}` });
  }
  return endpoints;
}

export interface Probe {
  endpoint: Endpoint;
  ok: boolean;
  health: Health | null;
  detail: string | null;
  /** The port answered TCP but did not speak our /healthz. */
  foreign: boolean;
}

export async function probeHealth(endpoint: Endpoint, timeoutMs = 4000): Promise<Probe> {
  const url = `${endpoint.url}/healthz`;
  const https = url.startsWith('https:');

  try {
    const response = await new Promise<{ status: number; text: string }>((settle, reject) => {
      const req = (https ? httpsRequest : httpRequest)(
        url,
        { timeout: timeoutMs, ...(https ? { rejectUnauthorized: false } : {}) },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => settle({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
      req.on('error', reject);
      req.end();
    });

    if (response.status < 200 || response.status >= 300) {
      return {
        endpoint,
        ok: false,
        health: null,
        detail: `HTTP ${response.status}`,
        foreign: true,
      };
    }
    const health = JSON.parse(response.text) as Health;
    return {
      endpoint,
      ok: health.status === 'ok',
      health,
      detail: health.status === 'ok' ? null : `status=${String(health.status)}`,
      foreign: false,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // ECONNREFUSED means nothing is listening; anything else means something
    // is there but is not us.
    return {
      endpoint,
      ok: false,
      health: null,
      detail,
      foreign: !detail.includes('ECONNREFUSED'),
    };
  }
}

export interface BridgeReport {
  /** The address the config points at, whether or not it answered. */
  configured: Endpoint | null;
  /** The address that actually answered /healthz, if any. */
  answering: Probe | null;
  /** Every probe attempted, in order. */
  probes: Probe[];
}

export async function findBridge(home: string, cfg = readConfig(home)): Promise<BridgeReport> {
  const endpoints = candidateEndpoints(home, cfg);
  const probes: Probe[] = [];
  for (const endpoint of endpoints) {
    const probe = await probeHealth(endpoint);
    probes.push(probe);
    if (probe.ok) return { configured: endpoints[0] ?? null, answering: probe, probes };
  }
  return { configured: endpoints[0] ?? null, answering: null, probes };
}
