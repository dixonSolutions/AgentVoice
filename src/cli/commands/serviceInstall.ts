/**
 * `agentvoice service install` — write a systemd **user** unit for this install.
 *
 * `noUnitAdvice()` used to point at `scripts/install-systemd.sh`, which only
 * exists in a git clone. An npm install — and a .deb, which ships no scripts
 * directory either — was told to go and find a repo. So the installer is a
 * command now, and it works from whatever install is actually running
 * (docs/38).
 *
 * A *user* unit, deliberately. The bridge has to run as the developer: it
 * spawns `claude`, `cursor-agent` and `codex` with their credentials, writes
 * `~/.cursor/mcp.json`, `~/.codex/config.toml` and `~/.claude.json`, and edits
 * the user's own projects. The repo's system unit (`User=agentvoice`,
 * `ProtectSystem=strict`) only suits a dedicated server and would leave every
 * one of those inaccessible.
 *
 * Two things a user unit gets wrong by default, both handled here:
 *
 *   - Its PATH is minimal, so `~/.local/bin/claude` is invisible. The unit
 *     carries an explicit PATH covering the usual per-user bin directories.
 *   - It stops when the user logs out, which is exactly the wrong behaviour
 *     for a bridge you talk to from your phone. `loginctl enable-linger` fixes
 *     that, and the command offers to run it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectInstallMode } from '../../serve/installMode.js';
import { resolveHome } from '../home.js';
import { capture, passthrough, ran } from '../exec.js';
import { SERVICE_UNIT } from '../service.js';
import { bold, dim, fail, green, note, say, yellow } from '../out.js';

/** Where a systemd user unit lives for the invoking user. */
function userUnitPath(): string {
  const base =
    process.env['XDG_CONFIG_HOME']?.trim() || join(homedir(), '.config');
  return join(base, 'systemd', 'user', SERVICE_UNIT);
}

/**
 * PATH for the unit.
 *
 * A systemd user unit inherits almost nothing, and every agent CLI installs
 * itself into a per-user bin directory. Without this the bridge starts fine
 * and then cannot find a single agent to run.
 */
function unitPath(): string {
  const home = homedir();
  const candidates = [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.deno', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  // Anything already on the invoking shell's PATH is worth keeping too.
  for (const entry of (process.env['PATH'] ?? '').split(':')) {
    if (entry && !candidates.includes(entry)) candidates.push(entry);
  }
  return candidates.join(':');
}

function renderUnit(opts: { exec: string; home: string }): string {
  return `[Unit]
Description=AgentVoice Bridge
Documentation=https://github.com/dixonSolutions/AgentVoice
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${opts.home}
ExecStart=${opts.exec}
Restart=on-failure
RestartSec=3
# Agent CLIs live in per-user bin directories a user unit would not see.
Environment=PATH=${unitPath()}
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
}

/**
 * The command the unit should run.
 *
 * `agentvoice run` when the launcher is on PATH (npm and system installs both
 * put it there); otherwise node plus the absolute path to this install's
 * launcher, so a clone works without being installed globally.
 */
function execStart(): string {
  const install = detectInstallMode();
  const shim = join(install.root, 'bin', 'agentvoice.mjs');
  if (existsSync(shim)) return `${process.execPath} ${shim} run`;
  return 'agentvoice run';
}

export interface ServiceInstallOptions {
  /** Print the unit and what would happen, without writing anything. */
  dryRun?: boolean;
  /** Enable and start it immediately. */
  now?: boolean;
  /** Overwrite an existing unit. */
  force?: boolean;
}

export async function serviceInstallCommand(opts: ServiceInstallOptions = {}): Promise<number> {
  const probe = await capture('systemctl', ['--user', '--version']);
  if (!ran(probe)) {
    fail(
      'systemd user services are not available on this host.\n' +
        '  Run the bridge in the foreground instead:  agentvoice run',
    );
    return 1;
  }

  const path = userUnitPath();
  const unit = renderUnit({ exec: execStart(), home: resolveHome() });

  if (opts.dryRun) {
    say(`${yellow('dry run')} — would write ${path}:`);
    say('');
    say(unit);
    return 0;
  }

  if (existsSync(path) && !opts.force) {
    const current = safeRead(path);
    if (current === unit) {
      say(`${green('ok')}  ${path} is already up to date.`);
    } else {
      fail(
        `${path} already exists and differs from what this install would write.\n` +
          '  Review it, then re-run with --force to replace it.',
      );
      return 1;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, unit, 'utf-8');
    say(`${green('written')}  ${path}`);
  }

  const reload = await passthrough('systemctl', ['--user', 'daemon-reload']);
  if (reload !== 0) return reload;

  if (opts.now) {
    const enable = await passthrough('systemctl', ['--user', 'enable', '--now', SERVICE_UNIT]);
    if (enable !== 0) return enable;
    say(`${green('started')}  ${SERVICE_UNIT}`);
    await offerLinger();
    return 0;
  }

  note('');
  note(`  ${bold('Enable and start it:')}`);
  note(`    systemctl --user enable --now ${SERVICE_UNIT}`);
  note('');
  note(`  ${bold('Keep it running when you log out:')}`);
  note(`    loginctl enable-linger ${process.env['USER'] ?? '$USER'}`);
  note(dim('  Without linger, systemd stops your user services at logout —'));
  note(dim('  which is exactly when you want to reach the bridge from your phone.'));
  return 0;
}

/** Tell the user about linger; never enable it behind their back. */
async function offerLinger(): Promise<void> {
  const user = process.env['USER'] ?? '';
  const state = await capture('loginctl', ['show-user', user, '--property=Linger']);
  if (ran(state) && state.stdout.includes('Linger=yes')) return;
  note('');
  note('  The service stops when you log out. To keep it running:');
  note(`    loginctl enable-linger ${user || '$USER'}`);
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}
