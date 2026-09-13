/**
 * `agentvoice update` — dispatch on how this install actually got here.
 *
 * A clone and an npm install have nothing in common when it comes to getting a
 * newer one, and guessing wrong is destructive in both directions: `npm i -g`
 * inside a clone installs a *second* copy that shadows the one you are
 * developing, and a rebase is meaningless under node_modules. So the mode from
 * detectInstallMode() decides, and `unknown` refuses rather than picks.
 *
 * The git path runs scripts/update.sh — the single update path the Serve page
 * also uses (docs/21) — so a CLI update and an in-app update are the same
 * thing. Flags are passed through rather than re-implemented.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectInstallMode } from '../../serve/installMode.js';
import type { Parsed } from '../args.js';
import { passthrough } from '../exec.js';
import { dim, fail, note, say, yellow } from '../out.js';

/** Flags scripts/update.sh understands that we forward verbatim. */
const GIT_SWITCHES = ['stash', 'dry-run', 'force', 'no-restart'] as const;
const GIT_VALUES = ['branch'] as const;

export async function updateCommand(parsed: Parsed): Promise<number> {
  const install = detectInstallMode();
  const dryRun = parsed.switches.has('dry-run');

  if (install.mode === 'unknown') {
    fail(
      `cannot update this install — ${install.reason}.\n` +
        `  Root: ${install.root}\n` +
        '  Reinstall it the way you want to maintain it:\n' +
        '    npm install -g agentvoice          # managed by npm\n' +
        '    git clone https://github.com/dixonSolutions/AgentVoice.git\n',
    );
    return 1;
  }

  if (install.mode === 'git') {
    const script = join(install.root, 'scripts', 'update.sh');
    if (!existsSync(script)) {
      fail(`${script} is missing — this clone is incomplete.`);
      return 1;
    }
    const args = [script, ...forwardedGitFlags(parsed), ...parsed.rest];
    say(dim(`$ bash ${args.join(' ')}`));
    return passthrough('bash', args, { cwd: install.root });
  }

  // npm: the registry replaces the package wholesale. `global` decides whether
  // that is the shared install or a project-local dependency — installing the
  // wrong one leaves the running copy untouched and looks like a no-op.
  const args = ['install', ...(install.global ? ['-g'] : []), 'agentvoice@latest'];
  if (dryRun) {
    say(`${yellow('dry run')} — would run:`);
    say(`  npm ${args.join(' ')}`);
    return 0;
  }
  say(dim(`$ npm ${args.join(' ')}`));
  const code = await passthrough('npm', args);
  if (code === 0) {
    note('');
    note('  Updated. Restart the bridge to pick it up:  agentvoice restart');
  }
  return code;
}

function forwardedGitFlags(parsed: Parsed): string[] {
  const args: string[] = [];
  for (const flag of GIT_SWITCHES) {
    if (parsed.switches.has(flag)) args.push(`--${flag}`);
  }
  for (const flag of GIT_VALUES) {
    const value = parsed.values.get(flag);
    if (value !== undefined) args.push(`--${flag}`, value);
  }
  return args;
}

export const UPDATE_FLAGS = [...GIT_SWITCHES, ...GIT_VALUES];
