/**
 * The systemd unit behind `start`, `stop`, `restart`, `status` and `logs`.
 *
 * Unit detection mirrors scripts/update.sh and src/serve/index.ts exactly, and
 * that order is load-bearing: `systemctl --user cat` first, then the system
 * unit. Most installs are user units (scripts/install-systemd.sh writes one),
 * and probing the system manager first would either need sudo or report the
 * wrong unit on a host that happens to have both.
 *
 * A system unit needs root, so it goes through `sudo -n` — non-interactive on
 * purpose. A CLI that silently blocks on a hidden password prompt is worse than
 * one that says "passwordless sudo required".
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { capture, passthrough, ran } from './exec.js';

/** Fixed unit name — never interpolated from user input. */
export const SERVICE_UNIT = 'agentvoice.service';

export type UnitScope = 'user' | 'system' | 'none';

export interface UnitInfo {
  scope: UnitScope;
  unit: string;
  /** True when systemctl itself is missing (a container, macOS, WSL1). */
  noSystemd: boolean;
}

let cachedUnit: UnitInfo | null = null;

export async function detectUnit(): Promise<UnitInfo> {
  if (cachedUnit) return cachedUnit;

  const user = await capture('systemctl', ['--user', 'cat', SERVICE_UNIT]);
  if (!ran(user)) {
    cachedUnit = { scope: 'none', unit: SERVICE_UNIT, noSystemd: true };
    return cachedUnit;
  }
  if (user.code === 0) {
    cachedUnit = { scope: 'user', unit: SERVICE_UNIT, noSystemd: false };
    return cachedUnit;
  }

  const system = await capture('systemctl', ['cat', SERVICE_UNIT]);
  cachedUnit = {
    scope: system.code === 0 ? 'system' : 'none',
    unit: SERVICE_UNIT,
    noSystemd: false,
  };
  return cachedUnit;
}

export interface UnitState {
  /** loaded | not-found | masked … straight from systemd. */
  loadState: string;
  /** active | inactive | failed … */
  activeState: string;
  /** running | dead | exited … */
  subState: string;
  /** When the unit entered its current active state, ISO-ish, or null. */
  since: string | null;
  mainPid: number | null;
  /** enabled | disabled | static | null when systemd would not say. */
  enabled: string | null;
}

export async function readUnitState(info: UnitInfo): Promise<UnitState | null> {
  if (info.scope === 'none') return null;
  const scopeArgs = info.scope === 'user' ? ['--user'] : [];
  const result = await capture('systemctl', [
    ...scopeArgs,
    'show',
    info.unit,
    '--property=LoadState',
    '--property=ActiveState',
    '--property=SubState',
    '--property=ActiveEnterTimestamp',
    '--property=MainPID',
    '--property=UnitFileState',
  ]);
  if (result.code !== 0) return null;

  const props = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }

  const pid = Number(props.get('MainPID') ?? '0');
  const since = props.get('ActiveEnterTimestamp') ?? '';
  return {
    loadState: props.get('LoadState') || 'unknown',
    activeState: props.get('ActiveState') || 'unknown',
    subState: props.get('SubState') || 'unknown',
    since: since && since !== 'n/a' ? since : null,
    mainPid: Number.isFinite(pid) && pid > 0 ? pid : null,
    enabled: props.get('UnitFileState') || null,
  };
}

/**
 * `systemctl <verb>` for the detected scope, run so the user sees the output.
 * Returns the child's exit code.
 */
export async function controlUnit(info: UnitInfo, verb: string): Promise<number> {
  if (info.scope === 'user') {
    return passthrough('systemctl', ['--user', verb, info.unit]);
  }
  // Already root (a system-unit install run by root): no sudo hop needed.
  if (process.getuid?.() === 0) {
    return passthrough('systemctl', [verb, info.unit]);
  }
  return passthrough('sudo', ['-n', 'systemctl', verb, info.unit]);
}

export function journalArgs(info: UnitInfo): string[] {
  return info.scope === 'user' ? ['--user', '-u', info.unit] : ['-u', info.unit];
}

/** What to tell someone whose install has no unit at all. */
export function noUnitAdvice(info: UnitInfo, installRoot: string): string {
  if (info.noSystemd) {
    return (
      'systemd is not available on this host, so there is no service to manage.\n' +
      '  Run the bridge in the foreground instead:  agentvoice run'
    );
  }
  // The installer script only ships in a clone; an npm install has no scripts/
  // to point at, and sending someone to a path that does not exist is worse
  // than telling them the truth.
  const installer = join(installRoot, 'scripts', 'install-systemd.sh');
  const how = existsSync(installer)
    ? `  Install one:  bash ${installer}`
    : '  Install one from a clone of the repo (scripts/install-systemd.sh),\n' +
      '  or write a unit that runs:  ' + process.execPath + ' ' + join(installRoot, 'dist', 'index.js');

  return (
    `no ${info.unit} is installed (neither a user nor a system unit).\n` +
    `${how}\n` +
    '  Or run the bridge in the foreground:  agentvoice run'
  );
}

/** Test seam — forget the detected unit. */
export function resetUnitCache(): void {
  cachedUnit = null;
}
