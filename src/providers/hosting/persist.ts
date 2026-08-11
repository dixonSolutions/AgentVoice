/**
 * Shared config-write helpers for hosting providers — keeps disk I/O out of
 * each provider file and in one reviewable place.
 */

import { readConfigFile, writeConfigFile } from '../../state/configFile.js';
import type { HostingProviderId, HostingSettings } from '../../config.js';

/** Persist the public URL a provider's setup() discovered, for healthz/PWA display. */
export function persistPublicBaseUrl(url: string): void {
  const cfg = readConfigFile();
  cfg.settings.runModes.serve.publicBaseUrl = url;
  writeConfigFile(cfg);
}

/** Shallow-merge a patch into settings.hosting.<sectionId> (e.g. devtunnel.tunnelId). */
export function persistHostingSection<K extends keyof Omit<HostingSettings, 'provider'>>(
  section: K,
  patch: Partial<HostingSettings[K]>,
): void {
  const cfg = readConfigFile();
  cfg.settings.hosting = {
    ...cfg.settings.hosting,
    [section]: { ...cfg.settings.hosting[section], ...patch },
  };
  writeConfigFile(cfg);
}

/** Persist the explicit provider override (undefined = back to auto-detect). */
export function persistHostingProvider(provider: HostingProviderId | undefined): void {
  const cfg = readConfigFile();
  cfg.settings.hosting = { ...cfg.settings.hosting, provider };
  writeConfigFile(cfg);
}
