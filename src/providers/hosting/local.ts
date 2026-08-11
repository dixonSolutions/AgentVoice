/**
 * Local (loopback-only) hosting provider — no exposure at all, matches
 * `npm run dev` / test-mode behaviour. Useful as an explicit, documented
 * "I'm just testing on this machine" choice rather than an implicit default.
 */

import { getConfig } from '../../config.js';
import { getRunModeInfo } from '../../runMode.js';
import type {
  HostingCapabilities,
  HostingDetectResult,
  HostingDoctorResult,
  HostingProgressCallback,
  HostingProvider,
  HostingSetupOptions,
  HostingSetupResult,
} from './types.js';

function localUrl(): string {
  return `http://127.0.0.1:${getRunModeInfo(getConfig().settings).backendPort}`;
}

async function detect(): Promise<HostingDetectResult> {
  return { active: true, installed: true, publicUrl: localUrl() };
}

async function getPublicUrl(): Promise<string | null> {
  return localUrl();
}

async function sync(): Promise<void> {
  // Nothing to sync — always the current backend port on loopback.
}

async function setup(
  _opts: HostingSetupOptions,
  onProgress: HostingProgressCallback,
): Promise<HostingSetupResult> {
  onProgress({ message: 'Nothing to configure — loopback only.', done: true });
  return { ok: true, publicUrl: localUrl(), detail: 'Only reachable from this machine.' };
}

async function doctor(): Promise<HostingDoctorResult> {
  return { ok: true, checks: [{ label: 'Loopback bridge reachable', ok: true, detail: localUrl() }] };
}

export const localProvider: HostingProvider = {
  id: 'local',
  displayName: 'This machine only (local)',
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
