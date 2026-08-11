/**
 * Project registry CRUD — shared by admin API and MCP manage tool.
 *
 * Projects are allowlisted codebases AgentVoice may open via cursor-agent.
 * config.json is authoritative; reconcileRegistry() syncs to SQLite.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ProjectConfig } from '../config.js';
import { readConfigFile, writeConfigFile } from './configFile.js';
import { reconcileRegistry } from './registry.js';

const SLUG_RE = /^[a-z0-9_-]+$/;

export const PROJECTS_CATALOG_DESCRIPTION =
  'AgentVoice projects are allowlisted codebases the bridge may open as cursor-agent workspaces. ' +
  'Each entry has a slug name, spoken aliases for STT, and an absolute path on the host. ' +
  'The user selects the active project in the PWA dropdown before voice; the model may list or switch projects via tools. ' +
  'Paths are never sent to the phone — only names, aliases, and descriptions.';

export interface ProjectListFilters {
  query?: string;
  enabled?: boolean;
}

export interface ProjectAdminView {
  name: string;
  path: string;
  description: string | null;
  aliases: string[];
  enabled: boolean;
  pathExists: boolean;
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

export function filterProjects(projects: ProjectConfig[], filters: ProjectListFilters = {}): ProjectConfig[] {
  let list = [...projects];
  if (filters.enabled !== undefined) {
    list = list.filter((p) => p.enabled === filters.enabled);
  }
  if (filters.query) {
    const q = normalizeQuery(filters.query);
    list = list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description?.toLowerCase().includes(q) ?? false) ||
        p.aliases.some((a) => a.toLowerCase().includes(q)),
    );
  }
  return list;
}

export function listProjectsAdmin(filters: ProjectListFilters = {}): ProjectAdminView[] {
  const cfg = readConfigFile();
  return filterProjects(cfg.projects, filters).map((p) => ({
    name: p.name,
    path: p.path,
    description: p.description ?? null,
    aliases: p.aliases,
    enabled: p.enabled,
    pathExists: existsSync(p.path),
  }));
}

export function assertValidSlug(name: string): void {
  if (!SLUG_RE.test(name)) {
    throw new Error('Project name must be a lowercase slug (a-z, 0-9, _, -).');
  }
}

/** Require an absolute filesystem path (any location the host can open). */
export function assertValidProjectPath(path: string): void {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error('Project path is required.');
  }
  if (!isAbsolute(trimmed)) {
    throw new Error('Project path must be absolute.');
  }
}

export interface AddProjectInput {
  name: string;
  path: string;
  description?: string;
  aliases?: string[];
  enabled?: boolean;
}

export function addProject(input: AddProjectInput): ProjectAdminView {
  assertValidSlug(input.name);
  assertValidProjectPath(input.path);

  const cfg = readConfigFile();
  if (cfg.projects.some((p) => p.name === input.name)) {
    throw new Error(`Project "${input.name}" already exists.`);
  }

  const entry: ProjectConfig = {
    name: input.name,
    path: resolve(input.path),
    description: input.description,
    aliases: input.aliases ?? [],
    enabled: input.enabled ?? true,
  };

  cfg.projects.push(entry);
  writeConfigFile(cfg);
  reconcileRegistry();

  return {
    name: entry.name,
    path: entry.path,
    description: entry.description ?? null,
    aliases: entry.aliases,
    enabled: entry.enabled,
    pathExists: existsSync(entry.path),
  };
}

export interface UpdateProjectInput {
  name: string;
  path?: string;
  description?: string | null;
  aliases?: string[];
  enabled?: boolean;
}

export function updateProject(input: UpdateProjectInput): ProjectAdminView {
  const cfg = readConfigFile();
  const idx = cfg.projects.findIndex((p) => p.name === input.name);
  if (idx === -1) {
    throw new Error(`Project "${input.name}" not found.`);
  }

  const existing = cfg.projects[idx]!;
  if (input.path !== undefined) {
    assertValidProjectPath(input.path);
  }

  const updated: ProjectConfig = {
    name: existing.name,
    path: input.path !== undefined ? resolve(input.path) : existing.path,
    description:
      input.description !== undefined ? (input.description ?? undefined) : existing.description,
    aliases: input.aliases ?? existing.aliases,
    enabled: input.enabled ?? existing.enabled,
  };

  cfg.projects[idx] = updated;
  writeConfigFile(cfg);
  reconcileRegistry();

  return {
    name: updated.name,
    path: updated.path,
    description: updated.description ?? null,
    aliases: updated.aliases,
    enabled: updated.enabled,
    pathExists: existsSync(updated.path),
  };
}

export function removeProject(name: string): { name: string } {
  const cfg = readConfigFile();
  const idx = cfg.projects.findIndex((p) => p.name === name);
  if (idx === -1) {
    throw new Error(`Project "${name}" not found.`);
  }
  if (cfg.projects.length === 1) {
    throw new Error('Cannot remove the last project — config requires at least one.');
  }

  cfg.projects.splice(idx, 1);
  writeConfigFile(cfg);
  reconcileRegistry();

  return { name };
}
