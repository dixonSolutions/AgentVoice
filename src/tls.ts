/**
 * TLS material for the bridge's own listener — bring your own certificate.
 *
 * By default the bridge speaks plain HTTP and lets whatever is in front of it
 * own HTTPS: a tunnel (Tailscale, Cloudflare, ngrok, Dev Tunnels) or a reverse
 * proxy. Set HTTPS_CERT_PATH and HTTPS_KEY_PATH to have it terminate TLS
 * itself instead — for the LAN/mkcert case and for hosting straight off a
 * public IP, where there is no proxy to delegate to.
 *
 * Only honoured in serve mode; see getRunModeInfo(). Test mode is the local
 * dev profile, where the Angular dev server proxies to a plain-HTTP backend.
 *
 * Note for future edits: Fastify's `https` option is deliberately NOT used.
 * It resolves to the FastifyHttpsOptions overload, which retypes the instance
 * as FastifyInstance<https.Server> and so no longer matches the bare
 * FastifyInstance annotations that every src/routes module takes. src/server.ts
 * passes `serverFactory` instead, which keeps the default generics.
 */

import { readFileSync } from 'node:fs';
import { getConfig } from './config.js';

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
  certPath: string;
  keyPath: string;
}

/** `undefined` = not looked up yet, `null` = looked up and not configured. */
let cached: TlsMaterial | null | undefined;

/**
 * Load the configured cert/key, or null when TLS is not configured.
 *
 * Throws on a half-finished or unreadable configuration rather than falling
 * back to HTTP: quietly serving plaintext to an operator who believes the
 * listener is encrypted is the one failure mode worth crashing over.
 */
export function getTlsMaterial(): TlsMaterial | null {
  if (cached !== undefined) return cached;

  const { HTTPS_CERT_PATH: certPath, HTTPS_KEY_PATH: keyPath } = getConfig().env;

  if (!certPath && !keyPath) {
    cached = null;
    return cached;
  }

  if (!certPath || !keyPath) {
    throw new Error(
      `TLS is half-configured: ${certPath ? 'HTTPS_KEY_PATH' : 'HTTPS_CERT_PATH'} is not set. ` +
        'Set both to serve HTTPS, or neither to serve plain HTTP behind a proxy or tunnel.',
    );
  }

  try {
    cached = {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
      certPath,
      keyPath,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read the TLS cert/key (${certPath}, ${keyPath}): ${detail}`);
  }

  return cached;
}
