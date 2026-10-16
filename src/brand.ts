/**
 * Product naming — the one place the public name lives (docs/44).
 *
 * The project was renamed AgentVoice → Squeakr in October 2026. Stage A of
 * that rename changed what people *see and type*: the display name, the npm
 * package, the CLI command, the environment variables and the default home
 * (moved by `squeakr upgrade-from-agentvoice`). The names a running install is
 * *built on* — the service units, the distro package, the MCP server key —
 * are unchanged for now, so an upgrade never strands a running bridge.
 * docs/44-rename-squeakr.md lists both sides.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Display name — UI, CLI output, push titles, docs. */
export const PRODUCT_NAME = 'Squeakr';

/** The command people type. */
export const CLI_NAME = 'squeakr';

/** Prefix for every environment variable the bridge and CLI read. */
export const ENV_PREFIX = 'SQUEAKR_';

/** Prefix the same variables had before the rename; still honoured. */
export const LEGACY_ENV_PREFIX = 'AGENTVOICE_';

/**
 * Read `SQUEAKR_<name>`, falling back to the pre-rename `AGENTVOICE_<name>`, so
 * a systemd unit, shell profile or .env written for AgentVoice keeps working.
 * An empty string counts as unset, as it does in the shell scripts'
 * `${SQUEAKR_X:-${AGENTVOICE_X:-…}}`.
 */
export function brandEnv(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const current = env[`${ENV_PREFIX}${name}`];
  if (current !== undefined && current !== '') return current;
  const legacy = env[`${LEGACY_ENV_PREFIX}${name}`];
  if (legacy !== undefined && legacy !== '') return legacy;
  return undefined;
}

/** Directory name of the default bridge home, under the user's home. */
export const HOME_DIR_NAME = '.squeakr';

/** The default home before the rename. Still used until it is migrated. */
export const LEGACY_HOME_DIR_NAME = '.agentvoice';

/**
 * The default bridge home when nothing more specific (an env var, a cwd or
 * install root holding config.json) applies: `~/.squeakr`, unless only the
 * pre-rename `~/.agentvoice` has state in it — then that, so an install that
 * has not run `squeakr upgrade-from-agentvoice` yet keeps finding its config.
 * After the upgrade `~/.agentvoice` is a symlink to `~/.squeakr` and the
 * first check wins.
 */
export function defaultHomeDir(user: string = homedir()): string {
  const current = join(user, HOME_DIR_NAME);
  const legacy = join(user, LEGACY_HOME_DIR_NAME);
  if (!hasHomeState(current) && hasHomeState(legacy)) return legacy;
  return current;
}

/** Same test as cli/home.ts#looksLikeHome, without importing the CLI. */
export function hasHomeState(dir: string): boolean {
  return existsSync(join(dir, 'config.json')) || existsSync(join(dir, 'data', 'state.db'));
}

/** Both spellings of a variable, current first — for scrubbing or reporting. */
export function brandEnvKeys(name: string): [string, string] {
  return [`${ENV_PREFIX}${name}`, `${LEGACY_ENV_PREFIX}${name}`];
}
