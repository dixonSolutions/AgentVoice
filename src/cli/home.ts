/**
 * The bridge home — where config.json, .env and data/state.db live.
 *
 * The bridge itself (src/, bundled into dist/index.js) is written for a repo
 * checkout: it resolves those paths relative to `process.cwd()`. A global
 * install (`npm i -g agentvoice`) or an `npx agentvoice` has no such checkout,
 * so this module builds one — seeding config.json and a random APP_TOKEN on
 * first run, and linking the packaged web/dist + package.json in so the
 * bridge's cwd-relative lookups find the built PWA and the right version.
 *
 * Everything the bridge writes stays in that home, so `npm update -g
 * agentvoice` never destroys it.
 *
 * Every command needs the home, not just `run`: `status` reads the config
 * there, `doctor` checks it is writable, `token` rewrites its .env.
 */

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
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { detectInstallMode } from '../serve/installMode.js';

/** Root of the installed package — the clone, or the dir under node_modules. */
export function packageRoot(): string {
  return detectInstallMode().root;
}

/** A directory is an AgentVoice home if the bridge has state there already. */
export function looksLikeHome(dir: string): boolean {
  return existsSync(join(dir, 'config.json')) || existsSync(join(dir, 'data', 'state.db'));
}

/**
 * Pick the home this invocation should act on.
 *
 * The install root is consulted after the cwd because a git clone *is* its own
 * home — without that step `agentvoice status` run from anywhere but the repo
 * would report on an empty ~/.agentvoice instead of the install it belongs to.
 * An npm install never matches it: nothing seeds config.json under
 * node_modules.
 */
export function resolveHome(): string {
  const fromEnv = process.env['AGENTVOICE_HOME'];
  if (fromEnv) return resolve(fromEnv);

  const cwd = process.cwd();
  if (looksLikeHome(cwd)) return cwd;

  const root = packageRoot();
  if (looksLikeHome(root)) return root;

  return join(homedir(), '.agentvoice');
}

/**
 * Point `<home>/<name>` at `<packageRoot>/<name>`. Symlink when the platform
 * allows it (so an upgrade is picked up without re-linking), copy otherwise.
 * Never clobbers a real file/directory the user put there.
 */
export function link(home: string, name: string): void {
  const target = join(packageRoot(), name);
  const dest = join(home, name);
  if (!existsSync(target)) return;
  if (resolve(target) === resolve(dest)) return; // running from the clone itself

  let current: ReturnType<typeof lstatSync> | null = null;
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
      process.stderr.write(`agentvoice: could not provide ${name} (${errText(err)})\n`);
    }
  }
}

export function seedConfig(home: string): boolean {
  const dest = join(home, 'config.json');
  if (existsSync(dest)) return false;

  const example = join(packageRoot(), 'config.example.json');
  if (!existsSync(example)) {
    throw new Error(
      `no config.json in ${home} and the packaged config.example.json is missing.\n` +
        '  This install is incomplete — reinstall with: npm i -g agentvoice',
    );
  }

  // The example ships runMode "test", which is right in a checkout: the bridge
  // proxies to `ng serve` on :4200 and tells you to open that. An installed
  // package has no dev server — it has the PWA we just linked in — so it must
  // start in serve mode, or first run prints a URL that answers nothing.
  try {
    const cfg = JSON.parse(readFileSync(example, 'utf8')) as ConfigShape;
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

export function envPath(home: string): string {
  return join(home, '.env');
}

/** Mint an APP_TOKEN into `<home>/.env` unless one already exists. */
export function seedEnv(home: string): string | null {
  const dest = envPath(home);
  const existing = existsSync(dest) ? readFileSync(dest, 'utf8') : '';

  // An APP_TOKEN already in the environment wins — nothing to generate.
  if (process.env['APP_TOKEN']) return null;
  if (/^\s*APP_TOKEN\s*=\s*\S/m.test(existing)) return null;

  const token = newToken();
  const block =
    (existing && !existing.endsWith('\n') ? '\n' : '') +
    '# Generated by `agentvoice` on first run. Keep it secret.\n' +
    `APP_TOKEN=${token}\n`;
  writeFileSync(dest, existing + block, { mode: 0o600 });
  return token;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Parse `<home>/.env` into a map. Deliberately not dotenv: the CLI must be able
 * to read a half-written .env to *report* on it, where dotenv's job is to load
 * a valid one into the process.
 */
export function readEnvFile(home: string): Map<string, string> {
  const map = new Map<string, string>();
  const path = envPath(home);
  if (!existsSync(path)) return map;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(trimmed.slice(0, eq).trim(), value);
  }
  return map;
}

/** `.env` first, then the ambient environment — the bridge's own precedence. */
export function envValue(home: string, key: string): string | undefined {
  return readEnvFile(home).get(key) ?? process.env[key];
}

// ── config.json ────────────────────────────────────────────────────────────

interface ServeRunMode {
  backendPort?: number;
  publicBaseUrl?: string;
}

interface ConfigShape {
  settings?: {
    runMode?: string;
    agentClient?: string;
    runModes?: {
      test?: { backendPort?: number; webPort?: number };
      serve?: ServeRunMode;
    };
  };
  projects?: unknown[];
}

export interface ConfigRead {
  path: string;
  exists: boolean;
  /** Parse/read failure, if any. `config` is null whenever this is set. */
  error: string | null;
  config: ConfigShape | null;
}

/** Honour CONFIG_PATH the way src/config.ts does: relative to the home. */
export function configPath(home: string): string {
  const configured = envValue(home, 'CONFIG_PATH')?.trim();
  if (!configured) return join(home, 'config.json');
  return isAbsolute(configured) ? configured : resolve(home, configured);
}

export function readConfig(home: string): ConfigRead {
  const path = configPath(home);
  if (!existsSync(path)) return { path, exists: false, error: null, config: null };
  try {
    return {
      path,
      exists: true,
      error: null,
      config: JSON.parse(readFileSync(path, 'utf8')) as ConfigShape,
    };
  } catch (err) {
    return { path, exists: true, error: errText(err), config: null };
  }
}

/** Where the SQLite file lives, honouring DB_PATH like src/config.ts does. */
export function dbPath(home: string): string {
  const configured = envValue(home, 'DB_PATH')?.trim() || './data/state.db';
  return isAbsolute(configured) ? configured : resolve(home, configured);
}

// ── native binding pre-flight ──────────────────────────────────────────────

/**
 * better-sqlite3 is a native module. npm 12 blocks install scripts it has not
 * been told to allow, and a fresh install resolves a version no `allowScripts`
 * pin covers — so the binding is simply never built and the bridge dies on its
 * first query with a wall of attempted paths. Say what to do instead.
 */
export async function checkNativeBinding(): Promise<string | null> {
  try {
    // Importing the module is not enough — better-sqlite3 resolves its binding
    // lazily, on the first Database. Open one in memory and throw it away.
    const { default: Database } = await import('better-sqlite3');
    new Database(':memory:').close();
    return null;
  } catch (err) {
    return errText(err);
  }
}

/** The remedy for a missing binding, or null when the failure is something else. */
export function nativeBindingAdvice(message: string): string | null {
  if (!message.includes('bindings file') && !message.includes('better_sqlite3')) return null;
  return (
    'npm did not run better-sqlite3’s install script, so it has no compiled binding.\n' +
    '  Allow it and rebuild:\n' +
    '\n' +
    '    npm install-scripts approve better-sqlite3   # npm 12+\n' +
    '    npm rebuild better-sqlite3\n' +
    '\n' +
    '  On older npm, `npm rebuild better-sqlite3` alone is enough. A compiler\n' +
    '  toolchain is only needed if no prebuilt binary matches your Node version.'
  );
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
