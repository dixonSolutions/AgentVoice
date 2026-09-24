/**
 * `start` / `stop` / `restart` / `logs` — the service verbs, for a systemd
 * unit, a launchd agent or a Windows service (see ../service.ts).
 *
 * These are thin on purpose. The service manager already reports failures, so
 * the CLI adds exactly two things: it picks the right service, and it turns the
 * one failure it explains badly — "no service at all" — into instructions.
 *
 * A restart here is not scripts/restart.sh: that script rebuilds first, which
 * is an update concern. `agentvoice restart` bounces the service and nothing
 * else, which is what you want when you have just edited config.json.
 */

import { detectInstallMode } from '../../serve/installMode.js';
import { passthrough } from '../exec.js';
import { dim, fail, green, note, say } from '../out.js';
import { hasSessionLogs, logFilesCommand } from './logFiles.js';
import {
  controlFailureAdvice,
  controlUnit,
  detectUnit,
  hasJournal,
  journalArgs,
  noUnitAdvice,
  readUnitState,
  type ServiceVerb,
} from '../service.js';

export async function serviceCommand(verb: ServiceVerb): Promise<number> {
  const unit = await detectUnit();
  if (unit.scope === 'none') {
    fail(noUnitAdvice(unit, detectInstallMode().root));
    return 1;
  }

  const code = await controlUnit(unit, verb);
  if (code !== 0) {
    const advice = controlFailureAdvice(unit);
    if (advice) note(advice);
    return 1;
  }

  // systemd returns the moment it has *accepted* the job; the unit can still
  // fail a second later. Report what it settled on, not what was requested.
  const state = await readUnitState(unit);
  const settled = state ? `${state.activeState} (${state.subState})` : 'unknown';
  say(`${green(verb === 'stop' ? 'stopped' : verb === 'start' ? 'started' : 'restarted')}  ${unit.unit} — ${settled}`);

  if (verb !== 'stop' && state?.activeState !== 'active') {
    note(`  Not active. Logs: agentvoice logs -n 50`);
    return 1;
  }
  return 0;
}

export interface LogsOptions {
  lines: number;
  follow: boolean;
  /** Any of these reads the bridge's own log files instead of the journal. */
  files: boolean;
  transcripts: boolean;
  list: boolean;
  cat?: string;
  profile?: string;
}

export async function logsCommand(opts: LogsOptions): Promise<number> {
  const fileOpts = {
    transcripts: opts.transcripts,
    list: opts.list,
    follow: opts.follow,
    lines: opts.lines,
    ...(opts.cat !== undefined ? { cat: opts.cat } : {}),
    ...(opts.profile ? { profile: opts.profile } : {}),
  };
  if (opts.files || opts.transcripts || opts.list || opts.cat !== undefined) {
    return logFilesCommand(fileOpts);
  }

  const unit = await detectUnit();
  if (!hasJournal(unit)) {
    // No systemd unit means no journal — but the bridge writes its own session
    // log however it was started (docs/42), launchd agent and Windows service
    // included, so show that rather than give up.
    if (hasSessionLogs(opts.profile)) {
      if (unit.scope === 'none') note(dim('No service installed — showing the bridge\'s own session log.'));
      return logFilesCommand(fileOpts);
    }
    if (unit.scope !== 'none') {
      fail('no session logs yet — has the service started? Try: agentvoice status');
      return 1;
    }
    fail(noUnitAdvice(unit, detectInstallMode().root));
    return 1;
  }

  const args = [
    ...journalArgs(unit),
    '-n',
    String(opts.lines),
    '-o',
    'short-iso',
    ...(opts.follow ? ['-f'] : ['--no-pager']),
  ];
  // journalctl streams straight to the terminal; Ctrl-C on -f is a normal exit.
  const code = await passthrough('journalctl', args);
  return code === 130 ? 0 : code;
}
