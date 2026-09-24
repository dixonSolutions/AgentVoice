/**
 * `agentvoice add` — register a directory as a project.
 *
 *   cd ~/code/my-app && agentvoice add --this-dir
 *   agentvoice add ~/code/my-app
 *
 * The entry is filled in from the directory itself (see ../projectDetails.ts):
 * a slug name, a description from the manifest or README, and spoken aliases
 * for speech-to-text. Any of them can be overridden.
 *
 * When the bridge is running the project goes in through its admin API, so it
 * is live at once — no restart, and the registry and config.json stay in step.
 * When it is not, config.json is edited directly and the next boot picks it up.
 *
 * Registering a directory discovery already found upgrades that entry's
 * details rather than adding a duplicate; re-running `add` on a registered
 * directory reports it and changes nothing unless --force.
 */

import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bridgeApi, findBridge } from '../bridge.js';
import { readConfig, resolveHome, seedConfig } from '../home.js';
import { bold, dim, fail, green, note, say, yellow } from '../out.js';
import { clampDescription, detectProjectDetails, slugify, type ProjectDetails } from '../projectDetails.js';

export interface AddOptions {
  dir: string;
  name?: string;
  description?: string;
  aliases?: string[];
  dryRun?: boolean;
  /** Overwrite an existing entry's description and aliases. */
  force?: boolean;
}

interface ProjectEntry {
  name: string;
  path: string;
  description?: string | null;
  aliases?: string[];
  enabled?: boolean;
  discovered?: boolean;
}

/** Same directory, even if config.json spells it through a symlink or with a trailing slash. */
function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

/** Apply the user's overrides on top of what was detected. */
export function resolveEntry(details: ProjectDetails, opts: AddOptions): ProjectDetails {
  const aliases = [...new Set([...(opts.aliases ?? []), ...details.aliases].map((a) => a.trim().toLowerCase()))].filter(
    Boolean,
  );
  return {
    ...details,
    name: opts.name ? slugify(opts.name) : details.name,
    description: opts.description !== undefined ? clampDescription(opts.description) || null : details.description,
    aliases,
  };
}

/** `name`, or `name-2`, `name-3`… — the first not used by a *different* path. */
export function freeName(name: string, taken: ProjectEntry[], path: string): string {
  const used = new Set(taken.filter((p) => !samePath(p.path, path)).map((p) => p.name));
  let candidate = name;
  for (let i = 2; used.has(candidate); i++) candidate = `${name}-${i}`;
  return candidate;
}

function describe(entry: ProjectDetails, header: string): void {
  say('');
  say(`  ${bold(header)}`);
  say(`  ${dim('name       ')} ${entry.name} ${dim(`(${entry.sources.name})`)}`);
  say(`  ${dim('path       ')} ${entry.path}`);
  say(
    `  ${dim('description')} ${entry.description ?? dim('none found — pass --description')}${entry.sources.description ? ` ${dim(`(${entry.sources.description})`)}` : ''}`,
  );
  say(`  ${dim('aliases    ')} ${entry.aliases.length ? entry.aliases.join(', ') : dim('none')}`);
  if (!entry.git) say(`  ${yellow('note')}        not a git repository root — agents work best in one`);
  say('');
}

export async function addCommand(opts: AddOptions): Promise<number> {
  if (!existsSync(opts.dir)) {
    fail(`${opts.dir} does not exist.`);
    return 1;
  }
  const detected = await detectProjectDetails(opts.dir);
  let entry = resolveEntry(detected, opts);

  const home = resolveHome();
  const cfg = readConfig(home);
  if (cfg.error) {
    fail(`${cfg.path} is not valid JSON — ${cfg.error}. Fix it first; nothing was changed.`);
    return 1;
  }
  const projects = (cfg.config?.projects ?? []) as ProjectEntry[];
  const existing = projects.find((p) => samePath(p.path, entry.path));
  if (!existing) entry = { ...entry, name: freeName(entry.name, projects, entry.path) };

  if (existing && !existing.discovered && !opts.force) {
    describe({ ...entry, name: existing.name }, `Already registered as "${existing.name}"`);
    note(dim('  Re-run with --force to replace its description and aliases with the above.'));
    return 0;
  }

  const verb = existing ? (existing.discovered ? 'Adopting the discovered entry' : 'Updating') : 'Registering';
  describe(existing ? { ...entry, name: existing.name } : entry, `${verb}${opts.dryRun ? ' (dry run — nothing written)' : ''}`);
  if (opts.dryRun) return 0;

  const bridge = await findBridge(home, cfg);
  const endpoint = bridge.answering?.endpoint;

  if (endpoint) {
    const result = existing
      ? await bridgeApi(home, endpoint, `/api/admin/projects/${encodeURIComponent(existing.name)}`, 15_000, {
          method: 'PATCH',
          body: { description: entry.description, aliases: entry.aliases, enabled: true },
        })
      : await bridgeApi(home, endpoint, '/api/admin/projects', 15_000, {
          method: 'POST',
          body: {
            name: entry.name,
            path: entry.path,
            ...(entry.description ? { description: entry.description } : {}),
            aliases: entry.aliases,
          },
        });
    if (!result.ok) {
      fail(`the running bridge refused it — ${result.error}`);
      return 1;
    }
    say(`  ${green('added')}  live on the running bridge ${dim(`(${endpoint.url})`)} — pick it in the app's project list`);
    return 0;
  }

  // Bridge down: edit config.json; the next boot reconciles the registry.
  if (!cfg.exists) seedConfig(home);
  const fresh = readConfig(home);
  if (!fresh.config) {
    fail(`could not read ${fresh.path}${fresh.error ? ` — ${fresh.error}` : ''}`);
    return 1;
  }
  const list = (fresh.config.projects ?? []) as ProjectEntry[];
  const index = list.findIndex((p) => samePath(p.path, entry.path));
  const record: ProjectEntry = {
    ...(index >= 0 ? list[index] : {}),
    name: index >= 0 ? list[index]!.name : entry.name,
    path: entry.path,
    ...(entry.description ? { description: entry.description } : {}),
    aliases: entry.aliases,
    enabled: true,
    // Hand-registered now: discovery will leave it alone, even if the folder
    // later moves out of a hot path.
    discovered: false,
  };
  if (index >= 0) list[index] = record;
  else list.push(record);
  fresh.config.projects = list as unknown[];
  writeFileSync(fresh.path, `${JSON.stringify(fresh.config, null, 2)}\n`);

  say(`  ${green('added')}  to ${fresh.path}`);
  note(dim('  The bridge is not running — it is picked up on the next start (agentvoice start / run).'));
  return 0;
}
