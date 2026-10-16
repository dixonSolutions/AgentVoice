/**
 * Running `squeakr <argv>` for a chat — the same file the `squeakr`
 * command runs (this package's dist/cli.js), against this bridge's own home,
 * with SQUEAKR_MARKDOWN=1 so answers carry **bold** / `code` marks a chat
 * renders instead of terminal colour.
 *
 * Only CHAT_CLI commands get here: the ones that drive the agent (control
 * commands — channels/commands.ts translates chat into them) and the read-only
 * host checks. Service control, updates, setup and tokens stay on the host.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import stripAnsi from 'strip-ansi';
import { getConfigPath } from '../config.js';
import { CONTROL_COMMANDS } from '../control/types.js';
import { packageRoot } from './packageRoot.js';

const CLI_TIMEOUT_MS = 60_000;

/** Host checks a chat may run, with what they are for (`help cli`). */
export const HOST_CLI: Readonly<Record<string, string>> = {
  status: 'install, version, service, port and health',
  doctor: 'checks Node, the native binding, config, the agent CLI and the port',
  version: 'package version',
  logs: 'recent bridge log lines (`logs -n 50`, `logs --list`)',
  channel: 'channel status; `channel allow <channel> <id>`; `channel set <channel> <key> <value>`',
};

/** Every `squeakr` command a chat may run. */
export const CHAT_CLI: ReadonlySet<string> = new Set([...CONTROL_COMMANDS, ...Object.keys(HOST_CLI)]);

export interface CliResult {
  ok: boolean;
  /** What it printed (stdout), or why it failed (stderr, without the `squeakr:` prefix). */
  output: string;
}

export type CliRunner = (argv: string[]) => Promise<CliResult>;

/** This package's `dist/cli.js`. */
function cliEntry(): string | null {
  const root = packageRoot();
  const cli = root ? join(root, 'dist', 'cli.js') : null;
  return cli && existsSync(cli) ? cli : null;
}

export const runChatCli: CliRunner = (argv) => {
  if (!argv[0] || !CHAT_CLI.has(argv[0])) {
    return Promise.resolve({ ok: false, output: `\`squeakr ${argv[0] ?? ''}\` is not available from chat — run it on the host.` });
  }
  if (argv.some((a) => a === '-f' || a === '--follow')) {
    return Promise.resolve({ ok: false, output: 'following a log never ends — use `logs -n 50` instead' });
  }
  const entry = cliEntry();
  if (!entry) return Promise.resolve({ ok: false, output: 'dist/cli.js is missing — build the bridge (npm run build:backend)' });
  const home = dirname(resolve(getConfigPath()));
  return new Promise((done) => {
    execFile(
      process.execPath,
      [entry, ...argv],
      {
        cwd: home,
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 1 << 20,
        env: { ...process.env, SQUEAKR_HOME: home, SQUEAKR_MARKDOWN: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      },
      (err, stdout, stderr) => {
        const out = stripAnsi(stdout).trim();
        const why = stripAnsi(stderr).replace(/^squeakr:\s*/gm, '').trim();
        if (err) done({ ok: false, output: why || out || err.message });
        else done({ ok: true, output: out || why });
      },
    );
  });
};
