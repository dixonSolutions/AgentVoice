/**
 * The background service behind `start`, `stop`, `restart`, `status` and `logs`
 * — whichever service manager this platform has:
 *
 *   Linux    a systemd unit, `agentvoice.service` (user unit first, then system)
 *   macOS    a launchd agent, `com.agentvoice.bridge`
 *   Windows  a Windows service, `AgentVoice` (NSSM-wrapped, as scripts/setup.ps1
 *            and `agentvoice service install` create it)
 *
 * systemd detection mirrors scripts/update.sh and src/serve/index.ts exactly,
 * and that order is load-bearing: `systemctl --user cat` first, then the system
 * unit. Most installs are user units (scripts/install-systemd.sh writes one),
 * and probing the system manager first would either need sudo or report the
 * wrong unit on a host that happens to have both.
 *
 * A system unit needs root, so it goes through `sudo -n` — non-interactive on
 * purpose. A CLI that silently blocks on a hidden password prompt is worse than
 * one that says "passwordless sudo required". A Windows service likewise needs
 * an elevated terminal; that is reported, not worked around.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { capture, passthrough, ran } from './exec.js';

/** Fixed unit name — never interpolated from user input. */
export const SERVICE_UNIT = 'agentvoice.service';
/** launchd label for the per-user agent on macOS. */
export const LAUNCHD_LABEL = 'com.agentvoice.bridge';
/** Windows service name — the one scripts/setup.ps1 has always installed. */
export const WINDOWS_SERVICE = 'AgentVoice';

export type UnitScope = 'user' | 'system' | 'launchd' | 'windows' | 'none';

export interface UnitInfo {
  scope: UnitScope;
  /** The name the service manager knows it by. */
  unit: string;
  /**
   * True when this platform's service manager is missing altogether (a
   * container, WSL1, a Linux without systemd), so there is nothing to install.
   */
  noSystemd: boolean;
}

/** `~/Library/LaunchAgents/com.agentvoice.bridge.plist`. */
export function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function launchdTarget(): string {
  return `${launchdDomain()}/${LAUNCHD_LABEL}`;
}

/** "Linux: systemd unit", for the human-facing lines. */
export function describeUnit(info: UnitInfo): string {
  switch (info.scope) {
    case 'user':
      return `${info.unit} (systemd user unit)`;
    case 'system':
      return `${info.unit} (systemd system unit)`;
    case 'launchd':
      return `${info.unit} (launchd agent)`;
    case 'windows':
      return `${info.unit} (Windows service)`;
    default:
      return info.unit;
  }
}

/** Does this scope write to journald, so `logs` should read the journal? */
export function hasJournal(info: UnitInfo): boolean {
  return info.scope === 'user' || info.scope === 'system';
}

let cachedUnit: UnitInfo | null = null;

export async function detectUnit(): Promise<UnitInfo> {
  if (cachedUnit) return cachedUnit;
  cachedUnit =
    process.platform === 'win32'
      ? await detectWindows()
      : process.platform === 'darwin'
        ? detectLaunchd()
        : await detectSystemd();
  return cachedUnit;
}

async function detectSystemd(): Promise<UnitInfo> {
  const user = await capture('systemctl', ['--user', 'cat', SERVICE_UNIT]);
  if (!ran(user)) return { scope: 'none', unit: SERVICE_UNIT, noSystemd: true };
  if (user.code === 0) return { scope: 'user', unit: SERVICE_UNIT, noSystemd: false };

  const system = await capture('systemctl', ['cat', SERVICE_UNIT]);
  return { scope: system.code === 0 ? 'system' : 'none', unit: SERVICE_UNIT, noSystemd: false };
}

function detectLaunchd(): UnitInfo {
  return {
    scope: existsSync(launchdPlistPath()) ? 'launchd' : 'none',
    unit: LAUNCHD_LABEL,
    noSystemd: false,
  };
}

async function detectWindows(): Promise<UnitInfo> {
  const query = await capture('sc.exe', ['query', WINDOWS_SERVICE]);
  return {
    scope: query.code === 0 ? 'windows' : 'none',
    unit: WINDOWS_SERVICE,
    noSystemd: !ran(query),
  };
}

export interface UnitState {
  /** loaded | not-found | masked … straight from the service manager. */
  loadState: string;
  /** active | inactive | failed … (normalised to systemd's words) */
  activeState: string;
  /** running | dead | exited … */
  subState: string;
  /** When the unit entered its current active state, ISO-ish, or null. */
  since: string | null;
  mainPid: number | null;
  /** enabled | disabled | static | auto | manual … null when it would not say. */
  enabled: string | null;
}

export async function readUnitState(info: UnitInfo): Promise<UnitState | null> {
  switch (info.scope) {
    case 'user':
    case 'system':
      return readSystemdState(info);
    case 'launchd':
      return readLaunchdState();
    case 'windows':
      return readWindowsState();
    default:
      return null;
  }
}

async function readSystemdState(info: UnitInfo): Promise<UnitState | null> {
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

/** `launchctl print` is not a stable format, so read only its two plainest lines. */
export function parseLaunchctlPrint(stdout: string): { state: string | null; pid: number | null } {
  const state = /^\s*state = (.+)$/m.exec(stdout)?.[1]?.trim() ?? null;
  const pid = Number(/^\s*pid = (\d+)/m.exec(stdout)?.[1] ?? '0');
  return { state, pid: pid > 0 ? pid : null };
}

async function readLaunchdState(): Promise<UnitState> {
  const result = await capture('launchctl', ['print', launchdTarget()]);
  if (result.code !== 0) {
    // The plist exists but is not bootstrapped: installed, not loaded.
    return {
      loadState: 'not-loaded',
      activeState: 'inactive',
      subState: 'not loaded',
      since: null,
      mainPid: null,
      enabled: 'installed',
    };
  }
  const { state, pid } = parseLaunchctlPrint(result.stdout);
  return {
    loadState: 'loaded',
    activeState: state === 'running' ? 'active' : 'inactive',
    subState: state ?? 'unknown',
    since: null,
    mainPid: pid,
    enabled: 'loaded',
  };
}

/** `sc.exe queryex` / `sc.exe qc` output → state, pid and start type. */
export function parseScQuery(stdout: string): { state: string | null; pid: number | null; startType: string | null } {
  const state = /STATE\s*:\s*\d+\s+(\w+)/.exec(stdout)?.[1] ?? null;
  const pid = Number(/PID\s*:\s*(\d+)/.exec(stdout)?.[1] ?? '0');
  const startType = /START_TYPE\s*:\s*\d+\s+(\w+)/.exec(stdout)?.[1] ?? null;
  return { state, pid: pid > 0 ? pid : null, startType };
}

async function readWindowsState(): Promise<UnitState | null> {
  const query = await capture('sc.exe', ['queryex', WINDOWS_SERVICE]);
  if (query.code !== 0) return null;
  const { state, pid } = parseScQuery(query.stdout);
  const config = await capture('sc.exe', ['qc', WINDOWS_SERVICE]);
  const { startType } = parseScQuery(config.stdout);
  return {
    loadState: 'loaded',
    activeState: state === 'RUNNING' ? 'active' : state === 'STOPPED' ? 'inactive' : 'activating',
    subState: state?.toLowerCase() ?? 'unknown',
    since: null,
    mainPid: pid,
    enabled: startType === 'AUTO_START' ? 'auto' : startType === 'DEMAND_START' ? 'manual' : (startType?.toLowerCase() ?? null),
  };
}

export type ServiceVerb = 'start' | 'stop' | 'restart';

/**
 * Start, stop or restart the service, with output going to the user's
 * terminal. Returns the service manager's exit code.
 */
export async function controlUnit(info: UnitInfo, verb: ServiceVerb): Promise<number> {
  switch (info.scope) {
    case 'user':
      return passthrough('systemctl', ['--user', verb, info.unit]);
    case 'system':
      // Already root (a system-unit install run by root): no sudo hop needed.
      if (process.getuid?.() === 0) return passthrough('systemctl', [verb, info.unit]);
      return passthrough('sudo', ['-n', 'systemctl', verb, info.unit]);
    case 'launchd':
      return controlLaunchd(verb);
    case 'windows':
      return controlWindows(verb);
    default:
      return 1;
  }
}

async function controlLaunchd(verb: ServiceVerb): Promise<number> {
  const loaded = (await capture('launchctl', ['print', launchdTarget()])).code === 0;
  if (verb === 'stop') {
    // bootout, not kill: with KeepAlive a killed agent comes straight back.
    return loaded ? passthrough('launchctl', ['bootout', launchdTarget()]) : 0;
  }
  if (!loaded) {
    const code = await passthrough('launchctl', ['bootstrap', launchdDomain(), launchdPlistPath()]);
    if (code !== 0) return code;
  }
  return passthrough('launchctl', ['kickstart', ...(verb === 'restart' ? ['-k'] : []), launchdTarget()]);
}

async function controlWindows(verb: ServiceVerb): Promise<number> {
  if (verb === 'start') return passthrough('sc.exe', ['start', WINDOWS_SERVICE]);
  const stop = await passthrough('sc.exe', ['stop', WINDOWS_SERVICE]);
  // 1062 = "the service has not been started": already stopped is fine.
  if (stop !== 0 && stop !== 1062) return stop;
  if (verb === 'stop') return 0;
  // sc.exe returns as soon as the stop is *requested*; a start issued while it
  // is still STOP_PENDING fails with 1056.
  for (let i = 0; i < 30; i++) {
    const { state } = parseScQuery((await capture('sc.exe', ['query', WINDOWS_SERVICE])).stdout);
    if (state === 'STOPPED') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return passthrough('sc.exe', ['start', WINDOWS_SERVICE]);
}

/** Why a start/stop failed, when the service manager itself says little. */
export function controlFailureAdvice(info: UnitInfo): string | null {
  if (info.scope === 'system') {
    return (
      '  A system unit needs root. `sudo -n` was used so this never hangs on a\n' +
      '  hidden password prompt — configure passwordless sudo, or run as root.'
    );
  }
  if (info.scope === 'windows') {
    return '  Controlling a Windows service needs an elevated (Administrator) terminal.';
  }
  return null;
}

export function journalArgs(info: UnitInfo): string[] {
  return info.scope === 'user' ? ['--user', '-u', info.unit] : ['-u', info.unit];
}

/** What to tell someone whose install has no service at all. */
export function noUnitAdvice(info: UnitInfo, installRoot: string): string {
  if (info.noSystemd) {
    return (
      'no service manager is available on this host, so there is no service to manage.\n' +
      '  Run the bridge in the foreground instead:  agentvoice run'
    );
  }

  const kind =
    process.platform === 'darwin'
      ? `launchd agent (${LAUNCHD_LABEL})`
      : process.platform === 'win32'
        ? `Windows service (${WINDOWS_SERVICE})`
        : `${info.unit} (neither a user nor a system unit)`;

  /**
   * `agentvoice service install` works from whatever install is running, so it
   * is the answer for everyone. The shell scripts only exist in a clone, and
   * pointing an npm or .deb user at a path that is not there was worse than
   * saying nothing (docs/38).
   */
  const script =
    process.platform === 'win32'
      ? join(installRoot, 'scripts', 'setup.ps1')
      : process.platform === 'linux'
        ? join(installRoot, 'scripts', 'install-systemd.sh')
        : null;
  const extra = script && existsSync(script)
    ? `\n  Or, in this clone:  ${process.platform === 'win32' ? '' : 'bash '}${script}`
    : '';

  return (
    `no ${kind} is installed.\n` +
    '  Install one:  agentvoice service install --now' +
    `${extra}\n` +
    '  Or run the bridge in the foreground:  agentvoice run'
  );
}

/** Test seam — forget the detected unit. */
export function resetUnitCache(): void {
  cachedUnit = null;
}
