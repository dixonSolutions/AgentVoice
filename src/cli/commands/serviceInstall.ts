/**
 * `agentvoice service install` — install a background service for this install,
 * with whatever service manager the platform has:
 *
 *   Linux    a systemd **user** unit      ~/.config/systemd/user/agentvoice.service
 *   macOS    a launchd agent              ~/Library/LaunchAgents/com.agentvoice.bridge.plist
 *   Windows  an NSSM-wrapped service      AgentVoice
 *
 * `noUnitAdvice()` used to point at `scripts/install-systemd.sh`, which only
 * exists in a git clone. An npm install — and a .deb, which ships no scripts
 * directory either — was told to go and find a repo. So the installer is a
 * command now, and it works from whatever install is actually running
 * (docs/38).
 *
 * A *user* service, deliberately. The bridge has to run as the developer: it
 * spawns `claude`, `cursor-agent` and `codex` with their credentials, writes
 * `~/.cursor/mcp.json`, `~/.codex/config.toml` and `~/.claude.json`, and edits
 * the user's own projects. The repo's system unit (`User=agentvoice`,
 * `ProtectSystem=strict`) only suits a dedicated server and would leave every
 * one of those inaccessible. Windows has no per-user services, so there the
 * command says how to run the service under your own account.
 *
 * Two things a user service gets wrong by default, both handled here:
 *
 *   - Its PATH is minimal, so `~/.local/bin/claude` is invisible. The unit /
 *     plist carries an explicit PATH covering the usual per-user bin
 *     directories.
 *   - A systemd user unit stops when the user logs out, which is exactly the
 *     wrong behaviour for a bridge you talk to from your phone. `loginctl
 *     enable-linger` fixes that, and the command offers to run it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { detectInstallMode, PACKAGE_NAME } from '../../serve/installMode.js';
import { whichSync } from '../../providers/binResolve.js';
import { resolveHome } from '../home.js';
import { capture, passthrough, ran } from '../exec.js';
import { LAUNCHD_LABEL, SERVICE_UNIT, WINDOWS_SERVICE, launchdPlistPath } from '../service.js';
import { bold, dim, fail, green, note, say, yellow } from '../out.js';

export interface ServiceInstallOptions {
  /** Print the unit and what would happen, without writing anything. */
  dryRun?: boolean;
  /** Enable and start it immediately. */
  now?: boolean;
  /** Overwrite an existing unit. */
  force?: boolean;
}

export async function serviceInstallCommand(opts: ServiceInstallOptions = {}): Promise<number> {
  const install = detectInstallMode();
  if (install.mode === 'npm' && install.npx) {
    fail(
      'this is running from the npx cache, which npm is free to delete — a service\n' +
        '  pointing into it would break without warning. Install it first:\n' +
        `    npm install -g ${PACKAGE_NAME} && agentvoice service install --now`,
    );
    return 1;
  }

  const home = resolveHome();
  if (process.platform === 'darwin') return installLaunchd(home, opts);
  if (process.platform === 'win32') return installWindows(home, opts);
  return installSystemd(home, opts);
}

/**
 * PATH for the service.
 *
 * A user service inherits almost nothing, and every agent CLI installs itself
 * into a per-user bin directory. Without this the bridge starts fine and then
 * cannot find a single agent to run.
 */
function servicePath(): string {
  const home = homedir();
  const candidates = [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.deno', 'bin'),
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin'] : []),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  // Anything already on the invoking shell's PATH is worth keeping too.
  for (const entry of (process.env['PATH'] ?? '').split(delimiter)) {
    if (entry && !candidates.includes(entry)) candidates.push(entry);
  }
  return candidates.join(delimiter);
}

/**
 * What the service should run: this Node and this install's launcher, by
 * absolute path, so it works whether or not `agentvoice` is on the service's
 * PATH. Falls back to the bare command when there is no shim (never expected).
 */
function launchCommand(): string[] {
  const shim = join(detectInstallMode().root, 'bin', 'agentvoice.mjs');
  if (existsSync(shim)) return [process.execPath, shim, 'run'];
  return ['agentvoice', 'run'];
}

/**
 * Write `content` to `path` unless an identical file is already there.
 * Returns false (after reporting) when a different file exists and --force was
 * not given.
 */
function writeIfChanged(path: string, content: string, force: boolean | undefined): boolean {
  if (existsSync(path) && !force) {
    if (safeRead(path) === content) {
      say(`${green('ok')}  ${path} is already up to date.`);
      return true;
    }
    fail(
      `${path} already exists and differs from what this install would write.\n` +
        '  Review it, then re-run with --force to replace it.',
    );
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  say(`${green('written')}  ${path}`);
  return true;
}

// ── Linux: systemd user unit ───────────────────────────────────────────────

/** The user unit a .deb / .rpm installs (packaging/agentvoice.user.service). */
const PACKAGED_USER_UNIT = '/usr/lib/systemd/user/agentvoice.service';

function userUnitPath(): string {
  const base = process.env['XDG_CONFIG_HOME']?.trim() || join(homedir(), '.config');
  return join(base, 'systemd', 'user', SERVICE_UNIT);
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
Environment=PATH=${servicePath()}
Environment=NODE_ENV=production
Environment=AGENTVOICE_HOME=${opts.home}

[Install]
WantedBy=default.target
`;
}

async function installSystemd(home: string, opts: ServiceInstallOptions): Promise<number> {
  const probe = await capture('systemctl', ['--user', '--version']);
  if (!ran(probe)) {
    fail(
      'systemd user services are not available on this host.\n' +
        '  Run the bridge in the foreground instead:  agentvoice run',
    );
    return 1;
  }

  // A .deb / .rpm already ships the unit (/usr/lib/systemd/user); writing a
  // second copy into ~/.config would shadow it and miss the package's updates.
  // Enabling it is the whole job.
  if (detectInstallMode().mode === 'system' && existsSync(PACKAGED_USER_UNIT) && !existsSync(userUnitPath())) {
    if (opts.dryRun) {
      say(`${yellow('dry run')} — would enable the packaged unit ${PACKAGED_USER_UNIT}`);
      return 0;
    }
    if (!opts.now) {
      note(`  ${bold('The package ships the unit already.')} Enable and start it:`);
      note(`    systemctl --user enable --now ${SERVICE_UNIT}`);
      return 0;
    }
    const enable = await passthrough('systemctl', ['--user', 'enable', '--now', SERVICE_UNIT]);
    if (enable !== 0) return enable;
    say(`${green('started')}  ${SERVICE_UNIT} ${dim('(packaged unit)')}`);
    await offerLinger();
    return 0;
  }

  const path = userUnitPath();
  const unit = renderUnit({ exec: launchCommand().join(' '), home });

  if (opts.dryRun) {
    say(`${yellow('dry run')} — would write ${path}:`);
    say('');
    say(unit);
    return 0;
  }

  // WorkingDirectory must exist or systemd refuses to start the unit (CHDIR).
  mkdirSync(home, { recursive: true });
  if (!writeIfChanged(path, unit, opts.force)) return 1;

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

// ── macOS: launchd agent ───────────────────────────────────────────────────

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderPlist(opts: { args: string[]; home: string; path: string; log: string }): string {
  const strings = (values: string[]): string =>
    values.map((v) => `    <string>${xmlEscape(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(opts.args)}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(opts.home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(opts.path)}</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>AGENTVOICE_HOME</key>
    <string>${xmlEscape(opts.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- Restart after a crash, but let \`agentvoice stop\` stay stopped. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>3</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.log)}</string>
</dict>
</plist>
`;
}

async function installLaunchd(home: string, opts: ServiceInstallOptions): Promise<number> {
  const path = launchdPlistPath();
  const plist = renderPlist({
    args: launchCommand(),
    home,
    path: servicePath(),
    log: join(home, 'logs', 'launchd.log'),
  });

  if (opts.dryRun) {
    say(`${yellow('dry run')} — would write ${path}:`);
    say('');
    say(plist);
    return 0;
  }

  mkdirSync(join(home, 'logs'), { recursive: true });
  if (!writeIfChanged(path, plist, opts.force)) return 1;

  const domain = `gui/${process.getuid?.() ?? 0}`;
  if (opts.now) {
    // A previous copy may still be loaded; bootout first so the new plist wins.
    await capture('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
    const code = await passthrough('launchctl', ['bootstrap', domain, path]);
    if (code !== 0) return code;
    say(`${green('started')}  ${LAUNCHD_LABEL}`);
    return 0;
  }

  note('');
  note(`  ${bold('Start it (and at every login from now on):')}`);
  note('    agentvoice start');
  return 0;
}

// ── Windows: NSSM service ──────────────────────────────────────────────────

/** nssm.exe on PATH, or the copy scripts/setup.ps1 downloads into a clone. */
function findNssm(): string | null {
  const bundled = join(detectInstallMode().root, 'tools', 'nssm.exe');
  if (existsSync(bundled)) return bundled;
  return whichSync('nssm');
}

async function installWindows(home: string, opts: ServiceInstallOptions): Promise<number> {
  const nssm = findNssm();
  const [program, ...args] = launchCommand();
  const log = join(home, 'logs', 'service.log');
  const steps: string[][] = [
    ['install', WINDOWS_SERVICE, program!, ...args],
    ['set', WINDOWS_SERVICE, 'AppDirectory', home],
    ['set', WINDOWS_SERVICE, 'Description', 'AgentVoice Bridge'],
    ['set', WINDOWS_SERVICE, 'Start', 'SERVICE_AUTO_START'],
    ['set', WINDOWS_SERVICE, 'AppRestartDelay', '3000'],
    ['set', WINDOWS_SERVICE, 'AppStdout', log],
    ['set', WINDOWS_SERVICE, 'AppStderr', log],
    ['set', WINDOWS_SERVICE, 'AppEnvironmentExtra', 'NODE_ENV=production', `AGENTVOICE_HOME=${home}`],
  ];

  if (opts.dryRun || !nssm) {
    if (!nssm) {
      fail(
        'installing a Windows service needs NSSM, which was not found.\n' +
          '  Get it from https://nssm.cc/download and put nssm.exe on PATH, then re-run\n' +
          '  this from an elevated (Administrator) terminal.',
      );
    } else {
      say(`${yellow('dry run')} — would run:`);
    }
    for (const step of steps) say(`  nssm ${step.map(quoteArg).join(' ')}`);
    return opts.dryRun && nssm ? 0 : 1;
  }

  const existing = await capture('sc.exe', ['query', WINDOWS_SERVICE]);
  if (existing.code === 0) {
    if (!opts.force) {
      fail(
        `the ${WINDOWS_SERVICE} service already exists.\n` +
          '  Re-run with --force to replace it (it is stopped and removed first).',
      );
      return 1;
    }
    await capture('sc.exe', ['stop', WINDOWS_SERVICE]);
    await capture(nssm, ['remove', WINDOWS_SERVICE, 'confirm']);
  }

  mkdirSync(join(home, 'logs'), { recursive: true });
  for (const step of steps) {
    const result = await capture(nssm, step);
    if (result.code !== 0) {
      fail(
        `nssm ${step[0]} failed — ${(result.stderr || result.stdout).trim()}\n` +
          '  Installing a service needs an elevated (Administrator) terminal.',
      );
      return 1;
    }
  }
  say(`${green('installed')}  ${WINDOWS_SERVICE} (Windows service)`);

  note('');
  note(`  ${yellow('Run it as yourself.')} A new service runs as LocalSystem, which cannot see`);
  note('  your agent CLI sign-ins or your projects. Point it at your account:');
  note(`    nssm set ${WINDOWS_SERVICE} ObjectName .\\${process.env['USERNAME'] ?? '<you>'} <your-password>`);

  if (opts.now) {
    const code = await passthrough('sc.exe', ['start', WINDOWS_SERVICE]);
    if (code !== 0) return code;
    say(`${green('started')}  ${WINDOWS_SERVICE}`);
  } else {
    note('');
    note(`  ${bold('Start it:')}  agentvoice start`);
  }
  return 0;
}

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}
