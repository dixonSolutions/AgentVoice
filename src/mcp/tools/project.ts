/**
 * Project tools — agent_list_projects, agent_set_project, agent_manage_projects
 *
 * Own-bridge tools backed by the project registry (not the cursor-agent CLI).
 * These are the voice model's window into which codebases exist.
 *
 * Security: paths are NEVER returned to the phone/voice model on list/set.
 * agent_manage_projects add/update may return path to the admin agent only.
 */

import {
  listProjects,
  resolveProject,
  setActiveProject,
  type Project,
} from '../../state/registry.js';
import {
  PROJECTS_CATALOG_DESCRIPTION,
  addProject,
  filterProjects,
  listProjectsAdmin,
  removeProject,
  updateProject,
} from '../../state/projectsConfig.js';
import { readConfigFile } from '../../state/configFile.js';

// ── agent_list_projects ──────────────────────────────────────────────────

export interface ListProjectsArgs {
  query?: string;
}

export interface ProjectSummary {
  name: string;
  description: string | null;
  aliases: string[];
  enabled: boolean;
  active: boolean;
}

export interface ListProjectsResult {
  projects: ProjectSummary[];
}

/**
 * List all enabled projects from the registry.
 * Optional `query` filters by name, alias, or description (case-insensitive).
 * Marks the session's active project with `active: true`.
 */
export function handleListProjects(
  args: ListProjectsArgs,
  activeProject: string | null,
): ListProjectsResult {
  return listProjectSummaries(args, activeProject);
}

// ── agent_set_project ────────────────────────────────────────────────────

export interface SetProjectArgs {
  project: string;
}

export interface SetProjectResult {
  active_project: string;
  description: string | null;
  // path_hash omitted — we don't expose even hashes of paths
  aliases: string[];
}

/**
 * Set the sticky active project for a session.
 * Resolves the name/alias via the registry and rejects unknown/disabled projects.
 * Returns the canonical name and description so the model can read it back.
 *
 * Throws with a structured error if the project cannot be resolved.
 */
export function handleSetProject(
  args: SetProjectArgs,
  sessionKey: string,
): SetProjectResult {
  const resolved = resolveProject(args.project);

  if (!resolved) {
    const available = listProjects()
      .map((p) => {
        const aliasHint =
          p.aliases.length > 0 ? ` (say "${p.aliases[0]}" or "${p.name}")` : '';
        return `"${p.name}"${aliasHint}`;
      })
      .join(', ');
    throw new Error(
      `Project "${args.project}" not found. Available: ${available || 'none registered'}. ` +
        'Speech may mishear "cursor" as "casa" — try the exact name from the list.',
    );
  }

  setActiveProject(sessionKey, resolved.name);

  return {
    active_project: resolved.name,
    description: resolved.description,
    aliases: resolved.aliases,
  };
}

// ── Shared helper: resolve project or throw ───────────────────────────────

/**
 * Resolve project for any tool call that accepts an optional `project` arg.
 * Falls back to the session's active project if `projectArg` is omitted.
 * Throws a user-facing error if no project can be determined.
 */
export function resolveProjectOrThrow(
  projectArg: string | undefined,
  activeProject: string | null,
): Project {
  const input = projectArg ?? activeProject ?? null;

  if (!input) {
    throw new Error(
      'No active project. The user must select a project in the app dropdown before starting voice.',
    );
  }

  const resolved = resolveProject(input);
  if (!resolved) {
    const available = listProjects().map((p) => `"${p.name}"`).join(', ');
    throw new Error(
      `Project "${input}" not found or disabled. Available: ${available || 'none registered'}.`,
    );
  }

  return resolved;
}

// ── agent_manage_projects ────────────────────────────────────────────────

export type ManageProjectsAction = 'describe' | 'list' | 'add' | 'update' | 'remove';

export interface ManageProjectsArgs {
  action: ManageProjectsAction;
  query?: string;
  enabled?: boolean;
  name?: string;
  path?: string;
  description?: string;
  aliases?: string[];
}

export interface ManageProjectsResult {
  action: ManageProjectsAction;
  catalog?: string;
  projects?: Array<{
    name: string;
    description: string | null;
    aliases: string[];
    enabled: boolean;
    pathExists: boolean;
    path?: string;
  }>;
  project?: {
    name: string;
    description: string | null;
    aliases: string[];
    enabled: boolean;
    pathExists: boolean;
    path?: string;
  };
  removed?: string;
}

/**
 * Registry admin — describe the project model, list/filter, add, update, or remove entries.
 * Mutations write config.json and reconcile the SQLite registry.
 */
export function handleManageProjects(args: ManageProjectsArgs): ManageProjectsResult {
  switch (args.action) {
    case 'describe':
      return { action: 'describe', catalog: PROJECTS_CATALOG_DESCRIPTION };

    case 'list': {
      const admin = listProjectsAdmin({ query: args.query, enabled: args.enabled });
      return {
        action: 'list',
        projects: admin.map((p) => ({
          name: p.name,
          description: p.description,
          aliases: p.aliases,
          enabled: p.enabled,
          pathExists: p.pathExists,
        })),
      };
    }

    case 'add': {
      if (!args.name?.trim()) throw new Error('add requires name (lowercase slug).');
      if (!args.path?.trim()) throw new Error('add requires an absolute path.');
      const project = addProject({
        name: args.name.trim(),
        path: args.path.trim(),
        description: args.description,
        aliases: args.aliases,
        enabled: args.enabled,
      });
      return { action: 'add', project };
    }

    case 'update': {
      if (!args.name?.trim()) throw new Error('update requires name.');
      const project = updateProject({
        name: args.name.trim(),
        path: args.path?.trim(),
        description: args.description,
        aliases: args.aliases,
        enabled: args.enabled,
      });
      return { action: 'update', project };
    }

    case 'remove': {
      if (!args.name?.trim()) throw new Error('remove requires name.');
      const { name } = removeProject(args.name.trim());
      return { action: 'remove', removed: name };
    }

    default:
      throw new Error(`Unknown action "${String(args.action)}". Use describe, list, add, update, or remove.`);
  }
}

/** Public-safe project summaries for agent_list_projects (no paths). */
export function listProjectSummaries(
  args: ListProjectsArgs,
  activeProject: string | null,
): ListProjectsResult {
  const cfg = readConfigFile();
  const filtered = filterProjects(cfg.projects, { query: args.query, enabled: true });

  return {
    projects: filtered.map((p) => ({
      name: p.name,
      description: p.description ?? null,
      aliases: p.aliases,
      enabled: p.enabled,
      active: p.name === activeProject,
    })),
  };
}
