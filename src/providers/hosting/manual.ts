/**
 * Manual (bring-your-own reverse proxy) hosting provider — for anyone already
 * running nginx/Caddy/their own tunnel in front of the bridge. `setup()` just
 * validates and stores the URL they give it; this app makes no assumptions
 * about how it got there. Also the safe fallback when no other provider is
 * detected (see registry.ts) — never silently exposes anything.
 */

import { getConfig } from '../../config.js';
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

async function detect(): Promise<HostingDetectResult> {
  const publicUrl = getConfig().settings.runModes.serve.publicBaseUrl ?? null;
  return { active: !!publicUrl, installed: true, publicUrl, detail: publicUrl ? undefined : 'No publicBaseUrl set yet' };
}

async function getPublicUrl(): Promise<string | null> {
  return getConfig().settings.runModes.serve.publicBaseUrl ?? null;
}

async function sync(): Promise<void> {
  // Nothing to sync — the user's own proxy owns the routing.
}

async function setup(
  opts: HostingSetupOptions,
  onProgress: HostingProgressCallback,
): Promise<HostingSetupResult> {
  const hostname = opts.hostname?.trim();
  if (!hostname) {
    return {
      ok: false,
      publicUrl: null,
      detail: 'Provide the public HTTPS URL your reverse proxy already serves (as "hostname", e.g. https://voice.example.com).',
    };
  }
  const url = hostname.startsWith('http') ? hostname : `https://${hostname}`;
  try {
    new URL(url);
  } catch {
    return { ok: false, publicUrl: null, detail: `"${hostname}" is not a valid URL.` };
  }
  persistPublicBaseUrl(url);
  onProgress({ message: `Saved ${url} as the public URL.`, done: true });
  return { ok: true, publicUrl: url, detail: 'Make sure your reverse proxy forwards to this bridge\u2019s local port and preserves WebSocket upgrades.' };
}

async function doctor(): Promise<HostingDoctorResult> {
  const publicUrl = getConfig().settings.runModes.serve.publicBaseUrl;
  return {
    ok: !!publicUrl,
    checks: [{ label: 'publicBaseUrl configured', ok: !!publicUrl, detail: publicUrl ?? undefined }],
  };
}

export const manualProvider: HostingProvider = {
  id: 'manual',
  displayName: 'Manual (bring your own proxy)',
  capabilities: {
    autoSetup: false,
    providesTls: false,
    publicExposure: true,
    cliRequired: false,
  } satisfies HostingCapabilities,
  detect,
  getPublicUrl,
  setup,
  sync,
  doctor,
};
