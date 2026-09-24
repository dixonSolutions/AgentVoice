/**
 * `agentvoice migrate <path>` — move an existing bridge's config.json and .env
 * (a clone, a hand-made install, an old home) into this install's home, so an
 * npm install picks up where that one left off: same projects, same keys, same
 * pairing token — every paired phone keeps working.
 *
 * One action, and only that action: it copies files and stops. It never starts
 * the bridge, never installs a service, never touches the source. Starting it is
 * the user's next command (`agentvoice run`, or `service install --now`).
 *
 * "Safely", concretely:
 *
 *   - Secrets are never printed — only the *names* of the keys carried.
 *   - .env is written 0600, atomically (temp file + rename), so there is no
 *     moment where a half-written or world-readable copy exists.
 *   - Nothing in the target is overwritten without --force, and --force backs
 *     the old file up first (also 0600) rather than destroying it.
 *   - Paths that only made sense relative to the source (a cert, an APNs key)
 *     are rewritten to absolute ones; settings that tie the copy to the source
 *     checkout (CONFIG_PATH, DB_PATH, serve.repoDir) are dropped, so two bridges
 *     never end up sharing one database.
 *   - --dry-run reports all of the above and writes nothing.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { bold, dim, fail, green, note, say, yellow } from '../out.js';

export interface MigrateOptions {
  /** A bridge directory (holding config.json / .env) or a config.json file. */
  source: string;
  /** Target home. Defaults to $AGENTVOICE_HOME, else ~/.agentvoice. */
  to?: string;
  dryRun?: boolean;
  force?: boolean;
  /** Also copy data/state.db (jobs, sessions, history) — a consistent snapshot. */
  withData?: boolean;
}

/** .env keys holding a filesystem path: relative ones are re-anchored to the source. */
const PATH_KEYS = new Set([
  'HTTPS_CERT_PATH',
  'HTTPS_KEY_PATH',
  'APNS_KEY_PATH',
  'CURSOR_AGENT_PATH',
  'CODEX_PATH',
  'CLAUDE_CODE_PATH',
  'CODEWHALE_PATH',
  'AGENTVOICE_LOG_DIR',
]);

/**
 * .env keys that describe the *source's* layout. Carrying them would point the
 * new install back into the old checkout — at its config, or worse, at its live
 * database.
 */
const LAYOUT_KEYS = new Set(['CONFIG_PATH', 'DB_PATH', 'AGENTVOICE_HOME']);

export interface EnvTransform {
  text: string;
  /** Every key carried, in order — names only. */
  keys: string[];
  /** Keys rewritten from a relative to an absolute path. */
  rewritten: string[];
  /** Layout keys left behind. */
  dropped: string[];
}

/**
 * Rewrite a .env for its new home, keeping comments, order and quoting of
 * everything it does not need to change.
 */
export function transformEnv(text: string, sourceDir: string): EnvTransform {
  const keys: string[] = [];
  const rewritten: string[] = [];
  const dropped: string[] = [];

  const lines = text.split(/\r?\n/).flatMap((line) => {
    const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(line);
    if (!match) return [line];
    const [, lead = '', key = '', eq = '=', raw = ''] = match;

    if (LAYOUT_KEYS.has(key)) {
      dropped.push(key);
      return [`# ${key} left behind by \`agentvoice migrate\` — it described the source install's layout.`];
    }
    keys.push(key);

    if (PATH_KEYS.has(key)) {
      const quote = /^(["'])(.*)\1$/.exec(raw.trim());
      const value = quote ? (quote[2] ?? '') : raw.trim();
      if (value && !isAbsolute(value) && !value.startsWith('~')) {
        rewritten.push(key);
        const absolute = resolve(sourceDir, value);
        return [`${lead}${key}${eq}${quote ? `${quote[1]}${absolute}${quote[1]}` : absolute}`];
      }
    }
    return [line];
  });

  return { text: lines.join('\n').replace(/\n*$/, '\n'), keys, rewritten, dropped };
}

interface ConfigShape {
  settings?: {
    runMode?: string;
    runModes?: { test?: { backendPort?: number }; serve?: { backendPort?: number } };
    serve?: { repoDir?: string };
  };
  projects?: Array<{ path?: string }>;
}

export interface ConfigTransform {
  text: string;
  projects: number;
  changes: string[];
}

/** Re-anchor config.json for an installed package. Throws if it is not valid JSON. */
export function transformConfig(text: string, sourceDir: string): ConfigTransform {
  const cfg = JSON.parse(text) as ConfigShape;
  const changes: string[] = [];

  // An installed package serves the built PWA itself; the `test` profile
  // expects an `ng serve` dev server next to it that does not exist here.
  if (cfg.settings && cfg.settings.runMode !== 'serve') {
    cfg.settings.runMode = 'serve';
    cfg.settings.runModes ??= {};
    // Keep the port the source was actually listening on: this profile is not
    // serve, so it is the test one. A serve port it never used would move the
    // install away from the phones and tunnels still aimed at the old one.
    const port = cfg.settings.runModes.test?.backendPort ?? cfg.settings.runModes.serve?.backendPort ?? 5089;
    cfg.settings.runModes.serve = { ...(cfg.settings.runModes.serve ?? {}), backendPort: port };
    changes.push(`runMode → serve (port ${port}) — an installed package serves the PWA itself`);
  }

  // Points `update` at the source checkout; an npm install updates through npm.
  if (cfg.settings?.serve?.repoDir) {
    delete cfg.settings.serve.repoDir;
    changes.push('dropped settings.serve.repoDir — it pointed at the source checkout');
  }

  let reanchored = 0;
  for (const project of cfg.projects ?? []) {
    if (project.path && !isAbsolute(project.path) && !project.path.startsWith('~')) {
      project.path = resolve(sourceDir, project.path);
      reanchored++;
    }
  }
  if (reanchored) changes.push(`${reanchored} relative project path(s) made absolute`);

  return { text: `${JSON.stringify(cfg, null, 2)}\n`, projects: cfg.projects?.length ?? 0, changes };
}

/** The .env value for `key`, for locating things (CONFIG_PATH, DB_PATH) — never printed. */
function envLookup(text: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm').exec(text);
  const value = match?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
  return value || undefined;
}

function defaultTarget(): string {
  const fromEnv = process.env['AGENTVOICE_HOME']?.trim();
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.agentvoice');
}

/** Write via temp file + rename so no partial or wrongly-permissioned file ever exists. */
function writeAtomic(path: string, content: string, mode: number): void {
  const tmp = `${path}.migrate-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode); // umask can strip bits from `mode` on create
  renameSync(tmp, path);
}

function backup(path: string, mode: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${path}.bak-${stamp}`;
  copyFileSync(path, dest);
  chmodSync(dest, mode);
  return dest;
}

/**
 * SQLite's online backup into `dest`, not a file copy: consistent even while
 * the source bridge is running and mid-write (WAL included). Leaves no partial
 * file behind if it fails.
 */
async function snapshotDatabase(source: string, dest: string): Promise<void> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
    chmodSync(dest, 0o600);
  } catch (err) {
    rmSync(dest, { force: true });
    throw err;
  } finally {
    db.close();
  }
}

export async function migrateCommand(opts: MigrateOptions): Promise<number> {
  const given = resolve(opts.source);
  if (!existsSync(given)) {
    fail(`${given} does not exist.`);
    return 1;
  }
  const pointsAtFile = statSync(given).isFile();
  const sourceDir = pointsAtFile ? dirname(given) : given;
  const target = opts.to ? resolve(opts.to) : defaultTarget();

  if (resolve(sourceDir) === target) {
    fail(`source and target are the same directory (${target}) — nothing to migrate.`);
    return 1;
  }

  const envSource = join(sourceDir, '.env');
  const envText = existsSync(envSource) ? readFileSync(envSource, 'utf8') : null;

  // CONFIG_PATH in the source .env says where its config really is.
  const configuredPath = envText ? envLookup(envText, 'CONFIG_PATH') : undefined;
  const configSource = pointsAtFile
    ? given
    : configuredPath
      ? resolve(sourceDir, configuredPath)
      : join(sourceDir, 'config.json');
  const configText = existsSync(configSource) ? readFileSync(configSource, 'utf8') : null;

  if (!configText && !envText) {
    fail(`no config.json or .env in ${sourceDir} — point migrate at the directory the old bridge ran from.`);
    return 1;
  }

  let config: ConfigTransform | null = null;
  if (configText) {
    try {
      config = transformConfig(configText, sourceDir);
    } catch (err) {
      fail(`${configSource} is not valid JSON — ${err instanceof Error ? err.message : String(err)}. Nothing was copied.`);
      return 1;
    }
  }
  const env = envText ? transformEnv(envText, sourceDir) : null;

  const dbSource = envText && envLookup(envText, 'DB_PATH')
    ? resolve(sourceDir, envLookup(envText, 'DB_PATH')!)
    : join(sourceDir, 'data', 'state.db');
  const copyData = Boolean(opts.withData);
  if (copyData && !existsSync(dbSource)) {
    fail(`--with-data: no database at ${dbSource}. Nothing was copied.`);
    return 1;
  }

  const targets = {
    config: join(target, 'config.json'),
    env: join(target, '.env'),
    db: join(target, 'data', 'state.db'),
  };
  const clashes = [
    ...(config && existsSync(targets.config) ? [targets.config] : []),
    ...(env && existsSync(targets.env) ? [targets.env] : []),
    ...(copyData && existsSync(targets.db) ? [targets.db] : []),
  ];
  if (clashes.length && !opts.force && !opts.dryRun) {
    fail(
      `the target already has ${clashes.map((p) => basename(p)).join(', ')} (${target}).\n` +
        '  Re-run with --force to replace them — each is backed up first — or --dry-run to preview.',
    );
    return 1;
  }

  // ── Report (names only — never a value) ──────────────────────────────────
  say('');
  say(`  ${bold(opts.dryRun ? 'agentvoice migrate — dry run, nothing will be written' : 'agentvoice migrate')}`);
  say(`  ${dim('from')} ${sourceDir}`);
  say(`  ${dim('to  ')} ${target}`);
  say('');
  if (config) {
    say(`  ${green('config.json')}  ${config.projects} project${config.projects === 1 ? '' : 's'}  ${dim(configSource)}`);
    for (const change of config.changes) say(`               ${dim(`· ${change}`)}`);
  } else {
    say(`  ${yellow('config.json')}  none in the source — the first run will seed a fresh one`);
  }
  if (env) {
    say(`  ${green('.env')}         ${env.keys.length} key${env.keys.length === 1 ? '' : 's'}, written 0600  ${dim(envSource)}`);
    if (env.keys.length) say(`               ${dim(env.keys.join(', '))}`);
    if (env.rewritten.length) say(`               ${dim(`· relative → absolute: ${env.rewritten.join(', ')}`)}`);
    if (env.dropped.length) say(`               ${dim(`· left behind (source layout): ${env.dropped.join(', ')}`)}`);
    if (!env.keys.includes('APP_TOKEN')) {
      say(`               ${yellow('· no APP_TOKEN — the first run mints one, and phones must re-pair')}`);
    }
  } else {
    say(`  ${yellow('.env')}         none in the source — the first run mints an APP_TOKEN`);
  }
  say(
    copyData
      ? `  ${green('state.db')}     snapshot copied  ${dim(dbSource)}`
      : `  ${dim('state.db')}     not copied — the new install starts with fresh history ${dim('(--with-data to carry it)')}`,
  );
  for (const clash of clashes) say(`  ${yellow('replaces')}     ${clash} ${dim('(backed up first)')}`);
  say('');

  if (opts.dryRun) return 0;

  // ── Write ────────────────────────────────────────────────────────────────
  mkdirSync(target, { recursive: true, mode: 0o700 });

  // The snapshot is taken first, into a temp file: loading the native binding
  // and reading the source database are the only copy steps that can fail, and
  // they must not fail once config.json and .env have been replaced.
  let snapshot: string | null = null;
  if (copyData) {
    mkdirSync(dirname(targets.db), { recursive: true, mode: 0o700 });
    snapshot = `${targets.db}.migrate-${process.pid}`;
    try {
      await snapshotDatabase(dbSource, snapshot);
    } catch (err) {
      fail(`--with-data: could not read ${dbSource} — ${err instanceof Error ? err.message : String(err)}. Nothing was copied.`);
      return 1;
    }
  }

  const backups: string[] = [];
  if (config) {
    if (existsSync(targets.config)) backups.push(backup(targets.config, 0o600));
    writeAtomic(targets.config, config.text, 0o600);
  }
  if (env) {
    if (existsSync(targets.env)) backups.push(backup(targets.env, 0o600));
    writeAtomic(targets.env, env.text, 0o600);
  }
  if (snapshot) {
    if (existsSync(targets.db)) backups.push(backup(targets.db, 0o600));
    renameSync(snapshot, targets.db);
  }

  for (const path of backups) say(`  ${dim(`backup  ${path}`)}`);
  say(`  ${green('done')}  migrated into ${target}`);
  say('');
  note(`  ${bold('Nothing is running yet.')} Stop the old bridge first if it uses the same port, then:`);
  note('    agentvoice doctor                 # check the carried config');
  note('    agentvoice run                    # foreground, or');
  note('    agentvoice service install --now  # as a background service');
  if (!process.env['AGENTVOICE_HOME'] && !opts.to) {
    note(dim('  Run those from outside the old checkout — a directory with its own config.json wins over ~/.agentvoice.'));
  }
  return 0;
}
