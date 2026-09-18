/**
 * In-process project discovery.
 *
 * A configured hot path is a container, not a project. Every immediate
 * subdirectory that is a Git worktree becomes a discovered allowlist entry.
 * Nested containers are made explicit by listing them as another hot path;
 * this prevents a parent container from accidentally becoming a workspace.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  watch,
  type Dirent,
  type FSWatcher,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { getConfig, type ProjectConfig, type ProjectDiscoverySettings } from '../config.js';
import { childLogger } from '../log.js';
import { readConfigFile, writeConfigFile } from './configFile.js';
import { reconcileRegistry } from './registry.js';

const log = childLogger('projectDiscovery');

export interface DiscoveredPath {
  path: string;
  hotPath: string;
}

export interface DiscoverySyncResult {
  changed: boolean;
  discovered: number;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith(`~${sep}`) || path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(path);
}

/** Resolve and deduplicate configured hot paths, preserving their config order. */
export function resolveHotPaths(settings: ProjectDiscoverySettings): string[] {
  const paths: string[] = [];
  for (const configured of settings.hotPaths) {
    const expanded = expandHome(configured);
    let path = expanded;
    try {
      path = realpathSync(expanded);
    } catch {
      // Keep a missing hot path so the watcher can be configured after it appears
      // on a later restart. Discovery simply ignores it for now.
    }
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

function isWithin(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function isExcluded(path: string, excludes: string[]): boolean {
  return excludes.some((entry) => {
    if (!entry.includes('/') && !entry.includes('\\')) return basename(path) === entry;
    return resolveHotPath(entry) === path;
  });
}

function resolveHotPath(path: string): string {
  const expanded = expandHome(path);
  try {
    return realpathSync(expanded);
  } catch {
    return expanded;
  }
}

function isGitWorktree(path: string): boolean {
  return existsSync(resolve(path, '.git'));
}

/**
 * Find direct project folders under every hot path. This deliberately does not
 * recurse: adding a nested hot path is the explicit, reviewable opt-in.
 */
export function discoverProjectPaths(settings: ProjectDiscoverySettings): DiscoveredPath[] {
  if (!settings.enabled) return [];

  const hotPaths = resolveHotPaths(settings);
  const found = new Map<string, DiscoveredPath>();

  for (const hotPath of hotPaths) {
    let entries: Dirent[];
    try {
      entries = readdirSync(hotPath, { withFileTypes: true });
    } catch (err) {
      log.warn({ hotPath, err }, 'could not scan project-discovery hot path');
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || !entry.isDirectory() || entry.isSymbolicLink()) continue;

      const candidate = resolve(hotPath, entry.name);
      // A nested hot path (or one of its parents) is a container, never a project.
      if (hotPaths.some((nested) => isWithin(nested, candidate))) continue;
      if (isExcluded(candidate, settings.exclude)) continue;

      try {
        if (lstatSync(candidate).isSymbolicLink()) continue;
      } catch {
        continue;
      }

      if (settings.requireGit && !isGitWorktree(candidate)) continue;
      found.set(candidate, { path: candidate, hotPath });
    }
  }

  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

function automaticAliases(folderName: string): string[] {
  const spoken = folderName.replace(/[-_]+/g, ' ').trim();
  return spoken && spoken.toLowerCase() !== folderName.toLowerCase() ? [spoken] : [];
}

function nextName(folderName: string, used: Set<string>): string {
  const base = slugify(folderName);
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base}-${suffix++}`;
  used.add(name);
  return name;
}

/**
 * Update only entries previously created by discovery. Hand-authored projects
 * remain authoritative, even if their path also appears under a hot path.
 */
export function synchronizeProjectDiscovery(): DiscoverySyncResult {
  const config = readConfigFile();
  const settings = config.settings.projectDiscovery;
  if (!settings.enabled) return { changed: false, discovered: 0 };

  const wanted = discoverProjectPaths(settings);
  const manualPaths = new Set(
    config.projects.filter((project) => !project.discovered).map((project) => resolve(project.path)),
  );
  const priorByPath = new Map(
    config.projects.filter((project) => project.discovered).map((project) => [resolve(project.path), project]),
  );
  const usedNames = new Set(config.projects.filter((project) => !project.discovered).map((project) => project.name));
  const nextDiscovered: ProjectConfig[] = [];

  for (const item of wanted) {
    if (manualPaths.has(item.path)) continue;

    const prior = priorByPath.get(item.path);
    const name = prior && !usedNames.has(prior.name) ? prior.name : nextName(basename(item.path), usedNames);
    usedNames.add(name);
    nextDiscovered.push({
      ...(prior ?? {
        aliases: automaticAliases(basename(item.path)),
        description: `Discovered from ${item.hotPath}`,
        enabled: true,
        allowExternalSessions: false,
        externalMailbox: false,
      }),
      name,
      path: item.path,
      discovered: true,
    });
  }

  const nextProjects = [...config.projects.filter((project) => !project.discovered), ...nextDiscovered];
  const changed = JSON.stringify(config.projects) !== JSON.stringify(nextProjects);
  if (changed) {
    config.projects = nextProjects;
    writeConfigFile(config);
    log.info({ discovered: nextDiscovered.length }, 'project discovery reconciled configuration');
  }

  return { changed, discovered: nextDiscovered.length };
}

let activeStop: (() => void) | null = null;

/** Start process-local directory watching after the database is ready. */
export function startProjectDiscovery(): () => void {
  activeStop?.();

  const settings = getConfig().settings.projectDiscovery;
  if (!settings.enabled || !settings.watch) return () => {};

  const watchers: FSWatcher[] = [];
  let debounce: NodeJS.Timeout | undefined;
  const reconcile = () => {
    try {
      synchronizeProjectDiscovery();
      reconcileRegistry();
    } catch (err) {
      log.error({ err }, 'project discovery reconciliation failed');
    }
  };
  const schedule = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(reconcile, 250);
    debounce.unref();
  };

  for (const hotPath of resolveHotPaths(settings)) {
    try {
      watchers.push(watch(hotPath, { persistent: false }, schedule));
    } catch (err) {
      log.warn({ hotPath, err }, 'could not watch project-discovery hot path');
    }
  }

  const interval = setInterval(reconcile, settings.rescanIntervalMs);
  interval.unref();
  activeStop = () => {
    if (debounce) clearTimeout(debounce);
    clearInterval(interval);
    for (const watcher of watchers) watcher.close();
    activeStop = null;
  };
  return activeStop;
}
