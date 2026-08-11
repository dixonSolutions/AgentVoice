/**
 * HostingProvider registry — one lookup table, keyed by `settings.hosting.provider`.
 *
 * Detection order (zero-touch migration for existing users):
 *   1. Explicit settings.hosting.provider
 *   2. An existing runModes.serve.publicBaseUrl ending in *.ts.net → Tailscale
 *      (current users' config.json already has this; no edits required)
 *   3. Fallback: manual (never silently assumes a public exposure method)
 */

import { getConfig, HOSTING_PROVIDERS, type HostingProviderId } from '../../config.js';
import { getRunModeInfo } from '../../runMode.js';
import { tailscaleProvider } from './tailscale.js';
import { cloudflareProvider } from './cloudflare.js';
import { ngrokProvider } from './ngrok.js';
import { devtunnelProvider } from './devtunnel.js';
import { lanProvider } from './lan.js';
import { localProvider } from './local.js';
import { manualProvider } from './manual.js';
import type { HostingProvider } from './types.js';

const PROVIDERS: Record<HostingProviderId, HostingProvider> = {
  tailscale: tailscaleProvider,
  cloudflare: cloudflareProvider,
  ngrok: ngrokProvider,
  devtunnel: devtunnelProvider,
  lan: lanProvider,
  local: localProvider,
  manual: manualProvider,
};

export function getHostingProvider(id: HostingProviderId): HostingProvider {
  return PROVIDERS[id];
}

export function listHostingProviders(): HostingProvider[] {
  return HOSTING_PROVIDERS.map((id) => PROVIDERS[id]);
}

function isTailscaleHostname(publicBaseUrl: string | undefined): boolean {
  if (!publicBaseUrl) return false;
  try {
    return /\.ts\.net$/i.test(new URL(publicBaseUrl).hostname);
  } catch {
    return false;
  }
}

/** Pure config-only detection — no CLI calls, safe to unit test. */
export function detectActiveHostingProviderId(): HostingProviderId {
  const explicit = getConfig().settings.hosting.provider;
  if (explicit) return explicit;

  const { publicBaseUrl } = getRunModeInfo(getConfig().settings);
  if (isTailscaleHostname(publicBaseUrl)) return 'tailscale';

  return 'manual';
}

export function getActiveHostingProvider(): HostingProvider {
  return PROVIDERS[detectActiveHostingProviderId()];
}
