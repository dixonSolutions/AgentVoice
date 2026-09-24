/**
 * `agentvoice local` — a throwaway bridge for one directory.
 *
 *   cd ~/code/my-app && agentvoice local --this-dir
 *   agentvoice local ~/code/my-app
 *
 * What cloning AgentVoice and running it used to give you, without the clone:
 * the backend and the web client on a free loopback port, **this directory as
 * the only project**, and the log stream in your terminal. Ctrl-C stops it.
 *
 * Nothing is saved. It runs out of a fresh temporary home (0700) that is
 * deleted on exit — its own config.json, database, APP_TOKEN and logs — so it
 * never touches your real bridge's projects, history or pairing. Two things
 * are *borrowed* from the real home, read-only:
 *
 *   - its settings (agent CLI, permission mode, speech providers…), with the
 *     project list, discovery, hosting and port replaced;
 *   - its .env keys, loaded into this process's environment only — never
 *     written into the temporary home (--no-keys to skip).
 *
 * The wake-word model is shared with the real home, so a throwaway run does
 * not download 41 MB every time.
 *
 * One side effect remains, and the banner says so: the bridge registers its
 * MCP server with the agent CLI (e.g. ~/.codex/config.toml) at this instance's
 * address. Your main bridge puts its own address back on its next voice turn.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { newToken, packageRoot, readConfig, readEnvFile, resolveHome } from '../home.js';
import { bold, cyan, dim, fail, green, say, yellow } from '../out.js';
import { detectProjectDetails, type ProjectDetails } from '../projectDetails.js';
import { runCommand } from './run.js';

export interface LocalOptions {
  dir: string;
  /** Port to listen on; otherwise the first free one from 5190. */
  port?: number;
  /** Do not borrow the real home's .env keys. */
  noKeys?: boolean;
  /** Start from the packaged defaults instead of the real home's settings. */
  fresh?: boolean;
  /** Keep the temporary home on exit (for poking at it afterwards). */
  keep?: boolean;
  /** Open the web client in a browser once the bridge answers. */
  open?: boolean;
}

/**
 * .env keys that describe the real bridge rather than hold a credential. The
 * throwaway instance has its own token, port, files and plain-HTTP loopback.
 */
const NOT_BORROWED = new Set([
  'APP_TOKEN',
  'PORT',
  'CONFIG_PATH',
  'DB_PATH',
  'AGENTVOICE_HOME',
  'AGENTVOICE_LOG_DIR',
  'HTTPS_CERT_PATH',
  'HTTPS_KEY_PATH',
  'NODE_ENV',
]);

function portIsFree(port: number): Promise<boolean> {
  return new Promise((settle) => {
    const server = createServer();
    server.once('error', () => settle(false));
    server.listen(port, '127.0.0.1', () => server.close(() => settle(true)));
  });
}

async function freePort(start: number): Promise<number | null> {
  for (let port = start; port < start + 50; port++) {
    if (await portIsFree(port)) return port;
  }
  return null;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `over` on top of `under`, objects merged key by key, everything else replaced. */
export function deepMerge(under: Json, over: Json): Json {
  const out: Json = { ...under };
  for (const [key, value] of Object.entries(over)) {
    out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key] as Json, value) : value;
  }
  return out;
}

/**
 * The throwaway config: the real home's settings (or the packaged example),
 * with everything that decides *which projects* and *where it listens*
 * replaced. Exported for tests.
 */
export function localConfig(base: Json, project: ProjectDetails, port: number): Json {
  const cfg = structuredClone(base);
  const settings = ((cfg['settings'] as Json | undefined) ?? {}) as Json;
  cfg['settings'] = settings;

  settings['runMode'] = 'serve';
  const runModes = ((settings['runModes'] as Json | undefined) ?? {}) as Json;
  // No publicBaseUrl, no TLS: a loopback instance, not a second public one.
  runModes['serve'] = { backendPort: port };
  settings['runModes'] = runModes;
  settings['hosting'] = { provider: 'local' };
  settings['projectDiscovery'] = {
    ...((settings['projectDiscovery'] as Json | undefined) ?? {}),
    enabled: false,
    watch: false,
  };
  // The terminal is the log; nothing lands on disk.
  settings['logging'] = { ...((settings['logging'] as Json | undefined) ?? {}), files: false, transcripts: false };
  const serve = settings['serve'] as Json | undefined;
  if (serve) delete serve['repoDir'];

  cfg['projects'] = [
    {
      name: project.name,
      path: project.path,
      ...(project.description ? { description: project.description } : {}),
      aliases: project.aliases,
      enabled: true,
      discovered: false,
    },
  ];
  return cfg;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* no browser to open — the URL is in the banner */
  }
}

/** Poll /healthz until the bridge answers (or give up quietly after ~30 s). */
function whenHealthy(url: string, then: () => void, tries = 60): void {
  const req = request(`${url}/healthz`, { timeout: 1000 }, (res) => {
    res.resume();
    if (res.statusCode === 200) then();
    else if (tries > 0) setTimeout(() => whenHealthy(url, then, tries - 1), 500);
  });
  req.on('error', () => {
    if (tries > 0) setTimeout(() => whenHealthy(url, then, tries - 1), 500);
  });
  req.on('timeout', () => req.destroy());
  req.end();
}

export async function localCommand(opts: LocalOptions): Promise<number | null> {
  if (!existsSync(opts.dir) || !statSync(opts.dir).isDirectory()) {
    fail(`${opts.dir} is not a directory — nothing was started.`);
    return 1;
  }
  const project = await detectProjectDetails(opts.dir);

  const port = opts.port ?? (await freePort(5190));
  if (!port || !(await portIsFree(port))) {
    fail(opts.port ? `port ${opts.port} is in use.` : 'no free port between 5190 and 5239.');
    return 1;
  }

  // The real home — read, never written (apart from the shared vosk cache).
  const realHome = resolveHome();
  const real = readConfig(realHome);
  // Your settings on top of the packaged defaults: a hand-trimmed config.json
  // that relies on the bridge's older defaults still boots.
  const example = JSON.parse(readFileSync(join(packageRoot(), 'config.example.json'), 'utf8')) as Json;
  const base: Json = !opts.fresh && real.config ? deepMerge(example, real.config as Json) : example;

  const home = mkdtempSync(join(tmpdir(), 'agentvoice-local-'));
  const cleanup = (): void => {
    if (!opts.keep) rmSync(home, { recursive: true, force: true });
  };
  // 'exit' covers every way out — Ctrl-C and SIGTERM included, because the
  // bridge's own shutdown handler ends in process.exit().
  process.on('exit', cleanup);

  const token = newToken();
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(localConfig(base, project, port), null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(join(home, '.env'), `# Throwaway instance — deleted on exit.\nAPP_TOKEN=${token}\n`, { mode: 0o600 });

  // Share the wake-word model cache (a directory symlink; rm -r never follows it).
  try {
    const cache = join(realHome, 'vosk');
    mkdirSync(cache, { recursive: true });
    symlinkSync(cache, join(home, 'vosk'), 'junction');
  } catch {
    /* no cache to share — a download lands in the temporary home instead */
  }

  const borrowed: string[] = [];
  if (!opts.noKeys) {
    for (const [key, value] of readEnvFile(realHome)) {
      if (NOT_BORROWED.has(key) || process.env[key] !== undefined) continue;
      process.env[key] = value;
      borrowed.push(key);
    }
  }
  // Anything in the shell that describes *a* bridge would win over the
  // throwaway one (dotenv never overrides the environment): a token, a port,
  // another config or database, TLS, a log dir — or NODE_ENV=development,
  // which forces the test profile onto a port the banner never printed.
  for (const key of NOT_BORROWED) delete process.env[key];
  process.env['AGENTVOICE_HOME'] = home;

  const url = `http://127.0.0.1:${port}`;
  const client = (((base['settings'] as Json | undefined) ?? {})['agentClient'] as string | undefined) ?? 'cursor';
  const line = dim('─'.repeat(64));
  say('');
  say(line);
  say(`  ${bold(cyan('AgentVoice — local'))}  ${dim('throwaway instance, nothing is saved')}`);
  say('');
  say(`  ${dim('project ')} ${bold(project.name)}  ${dim(project.path)}`);
  if (project.description) say(`  ${dim('         ')} ${project.description}`);
  say(`  ${dim('agent   ')} ${client}  ${dim(opts.fresh || !real.config ? '(packaged defaults)' : `(settings from ${real.path})`)}`);
  say(`  ${dim('keys    ')} ${borrowed.length ? `${borrowed.length} borrowed from ${realHome}/.env ${dim('(in memory only)')}` : dim('none')}`);
  say('');
  say(`  ${green('open')}     ${bold(url)}`);
  say(`  ${green('token')}    ${token}`);
  say(`           ${dim('paste it when the app asks to pair — it dies with this instance')}`);
  say('');
  say(`  ${dim(`home ${home} — ${opts.keep ? 'kept on exit (--keep)' : 'deleted on exit'}`)}`);
  say(`  ${yellow('note')}  ${dim(`${client}'s agent-voice MCP entry points here while this runs;`)}`);
  say(`        ${dim('your main bridge restores it on its next voice turn.')}`);
  say(`  ${dim('Ctrl-C to stop. Logs follow.')}`);
  say(line);
  say('');

  if (opts.open) whenHealthy(url, () => openBrowser(url));

  // Same boot path as `agentvoice run`, pointed at the temporary home.
  const code = await runCommand();
  if (code !== null) cleanup();
  return code;
}
