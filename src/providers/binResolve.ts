/**
 * Shared "find this CLI on disk" helper — every provider needs the same
 * env-override → common-install-dir → PATH-fallback search, just with
 * different candidates.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface BinResolveSpec {
  /** Env var that can pin an exact path (e.g. CODEX_PATH). */
  envVar?: string;
  /** Candidate absolute paths to probe, in order. */
  candidates: string[];
  /** Bare command name used as the final PATH-relative fallback. */
  fallback: string;
}

export function createBinResolver(spec: BinResolveSpec): {
  resolve(): string;
  isInstalled(): boolean;
  resolvedPath(): string | null;
} {
  let cached: string | null = null;

  function resolve(): string {
    if (cached && existsSync(cached)) return cached;

    const fromEnv = spec.envVar ? process.env[spec.envVar]?.trim() : undefined;
    if (fromEnv && existsSync(fromEnv)) {
      cached = fromEnv;
      return fromEnv;
    }

    for (const candidate of spec.candidates) {
      if (existsSync(candidate)) {
        cached = candidate;
        return candidate;
      }
    }

    return spec.fallback;
  }

  function isInstalled(): boolean {
    const path = resolve();
    return path !== spec.fallback || existsSync(path);
  }

  function resolvedPath(): string | null {
    const path = resolve();
    return path !== spec.fallback ? path : null;
  }

  return { resolve, isInstalled, resolvedPath };
}

export function homeCandidate(...segments: string[]): string {
  return join(homedir(), ...segments);
}
