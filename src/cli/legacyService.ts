/**
 * The background service as AgentVoice installed it, before the Squeakr rename
 * (docs/45): `agentvoice.service` (+ the `agentvoice-watch`, `-tunnel` and
 * `-caddy` companions scripts/ wrote), the launchd agent
 * `com.agentvoice.bridge`, the Windows service `AgentVoice`.
 *
 * `squeakr service install` and `squeakr upgrade-from-agentvoice` retire it:
 * stop it, disable it, remove what an install wrote, and carry the companion
 * units over under their new names. Two bridges on one port would otherwise
 * fight over it at every boot.
 */

import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { capture, passthrough, ran } from './exec.js';
import { dim, green, note, say, yellow } from './out.js';
import { unitLoaded } from './service.js';

export const LEGACY_SERVICE_UNIT = 'agentvoice.service';
export const LEGACY_LAUNCHD_LABEL = 'com.agentvoice.bridge';
export const LEGACY_WINDOWS_SERVICE = 'AgentVoice';

/** Companion user units scripts/install-systemd.sh and hosting-setup.sh wrote. */
export const LEGACY_COMPANION_UNITS = [
  'agentvoice-watch.path',
  'agentvoice-watch.service',
  'agentvoice-tunnel.service',
  'agentvoice-caddy.service',
] as const;

/** `agentvoice-watch.path` → `squeakr-watch.path`; any unit name, in any text. */
export function renameLegacyUnits(text: string): string {
  return text.replace(/\bagentvoice((?:-[a-z]+)?\.(?:service|path))\b/g, 'squeakr$1');
}

export type LegacyScope = 'user' | 'system' | 'launchd' | 'windows';

export interface LegacyService {
  scope: LegacyScope;
  unit: string;
  active: boolean;
  /** User-unit files under ~/.config/systemd/user, the main one included. */
  userFiles: string[];
  /** Companion units present (user scope only). */
  companions: string[];
}

function userUnitDir(): string {
  const base = process.env['XDG_CONFIG_HOME']?.trim() || join(homedir(), '.config');
  return join(base, 'systemd', 'user');
}

function legacyPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LEGACY_LAUNCHD_LABEL}.plist`);
}

function launchdTarget(): string {
  return `gui/${process.getuid?.() ?? 0}/${LEGACY_LAUNCHD_LABEL}`;
}

/** The pre-rename service on this machine, or null when there is none. */
export async function findLegacyService(): Promise<LegacyService | null> {
  if (process.platform === 'darwin') {
    if (!existsSync(legacyPlistPath())) return null;
    const loaded = (await capture('launchctl', ['print', launchdTarget()])).code === 0;
    return { scope: 'launchd', unit: LEGACY_LAUNCHD_LABEL, active: loaded, userFiles: [legacyPlistPath()], companions: [] };
  }
  if (process.platform === 'win32') {
    const query = await capture('sc.exe', ['query', LEGACY_WINDOWS_SERVICE]);
    if (!ran(query) || query.code !== 0) return null;
    return {
      scope: 'windows',
      unit: LEGACY_WINDOWS_SERVICE,
      active: /RUNNING/.test(query.stdout),
      userFiles: [],
      companions: [],
    };
  }

  const dir = userUnitDir();
  const companions = LEGACY_COMPANION_UNITS.filter((u) => existsSync(join(dir, u)));
  const userFiles = [LEGACY_SERVICE_UNIT, ...companions].map((u) => join(dir, u)).filter((p) => existsSync(p));

  // Enabled from a .deb that has since been replaced: the unit file is gone,
  // the enablement symlink is not.
  const wants = join(dir, 'default.target.wants', LEGACY_SERVICE_UNIT);
  let dangling = false;
  try {
    dangling = lstatSync(wants).isSymbolicLink();
  } catch {
    /* not enabled */
  }

  const user = await unitLoaded(['--user'], LEGACY_SERVICE_UNIT);
  if (user === null) return null;
  if (user || companions.length || dangling) {
    const active = (await capture('systemctl', ['--user', 'is-active', LEGACY_SERVICE_UNIT])).stdout.trim() === 'active';
    return { scope: 'user', unit: LEGACY_SERVICE_UNIT, active, userFiles, companions };
  }
  if (!(await unitLoaded([], LEGACY_SERVICE_UNIT))) return null;
  const active = (await capture('systemctl', ['is-active', LEGACY_SERVICE_UNIT])).stdout.trim() === 'active';
  return { scope: 'system', unit: LEGACY_SERVICE_UNIT, active, userFiles: [], companions: [] };
}

/**
 * A unit that ran the bridge through distrobox-enter: systemd only stops the
 * podman client, and the bridge keeps running in the container, on the port
 * and in the home. This CLI runs in that same container, so end it here —
 * matched on the unit's own command line, so nothing else is touched.
 */
async function stopInContainer(unit: string): Promise<void> {
  if (!process.env['CONTAINER_ID']) return;
  let execStart = '';
  try {
    const text = readFileSync(join(userUnitDir(), unit), 'utf-8');
    execStart = /^ExecStart=(.*)$/m.exec(text)?.[1] ?? '';
  } catch {
    return;
  }
  if (!execStart.includes('distrobox-enter')) return;
  const script = execStart.split(/\s+/).find((w) => w.endsWith('.mjs') || w.endsWith('cli.js'));
  if (!script) return;
  const pattern = `${script} run`;
  await capture('pkill', ['-TERM', '-f', pattern]);
  for (let i = 0; i < 20; i++) {
    if ((await capture('pgrep', ['-f', pattern])).code !== 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  await capture('pkill', ['-KILL', '-f', pattern]);
}

/** Stop it, leaving it installed. 0 when it is stopped (or was never running). */
export async function stopLegacyService(svc: LegacyService): Promise<number> {
  if (!svc.active) return 0;
  switch (svc.scope) {
    case 'user': {
      const code = await passthrough('systemctl', ['--user', 'stop', svc.unit]);
      await stopInContainer(svc.unit);
      return code;
    }
    case 'system':
      return process.getuid?.() === 0
        ? passthrough('systemctl', ['stop', svc.unit])
        : passthrough('sudo', ['-n', 'systemctl', 'stop', svc.unit]);
    case 'launchd':
      return passthrough('launchctl', ['bootout', launchdTarget()]);
    case 'windows': {
      const code = await passthrough('sc.exe', ['stop', svc.unit]);
      return code === 1062 ? 0 : code; // 1062: not started
    }
  }
}

/**
 * Stop, disable and remove the pre-rename service, and re-create its
 * companion units under their Squeakr names (enabled again if they were).
 * Returns the number of steps that need the user's attention; each is
 * reported with the command to finish it by hand.
 */
export async function retireLegacyService(svc: LegacyService, opts: { dryRun?: boolean } = {}): Promise<number> {
  const dry = Boolean(opts.dryRun);
  if (dry) {
    say(`  ${yellow('would')}  stop, disable and remove ${svc.unit} ${dim('(the AgentVoice service)')}`);
    for (const c of svc.companions) say(`  ${yellow('would')}  replace ${c} with ${renameLegacyUnits(c)}`);
    return 0;
  }

  switch (svc.scope) {
    case 'user':
      return retireUserUnits(svc);
    case 'system': {
      const sudo = process.getuid?.() === 0 ? [] : ['sudo', '-n'];
      const run = (args: string[]) =>
        sudo.length ? capture(sudo[0]!, [...sudo.slice(1), ...args]) : capture(args[0]!, args.slice(1));
      // Not `disable --now`: from inside a container systemctl skips the stop.
      const off = await run(['systemctl', 'disable', svc.unit]);
      await run(['systemctl', 'stop', svc.unit]);
      if (off.code !== 0) {
        note(`  ${yellow('note')}  could not disable the system unit ${svc.unit} without a password. Run:`);
        note(`          sudo systemctl disable --now ${svc.unit} && sudo rm -f /etc/systemd/system/${svc.unit}`);
        return 1;
      }
      await run(['rm', '-f', `/etc/systemd/system/${svc.unit}`]);
      await run(['systemctl', 'daemon-reload']);
      say(`  ${green('retired')}  ${svc.unit} ${dim('(system unit)')}`);
      return 0;
    }
    case 'launchd':
      await capture('launchctl', ['bootout', launchdTarget()]);
      rmSync(legacyPlistPath(), { force: true });
      say(`  ${green('retired')}  ${svc.unit}`);
      return 0;
    case 'windows': {
      await capture('sc.exe', ['stop', svc.unit]);
      const del = await capture('sc.exe', ['delete', svc.unit]);
      if (del.code !== 0) {
        note(`  ${yellow('note')}  could not remove the ${svc.unit} Windows service — from an elevated terminal:`);
        note(`          sc.exe stop ${svc.unit} & sc.exe delete ${svc.unit}`);
        return 1;
      }
      say(`  ${green('retired')}  ${svc.unit} ${dim('(Windows service)')}`);
      note(`  ${yellow('note')}  if it ran as your account, set the new one the same way:`);
      note(`          nssm set Squeakr ObjectName .\\${process.env['USERNAME'] ?? '<you>'} <your-password>`);
      return 0;
    }
  }
}

async function retireUserUnits(svc: LegacyService): Promise<number> {
  const dir = userUnitDir();
  let problems = 0;

  // Companions first: the watcher's .path unit triggers restarts of the main unit.
  for (const unit of svc.companions) {
    const from = join(dir, unit);
    const toName = renameLegacyUnits(unit);
    const to = join(dir, toName);
    const wasEnabled = (await capture('systemctl', ['--user', 'is-enabled', unit])).stdout.trim() === 'enabled';
    const wasActive = (await capture('systemctl', ['--user', 'is-active', unit])).stdout.trim() === 'active';
    await capture('systemctl', ['--user', 'disable', unit]);
    await capture('systemctl', ['--user', 'stop', unit]);
    if (!existsSync(to)) {
      try {
        writeFileSync(to, renameLegacyUnits(readFileSync(from, 'utf-8')), 'utf-8');
      } catch (err) {
        problems++;
        note(`  ${yellow('note')}  could not write ${to}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }
    rmSync(from, { force: true });
    say(`  ${green('renamed')}  ${unit} → ${toName}`);
    if (wasEnabled || wasActive) {
      await capture('systemctl', ['--user', 'daemon-reload']);
      for (const verb of [...(wasEnabled ? ['enable'] : []), ...(wasActive ? ['start'] : [])]) {
        if ((await capture('systemctl', ['--user', verb, toName])).code !== 0) {
          problems++;
          note(`  ${yellow('note')}  systemctl --user ${verb} ${toName} failed — run it once the new unit is in place`);
        }
      }
    }
  }

  await capture('systemctl', ['--user', 'disable', svc.unit]);
  await capture('systemctl', ['--user', 'stop', svc.unit]);
  await stopInContainer(svc.unit);
  rmSync(join(dir, svc.unit), { force: true });
  rmSync(join(dir, 'default.target.wants', svc.unit), { force: true });
  await capture('systemctl', ['--user', 'daemon-reload']);
  await capture('systemctl', ['--user', 'reset-failed', svc.unit]);
  say(`  ${green('retired')}  ${svc.unit}`);
  return problems;
}
