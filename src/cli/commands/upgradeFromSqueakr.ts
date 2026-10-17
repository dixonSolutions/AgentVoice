/**
 * `squeaky upgrade-from-squeakr` — move an install made under either earlier
 * name, Squeakr (0.2.x, docs/45) or AgentVoice (≤ 0.1.x), over to Squeaky in
 * one step (docs/46). `upgrade-from-agentvoice` is the same command under the
 * name the AgentVoice → Squeakr docs and scripts gave it.
 *
 *   0. A .deb / .rpm install: move the apt / dnf source to the new URL and
 *      swap the `squeakr` / `agentvoice` package for `squeaky` — through
 *      scripts/migrate-to-squeaky.sh --system-only, which uses sudo.
 *   1. Stop the background service, so nothing writes to the home mid-move.
 *   2. Move the home: ~/.squeakr (or, from AgentVoice, ~/.agentvoice) →
 *      ~/.squeaky, everything in it — config, .env (keys and pairing token),
 *      data/state.db, logs, transcripts, the Vosk model — and leave the old
 *      directory behind as a symlink to it, so a path anything else
 *      remembered keeps resolving. A symlink between the old names (Squeakr's
 *      own upgrade left ~/.agentvoice → ~/.squeakr) is re-pointed at the new
 *      home, so nothing resolves through two hops.
 *   3. Replace the old service (squeakr.service / agentvoice.service and their
 *      companions, com.squeakr.bridge / com.agentvoice.bridge, the Squeakr /
 *      AgentVoice Windows service) with Squeaky's, for this install and this
 *      home, and start it.
 *   4. A clone: switch `origin` from dixonSolutions/Squeakr, /AgentVoice or
 *      /Cursor-Voice to dixonSolutions/Squeaky, once the new URL answers.
 *   5. Remove the old npm packages, squeakr and @ratitisrad/agentvoice.
 *
 * Every step is idempotent: run it twice and the second run reports "already
 * done" for each. `--dry-run` prints the plan and changes nothing.
 *
 * The MCP server key moves by itself: the bridge registers `squeaky` with
 * every agent CLI at startup and strips the old `squeakr` / `agent-voice`
 * entries.
 */

import { existsSync, lstatSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { HOME_DIR_NAME, LEGACY_HOME_DIR_NAMES, brandEnv, hasHomeState, legacyHomeDir } from '../../brand.js';
import { detectInstallMode, LEGACY_PACKAGE_NAMES, legacyPackageAt } from '../../serve/installMode.js';
import { capture, passthrough, ran } from '../exec.js';
import { resolveHome } from '../home.js';
import { bold, dim, fail, green, note, say, yellow } from '../out.js';
import { findLegacyServices, stopLegacyService } from '../legacyService.js';
import { detectUnit, readUnitState } from '../service.js';
import { serviceCommand } from './service.js';
import { serviceInstallCommand } from './serviceInstall.js';

export interface UpgradeOptions {
  dryRun?: boolean;
  /** Leave the old npm packages (squeakr, @ratitisrad/agentvoice) installed. */
  keepOld?: boolean;
  /** Leave a clone's `origin` remote as it is. */
  keepRemote?: boolean;
  /** Skip the .deb / .rpm step (the migration script already did it). */
  skipSystem?: boolean;
  /** For tests: the user's home directory. */
  userHome?: string;
}

/** Where a clone's `origin` should point after the GitHub repo rename. */
export const SQUEAKY_REPO = 'dixonSolutions/Squeaky';

/** Repo names the project was published under before. */
const LEGACY_REPO_RE = /^(.*[/:])dixonSolutions\/(?:Squeakr|AgentVoice|Cursor-Voice)(\.git)?\/?$/i;

/**
 * `origin`'s new URL, keeping its scheme (https or ssh) and `.git` suffix, or
 * null when it does not point at one of the old repo names.
 */
export function renamedRemote(url: string): string | null {
  const m = LEGACY_REPO_RE.exec(url.trim());
  if (!m) return null;
  return `${m[1]}${SQUEAKY_REPO}${m[2] ?? ''}`;
}

export type HomeMove =
  /** Rename `from` to `to`, leave a symlink at `from`, re-point `relink` at `to`. */
  | { kind: 'move'; from: string; to: string; relink: string[] }
  | { kind: 'already'; from: string; to: string }
  | { kind: 'nothing'; reason: string }
  | { kind: 'conflict'; from: string; to: string };

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Decide what to do with the home directory. Pure apart from reading the file
 * system, so it is tested without moving anything.
 *
 * The home that moves is the one the bridge is using today: the newest old
 * name holding state (brand.ts#legacyHomeDir), or — when none does, as in a
 * clone, which is its own home — the newest one that exists at all (it still
 * holds the Vosk model and logs). Followed through symlinks: `~/.squeakr` →
 * `~/.agentvoice` moves `~/.agentvoice` and re-points `~/.squeakr`. An old
 * name linked somewhere else entirely is a home the user placed on purpose,
 * and stays where it is.
 *
 * A custom $SQUEAKY_HOME / $SQUEAKR_HOME / $AGENTVOICE_HOME is left where it
 * is too: the user put it there on purpose, and the env-var fallback keeps
 * finding it.
 */
export function planHomeMove(userHome: string, env: NodeJS.ProcessEnv = process.env): HomeMove {
  const to = join(userHome, HOME_DIR_NAME);
  const legacy = LEGACY_HOME_DIR_NAMES.map((name) => join(userHome, name));

  const custom = brandEnv('HOME', env);
  if (custom && ![to, ...legacy].some((dir) => resolve(custom) === resolve(dir))) {
    return { kind: 'nothing', reason: `the home is ${custom} (set by an environment variable) — left where it is` };
  }

  // A stateless old directory next to a ~/.squeaky that has state is a
  // leftover, not a home: the bridge already uses ~/.squeaky.
  const active = legacyHomeDir(userHome) ?? (hasHomeState(to) ? null : legacy.find((dir) => existsSync(dir)) ?? null);
  if (!active) {
    return hasHomeState(to)
      ? { kind: 'already', from: legacy[0]!, to }
      : { kind: 'nothing', reason: `no ${legacy.join(' or ')} to move` };
  }

  // Unreadable or dangling: treat as already handled, as a link would be.
  const real = realpathOrNull(active);
  if (!real || real === realpathOrNull(to)) return { kind: 'already', from: active, to };

  // The real directory behind it, when that is one of the old names.
  const from = legacy.find((dir) => !isSymlink(dir) && realpathOrNull(dir) === real);
  if (!from) {
    let target = real;
    try {
      target = resolve(dirname(active), readlinkSync(active));
    } catch {
      /* not a link after all — report the resolved path */
    }
    return { kind: 'nothing', reason: `${active} is a symlink to ${target} — left alone` };
  }

  let toExists = false;
  try {
    lstatSync(to);
    toExists = true;
  } catch {
    /* no ~/.squeaky yet */
  }
  if (toExists) return { kind: 'conflict', from, to };

  const relink = legacy.filter((dir) => dir !== from && isSymlink(dir) && realpathOrNull(dir) === real);
  return { kind: 'move', from, to, relink };
}

/** Same directory, through any symlinks; false when either is missing. */
function sameDir(a: string, b: string): boolean {
  const ra = realpathOrNull(a);
  return ra !== null && ra === realpathOrNull(b);
}

function linkDir(target: string, at: string): void {
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

export async function upgradeFromSqueakrCommand(opts: UpgradeOptions = {}): Promise<number> {
  const dry = Boolean(opts.dryRun);
  const userHome = opts.userHome ?? homedir();
  const install = detectInstallMode();
  // A clone is its own home; ~/.squeakr then only holds the Vosk model, and
  // the service must keep running from the clone.
  const homeBefore = resolve(resolveHome());
  let problems = 0;

  say('');
  say(`  ${bold(dry ? 'squeaky upgrade-from-squeakr — dry run, nothing will change' : 'squeaky upgrade-from-squeakr')}`);
  say('');

  // ── 0: a .deb / .rpm install ─────────────────────────────────────────────
  if (!opts.skipSystem && process.platform === 'linux') {
    const found = await legacySystemInstall();
    if (found) {
      const script = join(install.root, 'scripts', 'migrate-to-squeaky.sh');
      if (!existsSync(script)) {
        problems++;
        note(`  ${yellow('note')}  ${found}, but ${script} is missing. Run:`);
        note('          curl -fsSL https://raw.githubusercontent.com/dixonSolutions/Squeaky/main/scripts/migrate-to-squeaky.sh | bash');
      } else {
        const code = await passthrough('bash', [script, '--system-only', ...(dry ? ['--dry-run'] : [])]);
        if (code !== 0) problems++;
      }
    }
  }

  // ── 1 + 2: the home ──────────────────────────────────────────────────────
  const move = planHomeMove(userHome);
  const unit = await detectUnit();
  const state = unit.scope === 'none' ? null : await readUnitState(unit);
  const legacy = await findLegacyServices();
  const running = legacy.filter((svc) => svc.active);
  const wasActive = state?.activeState === 'active' || running.length > 0;
  // Decided before the move: afterwards the old path resolves to the new home
  // and every comparison would match.
  const followsHome =
    (move.kind === 'move' && sameDir(homeBefore, move.from)) || (move.kind === 'already' && sameDir(homeBefore, move.to));

  if (move.kind === 'conflict') {
    fail(
      `both ${move.from} and ${move.to} exist — not merging them.\n` +
        `  If ${move.to} is a fresh, empty start, remove it and re-run.\n` +
        `  To carry only the config and keys across instead:  squeaky migrate ${move.from} --to ${move.to} --with-data`,
    );
    return 1;
  }

  if (move.kind === 'move') {
    if (dry) {
      for (const svc of running) say(`  ${yellow('would')}  stop ${svc.unit}`);
      if (state?.activeState === 'active') say(`  ${yellow('would')}  stop ${unit.unit}`);
      say(`  ${yellow('would')}  move ${move.from} → ${move.to} (config, .env, data, logs, vosk)`);
      say(`  ${yellow('would')}  leave ${move.from} as a symlink to ${move.to}`);
      for (const link of move.relink) say(`  ${yellow('would')}  re-point ${link} at ${move.to}`);
    } else {
      for (const svc of running) {
        if ((await stopLegacyService(svc)) !== 0) {
          fail(`could not stop ${svc.unit} — not moving a home a running bridge is writing to.`);
          return 1;
        }
      }
      if (state?.activeState === 'active' && (await serviceCommand('stop')) !== 0) {
        fail(`could not stop ${unit.unit} — not moving a home a running bridge is writing to.`);
        return 1;
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
        linkDir(move.to, move.from);
        say(`  ${green('linked')}  ${move.from} → ${move.to} ${dim('(so old paths keep working)')}`);
      } catch (err) {
        note(`  ${yellow('note')}  could not leave a symlink at ${move.from} (${err instanceof Error ? err.message : String(err)}) — nothing needs it.`);
      }
      // These still resolve through move.from; point them straight at the home.
      for (const link of move.relink) {
        try {
          rmSync(link, { force: true });
          linkDir(move.to, link);
          say(`  ${green('linked')}  ${link} → ${move.to}`);
        } catch (err) {
          note(`  ${yellow('note')}  could not re-point ${link} (${err instanceof Error ? err.message : String(err)}) — it still reaches ${move.to} through ${move.from}.`);
        }
      }
    }
  } else if (move.kind === 'already') {
    say(`  ${green('ok')}  home already at ${move.to}`);
  } else {
    say(`  ${dim('skip')}  ${move.reason}`);
  }

  // Everything below resolves the home through SQUEAKY_HOME, so the service is
  // written for the new location even though the old name still resolves.
  if ((move.kind === 'move' || move.kind === 'already') && followsHome) {
    process.env['SQUEAKY_HOME'] = move.to;
  }

  // ── 3: the service ───────────────────────────────────────────────────────
  if (unit.scope === 'none' && !legacy.length) {
    say(`  ${dim('skip')}  no background service installed ${dim('(squeaky service install --now adds one)')}`);
  } else if (dry) {
    for (const svc of legacy) say(`  ${yellow('would')}  replace ${svc.unit} with ${unit.unit}`);
    say(`  ${yellow('would')}  write ${unit.unit} to run this install (${install.root}) and start it`);
  } else {
    // --force: an existing unit may differ (old launcher path, old home);
    // --now reloads it. Retires the Squeakr / AgentVoice service on the way.
    const written = await serviceInstallCommand({ force: true, now: true });
    if (written !== 0) {
      problems++;
      note(`  ${yellow('note')}  fix the above, then:  squeaky service install --force --now`);
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

  // ── 5: the old npm packages ──────────────────────────────────────────────
  if (!opts.keepOld) {
    problems += await removeLegacyPackages(install.root, dry);
  }

  say('');
  if (dry) {
    say(`  ${bold('Dry run done.')} Run it again without --dry-run to do it.`);
  } else if (problems) {
    say(`  ${yellow(bold('Upgraded, with notes above.'))} Your settings and data are in place either way.`);
  } else {
    say(`  ${green(bold('Upgraded to Squeaky.'))} Same token, same settings — the app keeps working as it was.`);
    note(dim('  Check it:  squeaky status'));
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

async function removeLegacyPackages(root: string, dry: boolean): Promise<number> {
  // Never uninstall the copy that is running this command.
  const self = legacyPackageAt(root);
  const listed = await capture('npm', ['ls', '-g', ...LEGACY_PACKAGE_NAMES, '--depth=0', '--json'], { timeoutMs: 60_000 });
  if (!ran(listed)) {
    say(`  ${dim('skip')}  npm not found — nothing to remove`);
    return 0;
  }
  let deps: Record<string, unknown> = {};
  try {
    deps = (JSON.parse(listed.stdout || '{}') as { dependencies?: Record<string, unknown> }).dependencies ?? {};
  } catch {
    /* unparseable — assume absent */
  }

  let problems = 0;
  for (const name of LEGACY_PACKAGE_NAMES) {
    if (name === self) {
      say(`  ${dim('skip')}  this command is running from ${name} itself — install squeaky-cli and run it from there`);
      continue;
    }
    if (!deps[name]) {
      say(`  ${green('ok')}  ${name} is not installed globally`);
      continue;
    }
    if (dry) {
      say(`  ${yellow('would')}  npm rm -g ${name}`);
      continue;
    }
    const code = await passthrough('npm', ['rm', '-g', name]);
    if (code !== 0) {
      fail(`npm rm -g ${name} failed — remove it by hand when convenient; Squeaky does not need it.`);
      problems++;
      continue;
    }
    say(`  ${green('removed')}  ${name}`);
  }
  return problems;
}

/** Distro package names and Pages URLs the project shipped under before, newest first. */
const LEGACY_SYSTEM_PACKAGES = ['squeakr', 'agentvoice'] as const;
const LEGACY_REPO_URLS = ['dixonsolutions.github.io/Squeakr', 'dixonsolutions.github.io/AgentVoice'] as const;

/**
 * The old .deb / .rpm still installed, or an apt / dnf source still on an
 * old URL — described for the message — or null when there is neither.
 */
async function legacySystemInstall(): Promise<string | null> {
  for (const pkg of LEGACY_SYSTEM_PACKAGES) {
    const deb = await capture('dpkg-query', ['-W', '-f=${Status}', pkg]);
    if (ran(deb) && deb.stdout.includes('install ok installed')) return `the ${pkg} system package is installed`;
    const rpm = await capture('rpm', ['-q', pkg]);
    if (ran(rpm) && rpm.code === 0) return `the ${pkg} system package is installed`;
  }
  for (const url of LEGACY_REPO_URLS) {
    const grep = await capture('grep', ['-rlsF', url, '/etc/apt/sources.list.d', '/etc/yum.repos.d']);
    if (ran(grep) && grep.stdout.trim() !== '') return `an apt / dnf source still points at ${url}`;
  }
  return null;
}
