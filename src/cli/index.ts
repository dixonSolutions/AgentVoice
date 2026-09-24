/**
 * `agentvoice` — the management CLI.
 *
 * bin/agentvoice.mjs is a shim over this file. The logic lives in TypeScript so
 * it is typechecked with the rest of the bridge and can import from src/ rather
 * than re-deriving things the bridge already knows — install mode, run-mode
 * ports, the systemd unit layout.
 *
 * Exit codes: 0 success, 1 failure, 2 usage error. `status` reports 1 when the
 * bridge is not answering, so `agentvoice status >/dev/null` is a liveness
 * probe.
 *
 * `run` is the default command, because bare `agentvoice` has always booted the
 * bridge and a published package cannot take that back.
 */

// Must be first: it silences the bridge's logger before any module under
// src/ takes a child of it. See src/cli/silence.ts.
import './silence.js';

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectInstallMode } from '../serve/installMode.js';
import { parseArgs, rejectUnknown, intFlag, UsageError } from './args.js';
import { doctorCommand } from './commands/doctor.js';
import { runCommand } from './commands/run.js';
import { logsCommand, serviceCommand } from './commands/service.js';
import { migrateCommand } from './commands/migrate.js';
import { addCommand } from './commands/add.js';
import { localCommand } from './commands/local.js';
import { setupCommand } from './commands/setup.js';
import { pipeCommand, pipeOptions, PIPE_SWITCHES, PIPE_VALUE_FLAGS } from './commands/pipe.js';
import { serviceInstallCommand, serviceUninstallCommand } from './commands/serviceInstall.js';
import { statusCommand } from './commands/status.js';
import { tokenCommand } from './commands/token.js';
import { updateCommand, UPDATE_FLAGS } from './commands/update.js';
import { bold, cyan, dim, fail, note, say } from './out.js';
import { packageVersion, gitVersion } from './versions.js';
import { prepareVoskCommand } from './commands/vosk.js';

const USAGE = `
  ${bold(cyan('agentvoice'))} — self-hosted voice bridge for agent CLIs

  ${bold('Usage')}
    agentvoice [command] [options]

  ${bold('Getting started')}
    setup                  Guided setup: agent CLI and projects, then (if you want
                           it) a background service and hosting such as Tailscale

  ${bold('Running the bridge')}
    run                    Boot the bridge in the foreground (the default)
    start | stop | restart Manage the background service (systemd, launchd,
                           or a Windows service)
    service install        Install that service for this install (a global npm
                           or .deb/.rpm install already did)
    service uninstall      Stop and remove it (run it before npm uninstall -g)
    logs [-n N] [-f]       Tail the service journal (or the session log file)
    logs --list            Session logs + voice transcripts on disk
    logs --transcripts     The newest voice transcript (--cat <file|latest> prints any)
    pipe [--mic|--file F]  Stream audio to the voice agent (stdin by default)
    local <path>|--this-dir
                           Throwaway bridge + web client with only that directory
                           as the project, logs in the terminal; nothing saved

  ${bold('Projects')}
    add <path>|--this-dir  Register a directory as a project (name, description
                           and aliases filled in from package.json / README / git)

  ${bold('Looking after it')}
    status [--json]        Install, version, service, port and health at a glance
    doctor [--json]        Check Node, the native binding, config, CLI and port
    update [--stash]       Update this install the way it was installed
    migrate <path>         Carry an existing bridge's config.json + .env into
                           this install's home (copies only; starts nothing)
    token [--new]          Print the pairing token, or mint a fresh one
    prepare-vosk [--force] Fetch the wake-word model now (the bridge also does on boot)
    version                Package version (plus the commit, in a clone)
    help                   This screen

  ${bold('Options')}
    --json                 Machine-readable output (status, doctor)
    -n, --lines N          Journal lines to show (logs, default 80)
    -f, --follow           Follow the journal or log file (logs)
    --files                Bridge session log files, not the journal (logs)
    --profile serve|test   Which run profile's log folder (logs)
    --mic, --file <path>   Audio source (pipe); stdin otherwise
    --url, --token         Bridge to stream to (pipe; default: this home's)
    --json                 Every bridge event as NDJSON (pipe)
    --rate N, --channels N Raw PCM format on stdin (pipe; default 16000 Hz, mono)
    --realtime             Pace a --file at real time instead of as fast as possible (pipe)
    --no-listen            Send audio only; do not print the agent's replies (pipe)
    --linger S             Seconds to wait for replies after input ends (pipe; default 30)
    --silence MS, --max-segment MS, --threshold X
                           Override where the bridge cuts segments (pipe)
    --name <label>         Name this audio source for the bridge (pipe)
    --new                  Rotate the APP_TOKEN (token)
    --now                  Enable and start it straight away (service install)
    --force                Re-download even if present (prepare-vosk);
                           overwrite an existing unit (service install);
                           replace existing files, backed up first (migrate);
                           replace a registered project's details (add)
    --stash                Stash local changes across a git update (update)
    --dry-run              Report what would happen, change nothing
                           (update, service install, migrate, add)
    --branch <name>        Rebase onto origin/<name> (update, git installs)
    --to <dir>             Home to migrate into (migrate; default ~/.agentvoice)
    --yes                  Take every default without asking (setup)
    --service, --no-service
                           Answer "install a background service?" (setup)
    --hosting <id>         tailscale, cloudflare, ngrok, devtunnel, lan or none (setup)
    --agent <id>           cursor, codex, claude-code or codewhale (setup)
    --projects-dir <path>  Folder holding your git repos (setup)
    --this-dir             Use the directory the command is run from (add, local)
    --port N               Port for the throwaway bridge (local; default: first free from 5190)
    --open                 Open the web client once it answers (local)
    --no-keys              Do not borrow the real home's .env keys (local)
    --fresh                Packaged default settings, not your home's (local)
    --keep                 Keep the temporary home on exit (local)
    --name, --description  Override what was detected (add)
    --alias "a, b"         Extra spoken aliases, comma-separated (add)
    --with-data            Also copy data/state.db as a consistent snapshot (migrate)

  ${bold('Environment')}
    AGENTVOICE_HOME        Bridge home. Defaults to the current directory when
                           it already holds a config.json, else ~/.agentvoice.

  Docs: docs/35-cli.md
`;

/**
 * `agentvoice <command> --help`: the USAGE lines for that command and the
 * options whose parenthetical names it. Derived from USAGE rather than kept as
 * a second copy, so the two cannot disagree.
 */
export function commandHelp(command: string): string | null {
  const entries: Array<{ options: boolean; text: string[] }> = [];
  let inOptions = false;
  for (const line of USAGE.split('\n')) {
    if (line.includes('Options')) inOptions = true;
    else if (line.includes('Environment')) inOptions = false;
    if (/^ {4}\S/.test(line)) entries.push({ options: inOptions, text: [line] });
    else if (/^ {10,}\S/.test(line) && entries.length) entries[entries.length - 1]!.text.push(line);
  }

  const commands = entries.filter((e) => {
    if (e.options) return false;
    const names = e.text[0]!.trim().split(/\s{2,}/)[0]!.split(/\s*\|\s*/).map((n) => n.split(' ')[0]);
    return names.includes(command);
  });
  if (commands.length === 0) return null;

  const options = entries.filter((e) => {
    if (!e.options) return false;
    const scopes = [...e.text.join(' ').matchAll(/\(([^)]*)\)/g)].flatMap((m) =>
      m[1]!.split(/[,;]/).map((part) => part.trim().split(' ')[0]),
    );
    return scopes.includes(command);
  });

  return [
    '',
    `  ${bold(`agentvoice ${command}`)}`,
    '',
    ...commands.flatMap((e) => e.text),
    ...(options.length ? ['', `  ${bold('Options')}`, ...options.flatMap((e) => e.text)] : []),
    '',
  ].join('\n');
}

export async function main(argv: string[]): Promise<void> {
  try {
    await dispatch(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      fail(err.message);
      note(USAGE);
      process.exitCode = 2;
      return;
    }
    fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

async function dispatch(argv: string[]): Promise<void> {
  const [first = '', ...rest] = argv;

  // `--version` / `--help` before the command, the way every CLI is expected to
  // accept them.
  if (first === '--version' || first === '-v') return versionCommand();
  if (first === '--help' || first === '-h') return help();

  const command = first.startsWith('-') ? 'run' : first || 'run';
  const args = first.startsWith('-') ? argv : rest;

  // `agentvoice logs --help` — anywhere before a bare `--`.
  const flagArgs = args.includes('--') ? args.slice(0, args.indexOf('--')) : args;
  if (flagArgs.includes('--help') || flagArgs.includes('-h')) {
    const text = commandHelp(command);
    if (!text) throw new UsageError(`unknown command "${command}"`);
    say(text);
    return;
  }

  switch (command) {
    case 'run': {
      const parsed = parseArgs(args);
      rejectUnknown(parsed, []);
      const code = await runCommand();
      // null means the bridge is now running in this process — leave exitCode
      // alone or the process would exit as soon as the event loop settles.
      if (code !== null) process.exitCode = code;
      return;
    }

    case 'service': {
      const [verb = '', ...serviceArgs] = args;
      if (verb === 'uninstall') {
        const parsed = parseArgs(serviceArgs);
        rejectUnknown(parsed, ['dry-run']);
        process.exitCode = await serviceUninstallCommand({ dryRun: parsed.switches.has('dry-run') });
        return;
      }
      if (verb !== 'install') {
        throw new UsageError(
          `unknown service verb "${verb || '(none)'}" — install or uninstall`,
        );
      }
      const parsed = parseArgs(serviceArgs);
      rejectUnknown(parsed, ['dry-run', 'now', 'force']);
      process.exitCode = await serviceInstallCommand({
        dryRun: parsed.switches.has('dry-run'),
        now: parsed.switches.has('now'),
        force: parsed.switches.has('force'),
      });
      return;
    }

    case 'start':
    case 'stop':
    case 'restart': {
      const parsed = parseArgs(args);
      rejectUnknown(parsed, []);
      process.exitCode = await serviceCommand(command);
      return;
    }

    case 'status': {
      const parsed = parseArgs(args);
      rejectUnknown(parsed, ['json']);
      process.exitCode = await statusCommand({ json: parsed.switches.has('json') });
      return;
    }

    case 'logs': {
      const parsed = parseArgs(args, {
        valueFlags: ['lines', 'cat', 'profile'],
        aliases: { n: 'lines', f: 'follow' },
      });
      rejectUnknown(parsed, ['lines', 'follow', 'files', 'transcripts', 'list', 'cat', 'profile']);
      const cat = parsed.values.get('cat');
      const profile = parsed.values.get('profile');
      process.exitCode = await logsCommand({
        lines: intFlag(parsed, 'lines', 80),
        follow: parsed.switches.has('follow'),
        files: parsed.switches.has('files'),
        transcripts: parsed.switches.has('transcripts'),
        list: parsed.switches.has('list'),
        ...(cat !== undefined ? { cat } : {}),
        ...(profile !== undefined ? { profile } : {}),
      });
      return;
    }

    case 'pipe': {
      const parsed = parseArgs(args, { valueFlags: PIPE_VALUE_FLAGS });
      rejectUnknown(parsed, [...PIPE_VALUE_FLAGS, ...PIPE_SWITCHES]);
      process.exitCode = await pipeCommand(pipeOptions(parsed));
      return;
    }

    case 'update': {
      const parsed = parseArgs(args, { valueFlags: ['branch'] });
      rejectUnknown(parsed, UPDATE_FLAGS);
      process.exitCode = await updateCommand(parsed);
      return;
    }

    case 'setup': {
      const parsed = parseArgs(args, { valueFlags: ['hosting', 'agent', 'projects-dir'], aliases: { y: 'yes' } });
      rejectUnknown(parsed, ['yes', 'service', 'no-service', 'hosting', 'agent', 'projects-dir']);
      if (parsed.switches.has('service') && parsed.switches.has('no-service')) {
        throw new UsageError('setup: --service or --no-service, not both');
      }
      const hosting = parsed.values.get('hosting');
      const agent = parsed.values.get('agent');
      const projectsDir = parsed.values.get('projects-dir');
      process.exitCode = await setupCommand({
        yes: parsed.switches.has('yes'),
        ...(parsed.switches.has('service') ? { service: true } : {}),
        ...(parsed.switches.has('no-service') ? { service: false } : {}),
        ...(hosting !== undefined ? { hosting } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(projectsDir !== undefined ? { projectsDir } : {}),
      });
      return;
    }

    case 'local': {
      const parsed = parseArgs(args, { valueFlags: ['port'] });
      rejectUnknown(parsed, ['port', 'no-keys', 'fresh', 'keep', 'open', 'this-dir']);
      const dir = projectDir('local', parsed);
      const port = parsed.values.has('port') ? intFlag(parsed, 'port', 0) : undefined;
      const code = await localCommand({
        dir,
        ...(port !== undefined ? { port } : {}),
        noKeys: parsed.switches.has('no-keys'),
        fresh: parsed.switches.has('fresh'),
        keep: parsed.switches.has('keep'),
        open: parsed.switches.has('open'),
      });
      // null: the bridge owns the process now (see `run`).
      if (code !== null) process.exitCode = code;
      return;
    }

    case 'add': {
      const parsed = parseArgs(args, { valueFlags: ['name', 'description', 'alias'] });
      rejectUnknown(parsed, ['name', 'description', 'alias', 'dry-run', 'force', 'this-dir']);
      const dir = projectDir('add', parsed);
      const name = parsed.values.get('name');
      const description = parsed.values.get('description');
      const alias = parsed.values.get('alias');
      process.exitCode = await addCommand({
        dir,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(alias !== undefined ? { aliases: alias.split(',') } : {}),
        dryRun: parsed.switches.has('dry-run'),
        force: parsed.switches.has('force'),
      });
      return;
    }

    case 'migrate': {
      const parsed = parseArgs(args, { valueFlags: ['to'] });
      rejectUnknown(parsed, ['to', 'dry-run', 'force', 'with-data']);
      const [source, ...extra] = parsed.positionals;
      if (!source) throw new UsageError('migrate needs a path — the directory the old bridge ran from');
      if (extra.length) throw new UsageError(`migrate takes one path (got ${parsed.positionals.length})`);
      const to = parsed.values.get('to');
      process.exitCode = await migrateCommand({
        source,
        ...(to !== undefined ? { to } : {}),
        dryRun: parsed.switches.has('dry-run'),
        force: parsed.switches.has('force'),
        withData: parsed.switches.has('with-data'),
      });
      return;
    }

    case 'token': {
      const parsed = parseArgs(args);
      rejectUnknown(parsed, ['new']);
      process.exitCode = tokenCommand({ rotate: parsed.switches.has('new') });
      return;
    }

    case 'prepare-vosk':
    case 'prepare:vosk': {
      const parsed = parseArgs(args);
      rejectUnknown(parsed, ['force']);
      await prepareVoskCommand({ force: parsed.switches.has('force') });
      return;
    }

    case 'doctor': {
      const parsed = parseArgs(args);
      rejectUnknown(parsed, ['json']);
      process.exitCode = await doctorCommand({ json: parsed.switches.has('json') });
      return;
    }

    case 'version':
      return versionCommand();

    case 'help':
      return help();

    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

/**
 * The project directory for `add` / `local`: a path, or `--this-dir` for the
 * one the command is run from. Explicit on purpose — registering whatever
 * directory a terminal happened to be in is an easy mistake to make.
 */
function projectDir(command: string, parsed: ReturnType<typeof parseArgs>): string {
  const thisDir = parsed.switches.has('this-dir');
  const [path, ...extra] = parsed.positionals;
  if (extra.length) throw new UsageError(`${command} takes one path (got ${parsed.positionals.length})`);
  if (thisDir && path) throw new UsageError(`${command}: give a path or --this-dir, not both`);
  if (thisDir) return process.cwd();
  if (path) return resolve(path);
  throw new UsageError(`${command} needs a directory — a path, or --this-dir for ${process.cwd()}`);
}

async function versionCommand(): Promise<void> {
  const install = detectInstallMode();
  const version = packageVersion(install.root);

  if (install.mode !== 'git') {
    say(`agentvoice ${version}`);
    return;
  }
  const git = await gitVersion(install.root);
  const detail = git
    ? ` ${dim(`(${git.branch ?? 'detached'} @ ${git.commit ?? '?'}${git.dirty ? ', dirty' : ''})`)}`
    : '';
  say(`agentvoice ${version}${detail}`);
}

function help(): void {
  say(USAGE);
}

// `node dist/cli.js status` should work as well as `agentvoice status` — handy
// in a clone, and what the bin shim would do anyway. argv[1] tells the two
// apart so being imported by bin/agentvoice.mjs does not run main twice.
const argv1 = process.argv[1];
if (argv1 && import.meta.url === pathToFileURL(argv1).href) {
  void main(process.argv.slice(2));
}
