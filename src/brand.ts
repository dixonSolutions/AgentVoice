/**
 * Product naming — the one place the public name lives (docs/46).
 *
 * The project has been renamed twice: AgentVoice → Squeakr (docs/45), then
 * Squeakr → Squeaky (docs/46), both in October 2026 — the display name, the
 * npm and distro packages, the CLI command, the environment variables, the
 * default home, the service units and the MCP server key. What an older
 * install left behind is still read — `SQUEAKR_*` / `AGENTVOICE_*` variables,
 * a not-yet-moved `~/.squeakr` or `~/.agentvoice` — until
 * `squeaky upgrade-from-squeakr` moves it. docs/46-rename-squeaky.md has the
 * whole list.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Display name — UI, CLI output, push titles, docs. */
export const PRODUCT_NAME = 'Squeaky';

/** The command people type. */
export const CLI_NAME = 'squeaky';

/** Prefix for every environment variable the bridge and CLI read. */
export const ENV_PREFIX = 'SQUEAKY_';

/** Prefixes the same variables had before each rename, newest first; still honoured. */
export const LEGACY_ENV_PREFIXES = ['SQUEAKR_', 'AGENTVOICE_'] as const;

/**
 * Read `SQUEAKY_<name>`, falling back to the pre-rename `SQUEAKR_<name>`, then
 * `AGENTVOICE_<name>`, so a systemd unit, shell profile or .env written for an
 * older name keeps working. An empty string counts as unset, as it does in the
 * shell scripts' `${SQUEAKY_X:-${SQUEAKR_X:-${AGENTVOICE_X:-…}}}`.
 */
export function brandEnv(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  for (const key of brandEnvKeys(name)) {
    const value = env[key];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/** Directory name of the default bridge home, under the user's home. */
export const HOME_DIR_NAME = '.squeaky';

/** The default home under each earlier name, newest first. Still used until it is migrated. */
export const LEGACY_HOME_DIR_NAMES = ['.squeakr', '.agentvoice'] as const;

/**
 * The default bridge home when nothing more specific (an env var, a cwd or
 * install root holding config.json) applies: `~/.squeaky`, unless only a
 * pre-rename `~/.squeakr` or `~/.agentvoice` has state in it — then that
 * (newest first), so an install that has not run `squeaky upgrade-from-squeakr`
 * yet keeps finding its config. After the upgrade the old directory is a
 * symlink to `~/.squeaky` and the first check wins.
 */
export function defaultHomeDir(user: string = homedir()): string {
  const current = join(user, HOME_DIR_NAME);
  if (hasHomeState(current)) return current;
  return legacyHomeDir(user) ?? current;
}

/** The newest pre-rename home under `user` that holds state, or null. */
export function legacyHomeDir(user: string = homedir()): string | null {
  for (const name of LEGACY_HOME_DIR_NAMES) {
    const dir = join(user, name);
    if (hasHomeState(dir)) return dir;
  }
  return null;
}

/** Same test as cli/home.ts#looksLikeHome, without importing the CLI. */
export function hasHomeState(dir: string): boolean {
  return existsSync(join(dir, 'config.json')) || existsSync(join(dir, 'data', 'state.db'));
}

/** Every spelling of a variable, current first — for scrubbing or reporting. */
export function brandEnvKeys(name: string): string[] {
  return [ENV_PREFIX, ...LEGACY_ENV_PREFIXES].map((prefix) => `${prefix}${name}`);
}
