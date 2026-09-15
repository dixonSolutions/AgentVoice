/**
 * How was this bridge installed, and therefore how does it update?
 *
 * There are three ways to be running AgentVoice, and they have nothing in
 * common when it comes to getting a newer one:
 *
 *   git    — a clone. Updating means fetch, rebase, install, build, restart,
 *            and "what version am I" is a branch and a commit.
 *   npm    — `npm i -g @ratitisrad/agentvoice`. No repo to rebase; updating
 *            means asking the registry and letting npm replace the package.
 *   system — a .deb or .rpm (docs/38). The package manager owns the files, the
 *            bridge cannot write to them, and updating is `apt` or `dnf`. The
 *            in-app update button has to become a copyable command.
 *
 * Offering rebase buttons to someone who installed from npm is nonsense — there
 * is no branch, no commit, and no working tree to stash. Offering `npm i -g` to
 * a clone would silently install a *different* copy alongside the one they are
 * running. Offering either to a .deb install would fight the package manager.
 * So the surface has to ask first, and this is where it asks.
 *
 * Detection is deliberately structural rather than a flag in config.json: a
 * config file gets copied between machines, and the answer has to describe the
 * install that is actually running right now.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childLogger } from '../log.js';

const log = childLogger('serve:install-mode');

export type InstallMode = 'git' | 'npm' | 'system' | 'unknown';

/** Prefixes a distro package installs AgentVoice under. */
const SYSTEM_ROOTS = ['/usr/lib/agentvoice', '/usr/share/agentvoice', '/opt/agentvoice'];

/**
 * Marker the .deb / .rpm ships so the bridge can name the right update
 * command. A path check alone is not enough — someone may well untar a build
 * into /opt — so the marker is authoritative and the path is the fallback.
 */
const INSTALL_SOURCE_MARKER = '.install-source';

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
  const system = detectSystemPackage(root);

  let info: InstallModeInfo;
  if (system) {
    info = system;
  } else if (existsSync(join(root, '.git'))) {
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
        ? 'npm install -g @ratitisrad/agentvoice@latest'
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

/**
 * Is this a distro package?
 *
 * Checked *before* the node_modules test: a .deb ships a pruned node_modules
 * inside /usr/lib/agentvoice, so the npm heuristic would otherwise claim it
 * and offer `npm i -g`, which would install a second copy the service does not
 * run.
 */
function detectSystemPackage(root: string): InstallModeInfo | null {
  const marker = readInstallSourceMarker(root);
  const underSystemRoot = SYSTEM_ROOTS.some(
    (prefix) => root === prefix || root.startsWith(`${prefix}/`),
  );
  if (!marker && !underSystemRoot) return null;

  const family = marker ?? osPackageFamily();
  return {
    mode: 'system',
    root,
    reason: marker
      ? `installed from a ${marker} package (${INSTALL_SOURCE_MARKER} marker)`
      : `installed under ${root}, which is owned by the system package manager`,
    global: true,
    updateCommand: systemUpdateCommand(family),
  };
}

function readInstallSourceMarker(root: string): 'deb' | 'rpm' | null {
  try {
    const value = readFileSync(join(root, INSTALL_SOURCE_MARKER), 'utf-8').trim().toLowerCase();
    if (value === 'deb' || value === 'rpm') return value;
  } catch {
    // No marker — fall back to the path check.
  }
  return null;
}

/** Guess the package family from /etc/os-release when the marker is missing. */
function osPackageFamily(): 'deb' | 'rpm' | null {
  try {
    const release = readFileSync('/etc/os-release', 'utf-8').toLowerCase();
    if (/\b(debian|ubuntu|linuxmint|pop|raspbian)\b/.test(release)) return 'deb';
    if (/\b(fedora|rhel|centos|rocky|almalinux|opensuse|suse)\b/.test(release)) return 'rpm';
  } catch {
    // Not a Linux distro we can identify.
  }
  return null;
}

function systemUpdateCommand(family: 'deb' | 'rpm' | null): string {
  if (family === 'deb') return 'sudo apt update && sudo apt install --only-upgrade agentvoice';
  if (family === 'rpm') return 'sudo dnf upgrade agentvoice';
  return 'Use your package manager to upgrade the agentvoice package';
}

/**
 * Can this install be updated in place by the bridge itself?
 *
 * Not for a system package: the files belong to root and to the package
 * manager's database, so the Serve UI shows a copyable command instead of an
 * update button (docs/38).
 */
export function canSelfUpdate(info = detectInstallMode()): boolean {
  return info.mode === 'git' || info.mode === 'npm';
}

/** Test seam — forget the cached answer. */
export function resetInstallModeCache(): void {
  cached = null;
}
