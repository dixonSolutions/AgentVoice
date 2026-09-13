/**
 * `start` / `stop` / `restart` / `logs` — the systemd verbs.
 *
 * These are thin on purpose. systemd already reports failures well, so the CLI
 * adds exactly two things: it picks the right unit scope, and it turns the one
 * failure systemd explains badly — "no unit at all" — into instructions.
 *
 * A restart here is not scripts/restart.sh: that script rebuilds first, which
 * is an update concern. `agentvoice restart` bounces the service and nothing
 * else, which is what you want when you have just edited config.json.
 */

import { detectInstallMode } from '../../serve/installMode.js';
import { passthrough } from '../exec.js';
import { fail, green, note, say } from '../out.js';
import { controlUnit, detectUnit, journalArgs, noUnitAdvice, readUnitState } from '../service.js';

export async function serviceCommand(verb: 'start' | 'stop' | 'restart'): Promise<number> {
  const unit = await detectUnit();
  if (unit.scope === 'none') {
    fail(noUnitAdvice(unit, detectInstallMode().root));
    return 1;
  }

  const code = await controlUnit(unit, verb);
  if (code !== 0) {
    if (unit.scope === 'system') {
      note('  A system unit needs root. `sudo -n` was used so this never hangs on a');
      note('  hidden password prompt — configure passwordless sudo, or run as root.');
    }
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

export async function logsCommand(opts: { lines: number; follow: boolean }): Promise<number> {
  const unit = await detectUnit();
  if (unit.scope === 'none') {
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
