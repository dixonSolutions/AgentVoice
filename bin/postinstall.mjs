#!/usr/bin/env node
/**
 * npm postinstall — register Squeaky as a background service, out of the box.
 *
 * `npm install -g squeaky-cli` should leave a bridge running, the
 * way a .deb or .rpm does: a *user* service (systemd on Linux, launchd on
 * macOS) bound to 127.0.0.1 — nothing is exposed until `squeaky setup`
 * sets up hosting. On `npm update -g` the same hook restarts the service, so
 * the new version is the one running.
 *
 * It acts only when all of these hold, and otherwise does nothing:
 *   - a global install (npm_config_global), not a clone's `npm install`;
 *   - the package really sits under node_modules;
 *   - not CI, not root (a root "user service" would be root's, not yours);
 *   - not Windows (a service there needs an elevated terminal and NSSM —
 *     `squeaky service install` explains);
 *   - SQUEAKY_NO_SERVICE (or the pre-rename SQUEAKR_NO_SERVICE /
 *     AGENTVOICE_NO_SERVICE) is not set.
 *
 * It never fails the install: any problem is reported and the exit code is 0.
 * Everything real is done by `squeaky service install --now` (or
 * `restart`), so there is exactly one code path for installing the service.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bin', 'squeaky.mjs');
const env = process.env;

// Every spelling of a variable, current first (src/brand.ts#brandEnvKeys).
const brandKeys = (name) => ['SQUEAKY_', 'SQUEAKR_', 'AGENTVOICE_'].map((prefix) => `${prefix}${name}`);
const brandSet = (name) => brandKeys(name).find((key) => env[key]);

function skip(reason) {
  if (brandSet('POSTINSTALL_DEBUG')) console.log(`squeaky postinstall: skipped — ${reason}`);
  process.exit(0);
}

const noService = brandSet('NO_SERVICE');
if (noService) skip(`${noService} is set`);
if (env.npm_config_global !== 'true') skip('not a global install');
if (!root.split(sep).includes('node_modules')) skip('not installed under node_modules');
if (env.CI) skip('CI');
if (process.platform === 'win32') {
  console.log('Squeaky installed. To run it as a Windows service: squeaky service install --now (elevated terminal).');
  skip('Windows');
}
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.log('Squeaky installed as root — run `squeaky service install --now` as your own user to start it.');
  skip('root');
}
if (!existsSync(join(root, 'dist', 'cli.js'))) skip('dist/cli.js missing');

function squeaky(...args) {
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
  const status = squeaky('status', '--json');
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
    console.log('Squeaky updated. Its background service is stopped — start it with `squeaky start` when you want it.');
    process.exit(0);
  }

  // Coming from a pre-rename package — `squeakr` (docs/45) or, before that,
  // `@ratitisrad/agentvoice` — sitting next to this one in the same global
  // node_modules: its service (squeakr.service, agentvoice.service, …) still
  // runs that copy. `service install` retires it and writes squeaky's for this
  // install; --force replaces a squeaky unit that pointed into the old package
  // too, so the restart below lands on this version.
  const legacy = [
    { name: 'squeakr', product: 'Squeakr', dir: join(dirname(root), 'squeakr') },
    { name: '@ratitisrad/agentvoice', product: 'AgentVoice', dir: join(dirname(root), '@ratitisrad', 'agentvoice') },
  ].find((pkg) => existsSync(pkg.dir));
  if (legacy) {
    const moved = squeaky('service', 'install', '--force', '--now');
    if (moved.status !== 0) {
      console.log(
        `Squeaky installed, but the ${legacy.product} service could not be moved over to it:\n` +
          `${`${moved.stdout ?? ''}${moved.stderr ?? ''}`.trim().split('\n').map((l) => `  ${l}`).join('\n')}\n` +
          'Run `squeaky service install --force --now`, then `squeaky upgrade-from-squeakr`.',
      );
      process.exit(0);
    }
  }

  // After a hand-over the service is squeaky's, and already running this copy.
  const result = legacy ? squeaky('restart') : installed ? squeaky('restart') : squeaky('service', 'install', '--now');
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status === 0) {
    console.log(
      legacy
        ? `Squeaky installed — the ${legacy.product} background service now runs Squeaky, with the same settings.\n` +
            `Finish the move (home → ~/.squeaky, ${legacy.name} removed) when you are ready:  squeaky upgrade-from-squeakr`
        : installed
        ? 'Squeaky updated — the background service was restarted on the new version.'
        : 'Squeaky is running as a background service on http://127.0.0.1:5089.\n' +
            'Next: squeaky setup   (agent CLI, projects, and hosting such as Tailscale)',
    );
  } else {
    console.log(
      `Squeaky installed, but the background service could not be ${installed ? 'restarted' : 'set up'}:\n` +
        `${out.split('\n').map((l) => `  ${l}`).join('\n')}\n` +
        'Run `squeaky setup` (or `squeaky service install --now`) to finish.',
    );
  }
} catch (err) {
  console.log(`Squeaky installed; service setup skipped — ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
