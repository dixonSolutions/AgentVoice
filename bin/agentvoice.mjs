#!/usr/bin/env node
/**
 * `agentvoice` CLI entry point — the published package's `bin`.
 *
 * The bridge itself (src/, bundled into dist/index.js) is written for a repo
 * checkout: it resolves `config.json`, `.env`, `data/state.db` and `web/dist`
 * relative to `process.cwd()`. A global install (`npm i -g agentvoice`) or an
 * `npx agentvoice` has no such checkout, so this wrapper builds one:
 *
 *   1. Pick a bridge home — $AGENTVOICE_HOME, else the current directory if it
 *      already looks like an AgentVoice install, else ~/.agentvoice.
 *   2. Seed config.json from the packaged config.example.json on first run.
 *   3. Seed .env with a freshly-random APP_TOKEN on first run, and print it.
 *   4. Link the packaged web/dist + package.json into the home so the bridge's
 *      cwd-relative lookups find the built PWA and report the right version.
 *   5. chdir into the home and boot dist/index.js.
 *
 * Everything the bridge writes (config, database, logs) stays in the home
 * directory, so an `npm update -g agentvoice` never destroys it.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
  statSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`agentvoice: ${message}`);
  process.exit(1);
}

/** A directory is an AgentVoice home if the bridge has state there already. */
function looksLikeHome(dir) {
  return existsSync(join(dir, 'config.json')) || existsSync(join(dir, 'data', 'state.db'));
}

function resolveHome() {
  if (process.env['AGENTVOICE_HOME']) return resolve(process.env['AGENTVOICE_HOME']);
  const cwd = process.cwd();
  // Running from a repo checkout (or a home seeded by an earlier run): stay put.
  if (looksLikeHome(cwd)) return cwd;
  return join(homedir(), '.agentvoice');
}

/**
 * Point `<home>/<name>` at `<pkgRoot>/<name>`. Symlink when the platform
 * allows it (so an upgrade is picked up without re-linking), copy otherwise.
 * Never clobbers a real file/directory the user put there.
 */
function link(home, name) {
  const target = join(pkgRoot, name);
  const dest = join(home, name);
  if (!existsSync(target)) return;

  let current = null;
  try {
    current = lstatSync(dest);
  } catch {
    /* not there — fall through and create it */
  }
  if (current) {
    if (!current.isSymbolicLink()) return; // user's own file/dir — leave it alone
    if (existsSync(dest)) return; // live symlink, already good
    rmSync(dest, { force: true }); // dangling symlink from an older install
  }

  mkdirSync(dirname(dest), { recursive: true });
  try {
    // The type hint only matters on Windows, where dirs need 'junction'.
    symlinkSync(target, dest, statSync(target).isDirectory() ? 'junction' : 'file');
  } catch {
    try {
      cpSync(target, dest, { recursive: true });
    } catch (err) {
      console.warn(`agentvoice: could not provide ${name} (${err.message})`);
    }
  }
}

function seedConfig(home) {
  const dest = join(home, 'config.json');
  if (existsSync(dest)) return false;

  const example = join(pkgRoot, 'config.example.json');
  if (!existsSync(example)) {
    fail(
      `no config.json in ${home} and the packaged config.example.json is missing.\n` +
        '  This install is incomplete — reinstall with: npm i -g agentvoice',
    );
  }

  // The example ships runMode "test", which is right in a checkout: the bridge
  // proxies to `ng serve` on :4200 and tells you to open that. An installed
  // package has no dev server — it has the PWA we just linked in — so it must
  // start in serve mode, or first run prints a URL that answers nothing.
  try {
    const cfg = JSON.parse(readFileSync(example, 'utf8'));
    cfg.settings ??= {};
    cfg.settings.runMode = 'serve';
    cfg.settings.runModes ??= {};
    cfg.settings.runModes.serve = {
      ...(cfg.settings.runModes.serve ?? {}),
      backendPort: Number(process.env['PORT']) || cfg.settings.runModes.serve?.backendPort || 5089,
    };
    // The example's placeholder hostname is worse than nothing here.
    delete cfg.settings.runModes.serve.publicBaseUrl;
    writeFileSync(dest, `${JSON.stringify(cfg, null, 2)}\n`);
  } catch {
    copyFileSync(example, dest);
  }
  return true;
}

/**
 * better-sqlite3 is a native module. npm 12 blocks install scripts it has not
 * been told to allow, and a fresh install resolves a version no `allowScripts`
 * pin covers — so the binding is simply never built and the bridge dies on its
 * first query with a wall of attempted paths. Say what to do instead.
 */
async function checkNativeBinding() {
  try {
    // Importing the module is not enough — better-sqlite3 resolves its binding
    // lazily, on the first Database. Open one in memory and throw it away.
    const { default: Database } = await import('better-sqlite3');
    new Database(':memory:').close();
  } catch (err) {
    explainNativeBindingFailure(err);
    process.exit(1);
  }
}

function explainNativeBindingFailure(err) {
  const message = String(err?.message ?? '');
  if (!message.includes('bindings file') && !message.includes('better_sqlite3')) {
    console.error(`agentvoice: could not load better-sqlite3 — ${message}`);
    return true;
  }
  console.error(
    '\nagentvoice: better-sqlite3 has no compiled binding, so the bridge cannot open its database.\n' +
      '\n  npm did not run its install script. Allow it and rebuild:\n' +
      '\n    npm install-scripts approve better-sqlite3   # npm 12+\n' +
      '    npm rebuild better-sqlite3\n' +
      '\n  On older npm, `npm rebuild better-sqlite3` alone is enough.\n' +
      '  A compiler toolchain is only needed if no prebuilt binary matches your Node version.\n',
  );
  return true;
}

function seedEnv(home) {
  const dest = join(home, '.env');
  const existing = existsSync(dest) ? readFileSync(dest, 'utf8') : '';

  // An APP_TOKEN already in the environment wins — nothing to generate.
  if (process.env['APP_TOKEN']) return null;
  if (/^\s*APP_TOKEN\s*=\s*\S/m.test(existing)) return null;

  const token = randomBytes(32).toString('base64url');
  const block =
    (existing && !existing.endsWith('\n') ? '\n' : '') +
    '# Generated by `agentvoice` on first run. Keep it secret.\n' +
    `APP_TOKEN=${token}\n`;
  writeFileSync(dest, existing + block, { mode: 0o600 });
  return token;
}

const home = resolveHome();
mkdirSync(home, { recursive: true });

const seededConfig = seedConfig(home);
const newToken = seedEnv(home);

link(home, 'web/dist');
link(home, 'package.json');

if (seededConfig || newToken) {
  const line = '─'.repeat(62);
  console.log(`\n${line}\n AgentVoice first run — bridge home: ${home}`);
  if (seededConfig) {
    console.log(` Created config.json from config.example.json. Edit it to add`);
    console.log(` your projects (absolute paths) before your first voice turn.`);
  }
  if (newToken) {
    console.log(`\n Your APP_TOKEN (saved to ${join(home, '.env')}):\n`);
    console.log(`   ${newToken}\n`);
    console.log(` Paste it into the web app when it asks you to pair.`);
  }
  console.log(`${line}\n`);
}

process.chdir(home);

// The bridge logs its own fatal errors and exits, so a try/catch around the
// import below never sees a missing native binding. Look before booting.
await checkNativeBinding();

try {
  await import(join(pkgRoot, 'dist', 'index.js'));
} catch (err) {
  if (err && err.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes('dist/index.js')) {
    fail('dist/index.js is missing — this install is incomplete. Reinstall with: npm i -g agentvoice');
  }
  if (explainNativeBindingFailure(err)) process.exit(1);
  throw err;
}
