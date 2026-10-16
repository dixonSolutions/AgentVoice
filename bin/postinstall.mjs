#!/usr/bin/env node
/**
 * npm postinstall — register Squeakr as a background service, out of the box.
 *
 * `npm install -g squeakr` should leave a bridge running, the
 * way a .deb or .rpm does: a *user* service (systemd on Linux, launchd on
 * macOS) bound to 127.0.0.1 — nothing is exposed until `squeakr setup`
 * sets up hosting. On `npm update -g` the same hook restarts the service, so
 * the new version is the one running.
 *
 * It acts only when all of these hold, and otherwise does nothing:
 *   - a global install (npm_config_global), not a clone's `npm install`;
 *   - the package really sits under node_modules;
 *   - not CI, not root (a root "user service" would be root's, not yours);
 *   - not Windows (a service there needs an elevated terminal and NSSM —
 *     `squeakr service install` explains);
 *   - SQUEAKR_NO_SERVICE (or the pre-rename AGENTVOICE_NO_SERVICE) is not set.
 *
 * It never fails the install: any problem is reported and the exit code is 0.
 * Everything real is done by `squeakr service install --now` (or
 * `restart`), so there is exactly one code path for installing the service.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bin', 'agentvoice.mjs');
const env = process.env;

function skip(reason) {
  if (env.SQUEAKR_POSTINSTALL_DEBUG || env.AGENTVOICE_POSTINSTALL_DEBUG) console.log(`squeakr postinstall: skipped — ${reason}`);
  process.exit(0);
}

if (env.SQUEAKR_NO_SERVICE) skip('SQUEAKR_NO_SERVICE is set');
if (env.AGENTVOICE_NO_SERVICE) skip('AGENTVOICE_NO_SERVICE is set');
if (env.npm_config_global !== 'true') skip('not a global install');
if (!root.split(sep).includes('node_modules')) skip('not installed under node_modules');
if (env.CI) skip('CI');
if (process.platform === 'win32') {
  console.log('Squeakr installed. To run it as a Windows service: squeakr service install --now (elevated terminal).');
  skip('Windows');
}
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.log('Squeakr installed as root — run `squeakr service install --now` as your own user to start it.');
  skip('root');
}
if (!existsSync(join(root, 'dist', 'cli.js'))) skip('dist/cli.js missing');

function squeakr(...args) {
  // From the home directory: a cwd holding a config.json would become the
  // bridge home, and npm runs scripts from inside the package.
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: homedir(),
    encoding: 'utf8',
    env: { ...env, NO_COLOR: '1' },
    timeout: 60_000,
  });
}

try {
  // `status --json` exits 1 when the bridge is down; the JSON is still there.
  const status = squeakr('status', '--json');
  let service = null;
  try {
    service = JSON.parse(status.stdout).service ?? null;
  } catch {
    /* no status — treat as not installed */
  }
  const installed = service?.installed === true;

  // Stopped cleanly *and* not set to start means someone turned it off (or
  // `service uninstall` masked a packaged unit): an update must not start it
  // behind their back. A crashed (failed) or enabled-but-stopped service is
  // restarted — picking up a fix is what the update is for.
  const ENABLED = new Set(['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'static', 'loaded', 'installed', 'auto']);
  // status reports "<ActiveState> (<SubState>)". Anchored: "deactivating"
  // (stopping after a disable) must not read as "activating".
  const crashedOrStarting = /^(failed|activating)\b|\(auto-restart\)/.test(service?.state ?? '');
  if (installed && !service.active && !crashedOrStarting && !ENABLED.has(service.enabled ?? '')) {
    console.log('Squeakr updated. Its background service is stopped — start it with `squeakr start` when you want it.');
    process.exit(0);
  }

  // Coming from the pre-rename package (docs/44): its service still runs the
  // copy under node_modules/@ratitisrad/agentvoice. Restarting would restart
  // *that*, so point the unit at this install first, then restart onto it.
  const legacy = join(dirname(root), '@ratitisrad', 'agentvoice');
  const fromLegacy = installed && existsSync(legacy);
  if (fromLegacy) {
    const moved = squeakr('service', 'install', '--force', '--now');
    if (moved.status !== 0) {
      console.log(
        'Squeakr installed, but the AgentVoice service could not be moved over to it:\n' +
          `${`${moved.stdout ?? ''}${moved.stderr ?? ''}`.trim().split('\n').map((l) => `  ${l}`).join('\n')}\n` +
          'Run `squeakr service install --force --now`, then `npm rm -g @ratitisrad/agentvoice`.',
      );
      process.exit(0);
    }
  }

  const result = installed ? squeakr('restart') : squeakr('service', 'install', '--now');
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status === 0) {
    console.log(
      fromLegacy
        ? 'Squeakr installed — the AgentVoice background service now runs Squeakr, with the same settings.\n' +
            'Remove the old package when you are ready:  npm rm -g @ratitisrad/agentvoice'
        : installed
        ? 'Squeakr updated — the background service was restarted on the new version.'
        : 'Squeakr is running as a background service on http://127.0.0.1:5089.\n' +
            'Next: squeakr setup   (agent CLI, projects, and hosting such as Tailscale)',
    );
  } else {
    console.log(
      `Squeakr installed, but the background service could not be ${installed ? 'restarted' : 'set up'}:\n` +
        `${out.split('\n').map((l) => `  ${l}`).join('\n')}\n` +
        'Run `squeakr setup` (or `squeakr service install --now`) to finish.',
    );
  }
} catch (err) {
  console.log(`Squeakr installed; service setup skipped — ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
