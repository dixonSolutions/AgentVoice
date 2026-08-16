/**
 * OS-aware host paths shared by the bridge and the agent providers.
 *
 * Per-CLI config locations live in providers/agents/<client>.ts — this module
 * only knows about the host itself (home dir, OS, bridge scratch dir).
 */

import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type HostOs = 'windows' | 'macos' | 'linux' | 'unknown';

export function detectHostOs(): HostOs {
  const p = platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  if (p === 'linux') return 'linux';
  return 'unknown';
}

/** User home directory (Windows: %USERPROFILE%, macOS/Linux: $HOME). */
export function resolveUserHome(): string {
  return homedir();
}

/**
 * Preferred root for cursor-voice user files on this machine.
 * Uses ~/Projects when present, otherwise the user home directory.
 */
export function resolveUserProjectsRoot(): string {
  const home = resolveUserHome();
  const projectsDir = join(home, 'Projects');
  if (existsSync(projectsDir)) return projectsDir;
  return home;
}

/**
 * Bridge-owned scratch directory (next to the SQLite file) for generated files
 * we hand to a CLI, such as Claude Code's `--mcp-config` JSON. Kept out of the
 * user's home so a stale copy can never outlive an uninstall.
 */
export function resolveBridgeDataDir(): string {
  const dbPath = process.env.DB_PATH ?? './data/state.db';
  return resolve(dirname(dbPath));
}

/** Human-readable path label for logs (tilde when under home). */
export function formatPathForLog(absolutePath: string): string {
  const home = resolveUserHome();
  if (absolutePath === home) return '~';
  if (absolutePath.startsWith(`${home}/`) || absolutePath.startsWith(`${home}\\`)) {
    return `~${absolutePath.slice(home.length)}`;
  }
  return absolutePath;
}
