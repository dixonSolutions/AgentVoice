/**
 * `squeakr upgrade-from-agentvoice` — move an AgentVoice install over to
 * Squeakr in one step (docs/44).
 *
 *   1. Stop the background service, so nothing writes to the home mid-move.
 *   2. Move the home: ~/.agentvoice → ~/.squeakr, everything in it — config,
 *      .env (keys and pairing token), data/state.db, logs, transcripts, the
 *      Vosk model — and leave ~/.agentvoice behind as a symlink to it, so a
 *      path anything else remembered keeps resolving.
 *   3. Point the service at this install and this home, then start it.
 *   4. A clone: switch `origin` from dixonSolutions/AgentVoice to
 *      dixonSolutions/Squeakr, once the new URL answers.
 *   5. Remove the old npm package, @ratitisrad/agentvoice.
 *
 * Every step is idempotent: run it twice and the second run reports "already
 * done" for each. `--dry-run` prints the plan and changes nothing.
 *
 * What it deliberately leaves alone: the service *names* (agentvoice.service,
 * com.agentvoice.bridge, the AgentVoice Windows service), the .deb/.rpm
 * package name and the MCP server key — stage B of the rename, docs/44.
 */

import { existsSync, lstatSync, readlinkSync, renameSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { HOME_DIR_NAME, LEGACY_HOME_DIR_NAME, hasHomeState } from '../../brand.js';
import { detectInstallMode, LEGACY_PACKAGE_NAME } from '../../serve/installMode.js';
import { capture, passthrough, ran } from '../exec.js';
import { resolveHome } from '../home.js';
import { bold, dim, fail, green, note, say, yellow } from '../out.js';
import { detectUnit, readUnitState } from '../service.js';
import { serviceCommand } from './service.js';
import { serviceInstallCommand } from './serviceInstall.js';

export interface UpgradeOptions {
  dryRun?: boolean;
  /** Leave @ratitisrad/agentvoice installed. */
  keepOld?: boolean;
  /** Leave a clone's `origin` remote as it is. */
  keepRemote?: boolean;
  /** For tests: the user's home directory. */
  userHome?: string;
}

/** Where a clone's `origin` should point after the GitHub repo rename. */
export const SQUEAKR_REPO = 'dixonSolutions/Squeakr';

/** Repo names the project was published under before. */
const LEGACY_REPO_RE = /^(.*[/:])dixonSolutions\/(?:AgentVoice|Cursor-Voice)(\.git)?\/?$/i;

/**
 * `origin`'s new URL, keeping its scheme (https or ssh) and `.git` suffix, or
 * null when it does not point at one of the old repo names.
 */
export function renamedRemote(url: string): string | null {
  const m = LEGACY_REPO_RE.exec(url.trim());
  if (!m) return null;
  return `${m[1]}${SQUEAKR_REPO}${m[2] ?? ''}`;
}

export type HomeMove =
  | { kind: 'move'; from: string; to: string }
  | { kind: 'already'; from: string; to: string }
  | { kind: 'nothing'; reason: string }
  | { kind: 'conflict'; from: string; to: string };

/**
 * Decide what to do with the home directory. Pure apart from reading the file
 * system, so it is tested without moving anything.
 *
 * A custom $AGENTVOICE_HOME / $SQUEAKR_HOME is left where it is: the user put
 * it there on purpose, and the env-var fallback keeps finding it.
 */
export function planHomeMove(userHome: string, env: NodeJS.ProcessEnv = process.env): HomeMove {
  const from = join(userHome, LEGACY_HOME_DIR_NAME);
  const to = join(userHome, HOME_DIR_NAME);

  const custom = env['SQUEAKR_HOME'] || env['AGENTVOICE_HOME'];
  if (custom && resolve(custom) !== resolve(from) && resolve(custom) !== resolve(to)) {
    return { kind: 'nothing', reason: `the home is ${custom} (set by an environment variable) — left where it is` };
  }

  let link: ReturnType<typeof lstatSync> | null = null;
  try {
    link = lstatSync(from);
  } catch {
    /* no ~/.agentvoice */
  }
  if (link?.isSymbolicLink()) {
    let target = '';
    try {
      target = resolve(dirname(from), readlinkSync(from));
    } catch {
      /* unreadable link — treat as already handled */
    }
    if (!target || resolve(target) === resolve(to)) return { kind: 'already', from, to };
    return { kind: 'nothing', reason: `${from} is a symlink to ${target} — left alone` };
  }
  if (!link) {
    return hasHomeState(to)
      ? { kind: 'already', from, to }
      : { kind: 'nothing', reason: `no ${from} to move` };
  }
  if (existsSync(to)) return { kind: 'conflict', from, to };
  return { kind: 'move', from, to };
}

export async function upgradeFromAgentvoiceCommand(opts: UpgradeOptions = {}): Promise<number> {
  const dry = Boolean(opts.dryRun);
  const userHome = opts.userHome ?? homedir();
  const install = detectInstallMode();
  // A clone is its own home; ~/.agentvoice then only holds the Vosk model, and
  // the service must keep running from the clone.
  const homeBefore = resolve(resolveHome());
  let problems = 0;

  say('');
  say(`  ${bold(dry ? 'squeakr upgrade-from-agentvoice — dry run, nothing will change' : 'squeakr upgrade-from-agentvoice')}`);
  say('');

  // ── 1 + 2: the home ──────────────────────────────────────────────────────
  const move = planHomeMove(userHome);
  const unit = await detectUnit();
  const state = unit.scope === 'none' ? null : await readUnitState(unit);
  const wasActive = state?.activeState === 'active';

  if (move.kind === 'conflict') {
    fail(
      `both ${move.from} and ${move.to} exist — not merging them.\n` +
        `  If ${move.to} is a fresh, empty start, remove it and re-run.\n` +
        `  To carry only the config and keys across instead:  squeakr migrate ${move.from} --to ${move.to} --with-data`,
    );
    return 1;
  }

  if (move.kind === 'move') {
    if (dry) {
      if (wasActive) say(`  ${yellow('would')}  stop ${unit.unit}`);
      say(`  ${yellow('would')}  move ${move.from} → ${move.to} (config, .env, data, logs, vosk)`);
      say(`  ${yellow('would')}  leave ${move.from} as a symlink to ${move.to}`);
    } else {
      if (wasActive) {
        const stopped = await serviceCommand('stop');
        if (stopped !== 0) {
          fail(`could not stop ${unit.unit} — not moving a home a running bridge is writing to.`);
          return 1;
        }
      }
      try {
        renameSync(move.from, move.to);
      } catch (err) {
        fail(`could not move ${move.from} → ${move.to}: ${err instanceof Error ? err.message : String(err)}`);
        if (wasActive) await serviceCommand('start');
        return 1;
      }
      say(`  ${green('moved')}  ${move.from} → ${move.to}`);
      try {
        symlinkSync(move.to, move.from, process.platform === 'win32' ? 'junction' : 'dir');
        say(`  ${green('linked')}  ${move.from} → ${move.to} ${dim('(so old paths keep working)')}`);
      } catch (err) {
        note(`  ${yellow('note')}  could not leave a symlink at ${move.from} (${err instanceof Error ? err.message : String(err)}) — nothing needs it.`);
      }
    }
  } else if (move.kind === 'already') {
    say(`  ${green('ok')}  home already at ${move.to}`);
  } else {
    say(`  ${dim('skip')}  ${move.reason}`);
  }

  // Everything below resolves the home through SQUEAKR_HOME, so the service is
  // written for the new location even though `~/.agentvoice` still resolves.
  if (
    (move.kind === 'move' || move.kind === 'already') &&
    (homeBefore === resolve(move.from) || homeBefore === resolve(move.to))
  ) {
    process.env['SQUEAKR_HOME'] = move.to;
  }

  // ── 3: the service ───────────────────────────────────────────────────────
  if (unit.scope === 'none') {
    say(`  ${dim('skip')}  no background service installed ${dim('(squeakr service install --now adds one)')}`);
  } else if (dry) {
    say(`  ${yellow('would')}  rewrite ${unit.unit} to run this install (${install.root}) and start it`);
  } else {
    // --force: the AgentVoice unit differs (old launcher path, old home); --now
    // reloads it (launchd boots the old definition out first).
    const written = await serviceInstallCommand({ force: true, now: true });
    if (written !== 0) {
      problems++;
      note(`  ${yellow('note')}  fix the above, then:  squeakr service install --force --now`);
    } else if (unit.scope === 'user' || unit.scope === 'system') {
      // `enable --now` leaves an already-active unit running the old ExecStart.
      const restarted = await serviceCommand('restart');
      if (restarted !== 0) problems++;
    }
  }

  // ── 4: a clone's remote ──────────────────────────────────────────────────
  if (install.mode === 'git' && !opts.keepRemote) {
    problems += await switchRemote(install.root, dry);
  }

  // ── 5: the old npm package ───────────────────────────────────────────────
  if (!opts.keepOld) {
    problems += await removeLegacyPackage(install.root, dry);
  }

  say('');
  if (dry) {
    say(`  ${bold('Dry run done.')} Run it again without --dry-run to do it.`);
  } else if (problems) {
    say(`  ${yellow(bold('Upgraded, with notes above.'))} Your settings and data are in place either way.`);
  } else {
    say(`  ${green(bold('Upgraded to Squeakr.'))} Same token, same settings — the app keeps working as it was.`);
    note(dim('  Check it:  squeakr status'));
  }
  return dry || !problems ? 0 : 1;
}

async function switchRemote(root: string, dry: boolean): Promise<number> {
  const current = await capture('git', ['-C', root, 'remote', 'get-url', 'origin']);
  if (!ran(current) || current.code !== 0) {
    say(`  ${dim('skip')}  no git origin in ${root}`);
    return 0;
  }
  const url = current.stdout.trim();
  const next = renamedRemote(url);
  if (!next) {
    say(`  ${green('ok')}  origin is ${url}`);
    return 0;
  }
  // Before the repo is renamed on GitHub the new URL does not exist yet, and
  // the old one keeps working — so only switch once the new one answers.
  const probe = await capture('git', ['ls-remote', '--heads', next], { timeoutMs: 30_000 });
  if (probe.code !== 0) {
    say(`  ${dim('skip')}  ${next} does not answer yet — origin stays ${url} ${dim('(GitHub redirects it; re-run after the repo rename)')}`);
    return 0;
  }
  if (dry) {
    say(`  ${yellow('would')}  set origin ${url} → ${next}`);
    return 0;
  }
  const set = await capture('git', ['-C', root, 'remote', 'set-url', 'origin', next]);
  if (set.code !== 0) {
    fail(`could not set origin: ${set.stderr.trim()}`);
    return 1;
  }
  say(`  ${green('remote')}  origin → ${next}`);
  return 0;
}

async function removeLegacyPackage(root: string, dry: boolean): Promise<number> {
  // Never uninstall the copy that is running this command.
  if (root.split(/[\\/]/).includes('@ratitisrad')) {
    say(`  ${dim('skip')}  this command is running from ${LEGACY_PACKAGE_NAME} itself — install squeakr and run it from there`);
    return 0;
  }
  const listed = await capture('npm', ['ls', '-g', LEGACY_PACKAGE_NAME, '--depth=0', '--json'], { timeoutMs: 60_000 });
  if (!ran(listed)) {
    say(`  ${dim('skip')}  npm not found — nothing to remove`);
    return 0;
  }
  let present = false;
  try {
    const tree = JSON.parse(listed.stdout || '{}') as { dependencies?: Record<string, unknown> };
    present = Boolean(tree.dependencies?.[LEGACY_PACKAGE_NAME]);
  } catch {
    /* unparseable — assume absent */
  }
  if (!present) {
    say(`  ${green('ok')}  ${LEGACY_PACKAGE_NAME} is not installed globally`);
    return 0;
  }
  if (dry) {
    say(`  ${yellow('would')}  npm rm -g ${LEGACY_PACKAGE_NAME}`);
    return 0;
  }
  const code = await passthrough('npm', ['rm', '-g', LEGACY_PACKAGE_NAME]);
  if (code !== 0) {
    fail(`npm rm -g ${LEGACY_PACKAGE_NAME} failed — remove it by hand when convenient; Squeakr does not need it.`);
    return 1;
  }
  say(`  ${green('removed')}  ${LEGACY_PACKAGE_NAME}`);
  return 0;
}
