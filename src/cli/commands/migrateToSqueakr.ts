/**
 * `agentvoice migrate-to-squeakr` — the last thing this package does.
 *
 * AgentVoice was renamed Squeakr, and the npm package moved from
 * `@ratitisrad/agentvoice` to `squeakr`. `npm update` never crosses package
 * names, so this release (0.1.6, the final one) exists only to carry installs
 * across:
 *
 *   1. `npm install -g squeakr`. Its postinstall notices this package beside
 *      it and points the background service at Squeakr.
 *   2. `squeakr upgrade-from-agentvoice` from the new install: moves
 *      ~/.agentvoice → ~/.squeakr (config, keys, database, logs, Vosk model),
 *      re-points the service, switches a clone's git remote, and removes this
 *      package with `npm rm -g @ratitisrad/agentvoice`.
 *
 * Step 2 runs from the *new* package on purpose: a command cannot cleanly
 * uninstall the package it is running from.
 *
 * Clones and .deb/.rpm installs do not need this — see the Squeakr repo's
 * docs/44-rename-squeakr.md.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectInstallMode } from '../../serve/installMode.js';
import { capture, passthrough } from '../exec.js';
import { bold, dim, fail, green, note, say } from '../out.js';

export const NEW_PACKAGE = 'squeakr';

export interface MigrateToSqueakrOptions {
  dryRun?: boolean;
}

export async function migrateToSqueakrCommand(opts: MigrateToSqueakrOptions = {}): Promise<number> {
  const install = detectInstallMode();
  say('');
  say(`  ${bold('AgentVoice is now Squeakr.')} Moving this install over.`);
  say('');

  if (install.mode === 'git') {
    note('  This is a clone. Pull the latest main instead — it is Squeakr — then run:');
    note('    node bin/agentvoice.mjs upgrade-from-agentvoice');
    note(dim('  (that moves ~/.agentvoice and switches origin to dixonSolutions/Squeakr)'));
    return 0;
  }
  if (install.mode === 'system') {
    note('  This is a .deb / .rpm install. Upgrade it with your package manager — the');
    note('  next release is Squeakr, and it carries your settings over by itself:');
    note('    sudo apt update && sudo apt install --only-upgrade agentvoice   # or: sudo dnf upgrade agentvoice');
    return 0;
  }

  if (opts.dryRun) {
    say(`  ${dim('would')}  npm install -g ${NEW_PACKAGE}`);
    say(`  ${dim('would')}  squeakr upgrade-from-agentvoice   (home, service, then npm rm -g @ratitisrad/agentvoice)`);
    return 0;
  }

  say(`  ${bold(`npm install -g ${NEW_PACKAGE}`)}`);
  const installed = await passthrough('npm', ['install', '-g', NEW_PACKAGE]);
  if (installed !== 0) {
    fail(
      `npm install -g ${NEW_PACKAGE} failed. Nothing else was changed — AgentVoice keeps running.\n` +
        `  Fix the npm error above and re-run:  agentvoice migrate-to-squeakr`,
    );
    return 1;
  }

  const root = await capture('npm', ['root', '-g'], { timeoutMs: 60_000 });
  const shim = join(root.stdout.trim(), NEW_PACKAGE, 'bin', 'agentvoice.mjs');
  if (root.code !== 0 || !existsSync(shim)) {
    fail(`installed ${NEW_PACKAGE}, but could not find it to finish the move. Run:  squeakr upgrade-from-agentvoice`);
    return 1;
  }

  say('');
  const code = await passthrough(process.execPath, [shim, 'upgrade-from-agentvoice']);
  if (code === 0) {
    say('');
    say(`  ${green(bold('Done.'))} From now on the command is ${bold('squeakr')} — try: squeakr status`);
  }
  return code;
}

/** One line, printed by every command but this one, until the install moves. */
export function renameNotice(): string {
  return (
    `${bold('AgentVoice is now Squeakr.')} This package gets no more updates — move over with:  ` +
    bold('agentvoice migrate-to-squeakr')
  );
}
