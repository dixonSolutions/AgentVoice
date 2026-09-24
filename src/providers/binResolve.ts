/**
 * Shared "find this CLI on disk" helper — every provider needs the same
 * env-override → common-install-dir → PATH-fallback search, just with
 * different candidates.
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * On Windows a CLI is `claude.exe` or `codex.cmd`, never the bare name; try
 * each PATHEXT suffix. Elsewhere the name is the file.
 */
function withExecutableSuffixes(path: string): string[] {
  if (process.platform !== 'win32') return [path];
  const exts = (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [path, ...exts.map((ext) => `${path}${ext}`)];
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First existing file among `path` and its Windows executable variants. */
function existingExecutable(path: string): string | null {
  return withExecutableSuffixes(path).find(isExecutableFile) ?? null;
}

/**
 * Look a bare command up on PATH, the way a shell would. The bridge spawns the
 * fallback name and lets the OS search, but "is it installed?" has to answer
 * before spawning — a CLI installed only on PATH (apt, Homebrew, an nvm global)
 * is installed.
 */
export function whichSync(command: string, pathValue = process.env['PATH'] ?? ''): string | null {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const found = existingExecutable(join(dir, command));
    if (found) return found;
  }
  return null;
}

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
  /**
   * The env var that pins this CLI's path, so the config screen can name it
   * per provider instead of listing two of the four (docs/39 A7).
   */
  envVar(): string | null;
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
      const found = existingExecutable(candidate);
      if (found) {
        cached = found;
        return found;
      }
    }

    return spec.fallback;
  }

  function isInstalled(): boolean {
    const path = resolve();
    return path !== spec.fallback || whichSync(path) !== null;
  }

  function resolvedPath(): string | null {
    const path = resolve();
    return path !== spec.fallback ? path : null;
  }

  return { resolve, isInstalled, resolvedPath, envVar: () => spec.envVar ?? null };
}

export function homeCandidate(...segments: string[]): string {
  return join(homedir(), ...segments);
}
