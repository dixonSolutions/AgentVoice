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

import { pathToFileURL } from 'node:url';
import { detectInstallMode } from '../serve/installMode.js';
import { parseArgs, rejectUnknown, intFlag, UsageError } from './args.js';
import { doctorCommand } from './commands/doctor.js';
import { runCommand } from './commands/run.js';
import { logsCommand, serviceCommand } from './commands/service.js';
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

  ${bold('Running the bridge')}
    run                    Boot the bridge in the foreground (the default)
    start | stop | restart Manage the agentvoice.service systemd unit
    logs [-n N] [-f]       Tail the service journal

  ${bold('Looking after it')}
    status [--json]        Install, version, service, port and health at a glance
    doctor [--json]        Check Node, the native binding, config, CLI and port
    update [--stash]       Update this install the way it was installed
    token [--new]          Print the pairing token, or mint a fresh one
    prepare-vosk [--force] Fetch the wake-word model (~41 MB, not bundled)
    version                Package version (plus the commit, in a clone)
    help                   This screen

  ${bold('Options')}
    --json                 Machine-readable output (status, doctor)
    -n, --lines N          Journal lines to show (logs, default 80)
    -f, --follow           Follow the journal (logs)
    --new                  Rotate the APP_TOKEN (token)
    --force                Re-download even if present (prepare-vosk)
    --stash                Stash local changes across a git update
    --dry-run              Report what an update would do, change nothing
    --branch <name>        Rebase onto origin/<name> (git installs)

  ${bold('Environment')}
    AGENTVOICE_HOME        Bridge home. Defaults to the current directory when
                           it already holds a config.json, else ~/.agentvoice.

  Docs: docs/35-cli.md
`;

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
        valueFlags: ['lines'],
        aliases: { n: 'lines', f: 'follow' },
      });
      rejectUnknown(parsed, ['lines', 'follow']);
      process.exitCode = await logsCommand({
        lines: intFlag(parsed, 'lines', 80),
        follow: parsed.switches.has('follow'),
      });
      return;
    }

    case 'update': {
      const parsed = parseArgs(args, { valueFlags: ['branch'] });
      rejectUnknown(parsed, UPDATE_FLAGS);
      process.exitCode = await updateCommand(parsed);
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
