/**
 * How was this bridge installed, and therefore how does it update?
 *
 * There are two ways to be running AgentVoice, and they have nothing in common
 * when it comes to getting a newer one:
 *
 *   git  — a clone. Updating means fetch, rebase, install, build, restart, and
 *          "what version am I" is a branch and a commit. scripts/update.sh.
 *   npm  — `npm i -g agentvoice`. There is no repo to rebase; updating means
 *          asking the registry for a newer version and letting npm replace the
 *          package. "What version am I" is a semver string.
 *
 * Offering rebase buttons to someone who installed from npm is nonsense — there
 * is no branch, no commit, and no working tree to stash. Offering `npm i -g` to
 * a clone would silently install a *different* copy alongside the one they are
 * running. So the surface has to ask first, and this is where it asks.
 *
 * Detection is deliberately structural rather than a flag in config.json: a
 * config file gets copied between machines, and the answer has to describe the
 * install that is actually running right now.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childLogger } from '../log.js';

const log = childLogger('serve:install-mode');

export type InstallMode = 'git' | 'npm' | 'unknown';

export interface InstallModeInfo {
  mode: InstallMode;
  /** Directory the install lives in — repo root, or the package root. */
  root: string;
  /**
   * Why we decided this. Shown in the UI, because "your update button looks
   * different today" deserves an explanation rather than a mystery.
   */
  reason: string;
  /** Globally installed (`npm i -g`) rather than a local dependency. */
  global: boolean;
  /** The command that updates this install, for display. */
  updateCommand: string;
}

/** Package root: the directory holding our package.json, from dist/ or src/. */
function packageRoot(): string {
  // Compiled to dist/index.js, or run from src/serve/ under tsx. Walk up until
  // a package.json that is actually ours turns up.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Is this path inside a node_modules tree? That is the npm-install tell. */
function insideNodeModules(path: string): boolean {
  return path.split(sep).includes('node_modules');
}

let cached: InstallModeInfo | null = null;

/**
 * Work out how this bridge was installed.
 *
 * A `.git` directory at the package root beats everything: that is a clone,
 * even if someone also has the package installed elsewhere. Failing that,
 * living under node_modules means npm put it there.
 */
export function detectInstallMode(opts: { refresh?: boolean } = {}): InstallModeInfo {
  if (cached && !opts.refresh) return cached;

  const root = packageRoot();
  const npmInstalled = insideNodeModules(realpathOrSelf(root));

  let info: InstallModeInfo;
  if (existsSync(join(root, '.git'))) {
    info = {
      mode: 'git',
      root,
      reason: 'running from a git clone (.git found at the package root)',
      global: false,
      updateCommand: 'bash scripts/update.sh',
    };
  } else if (npmInstalled) {
    const global = !insideNodeModules(process.cwd());
    info = {
      mode: 'npm',
      root,
      reason: 'installed by npm (package lives under node_modules)',
      global,
      updateCommand: global
        ? 'npm install -g agentvoice@latest'
        : 'npm install agentvoice@latest',
    };
  } else {
    // An extracted tarball, a container image, a copied directory. We can still
    // restart and report health; we just cannot claim to know how to update it.
    info = {
      mode: 'unknown',
      root,
      reason: 'no .git and not under node_modules — update path cannot be determined',
      global: false,
      updateCommand: '',
    };
  }

  cached = info;
  log.info({ mode: info.mode, root: info.root, global: info.global }, 'install mode detected');
  return info;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Can this install be updated in place by the bridge itself? */
export function canSelfUpdate(info = detectInstallMode()): boolean {
  return info.mode === 'git' || info.mode === 'npm';
}

/** Test seam — forget the cached answer. */
export function resetInstallModeCache(): void {
  cached = null;
}
