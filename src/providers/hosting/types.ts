/**
 * HostingProvider — the abstraction every tunnel / reverse-proxy option
 * (Tailscale, Cloudflare Tunnel, ngrok, Azure Dev Tunnels, LAN, local, manual)
 * implements. Tailscale stays the default; everything else is opt-in and
 * packagable — adding a provider means one new file + one registry entry.
 *
 * See docs/25-hosting-providers.md.
 */

import type { HostingProviderId } from '../../config.js';

export type { HostingProviderId };

export interface HostingCapabilities {
  /** Can `setup()` fully configure this provider without the user leaving the app. */
  autoSetup: boolean;
  /** Provider terminates HTTPS itself (no separate cert needed for a secure context). */
  providesTls: boolean;
  /** Reachable from the public internet (vs LAN-only / loopback-only). */
  publicExposure: boolean;
  /** Needs a CLI binary installed on the host. */
  cliRequired: boolean;
}

export interface HostingDetectResult {
  /** True if this provider is the one actually serving traffic right now. */
  active: boolean;
  /** True if the required CLI (when cliRequired) is present on PATH. */
  installed: boolean;
  publicUrl: string | null;
  detail?: string;
}

export interface HostingSetupOptions {
  /** Desired device name / stable subdomain, where the provider supports one. */
  hostname?: string;
  /** Headscale (or other self-hosted control-plane) URL — Tailscale only. */
  loginServer?: string;
}

export interface HostingProgressEvent {
  message: string;
  /** True on the final event (success or failure). */
  done?: boolean;
  error?: string;
}

export type HostingProgressCallback = (event: HostingProgressEvent) => void;

export interface HostingSetupResult {
  ok: boolean;
  publicUrl: string | null;
  detail: string;
}

export interface HostingDoctorCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface HostingDoctorResult {
  ok: boolean;
  checks: HostingDoctorCheck[];
}

export interface HostingProvider {
  readonly id: HostingProviderId;
  readonly displayName: string;
  readonly capabilities: HostingCapabilities;

  /** Cheap, side-effect-free probe: is this provider installed/configured/serving? */
  detect(): Promise<HostingDetectResult>;

  /** Current public URL, if any (may re-probe the CLI; a few seconds). */
  getPublicUrl(): Promise<string | null>;

  /**
   * Full one-click setup: install/authenticate the CLI if needed, point it at
   * the bridge's local port, and persist any resulting config. Streams
   * human-readable progress via onProgress (reused by the control-socket
   * live-log pattern).
   */
  setup(opts: HostingSetupOptions, onProgress: HostingProgressCallback): Promise<HostingSetupResult>;

  /** Idempotent re-sync of the proxy/tunnel target after a port or restart change. */
  sync(): Promise<void>;

  /** Read-only health checks surfaced in the Config → Serve/Network doctor panel. */
  doctor(): Promise<HostingDoctorResult>;
}
