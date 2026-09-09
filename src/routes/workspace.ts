/**
 * Workspace-as-project — lets an IDE make its open folder the active project
 * without editing config.json first.
 *
 *   POST /api/workspace/project { path, name?, description?, activate? }
 *   GET  /api/workspace/project?path=…
 *
 * A folder that already matches an enabled project's path reuses that project.
 * Otherwise an *ephemeral* registry row is inserted (DB only, enabled): it
 * behaves like any project for the voice agent, jobs, resume ids and history,
 * but it is not written to config.json, so `reconcileRegistry()` disables it
 * on the next bridge restart — the extension simply re-registers on connect.
 *
 * Security: this does not widen the trust model. The admin API
 * (`POST /api/admin/projects`) already lets any token holder allowlist any
 * host path; this route just skips the config write.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { getDb } from '../state/db.js';
import { getProjectByName, getSessionState, setActiveProject, type Project } from '../state/registry.js';
import { childLogger } from '../log.js';

const log = childLogger('routes:workspace');

const Body = z.object({
  path: z.string().min(1),
  name: z.string().regex(/^[a-z0-9_-]+$/).optional(),
  description: z.string().max(200).optional(),
  activate: z.boolean().optional(),
});

function normalizePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!isAbsolute(trimmed) || !existsSync(trimmed)) return null;
  try {
    const real = realpathSync(trimmed);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function slugify(input: string): string {
  const slug = input.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'workspace';
}

/** Enabled project whose path is this folder (exact, after realpath), if any. */
function findEnabledByPath(path: string): Project | null {
  const rows = getDb()
    .prepare('SELECT name, path FROM project WHERE enabled = 1')
    .all() as Array<{ name: string; path: string }>;
  for (const row of rows) {
    let rowPath = row.path;
    try {
      rowPath = realpathSync(row.path);
    } catch {
      // keep the raw path — compare as stored
    }
    if (rowPath === path) return getProjectByName(row.name);
  }
  return null;
}

function uniqueName(base: string, path: string): string {
  let candidate = base;
  for (let i = 2; i < 100; i += 1) {
    const existing = getProjectByName(candidate);
    if (!existing) return candidate;
    // Same name, same folder (disabled leftover from a previous run) → reuse the row.
    if (existing.path === path) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

export interface WorkspaceProjectView {
  name: string;
  path: string;
  description: string | null;
  /** True when the project lives only in the registry (not config.json). */
  ephemeral: boolean;
}

function isInConfig(name: string): boolean {
  // Ephemeral rows carry the marker description; config-backed rows never do.
  const row = getDb().prepare('SELECT description FROM project WHERE name = ?').get(name) as
    | { description: string | null }
    | undefined;
  return !(row?.description ?? '').startsWith(EPHEMERAL_PREFIX);
}

const EPHEMERAL_PREFIX = 'Workspace: ';

export function registerWorkspaceRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string } }>('/api/workspace/project', async (req, reply) => {
    const path = normalizePath(req.query.path ?? '');
    if (!path) return reply.code(400).send({ error: 'path must be an absolute directory that exists on the bridge host' });
    const project = findEnabledByPath(path);
    const session = getSessionState('default');
    if (!project) return { project: null, activeProject: session.activeProject };
    const view: WorkspaceProjectView = {
      name: project.name,
      path: project.path,
      description: project.description,
      ephemeral: !isInConfig(project.name),
    };
    return { project: view, activeProject: session.activeProject };
  });

  app.post<{ Body: unknown }>('/api/workspace/project', async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const path = normalizePath(parsed.data.path);
    if (!path) {
      return reply.code(400).send({
        error: 'path must be an absolute directory that exists on the bridge host (remote workspaces are not supported — see docs/32)',
      });
    }

    let project = findEnabledByPath(path);
    let created = false;
    if (!project) {
      const name = uniqueName(parsed.data.name ?? slugify(basename(path)), path);
      const description = parsed.data.description ?? `${EPHEMERAL_PREFIX}${path}`;
      getDb()
        .prepare(
          `INSERT INTO project (name, path, aliases, description, enabled, updated_at)
           VALUES (@name, @path, '[]', @description, 1, datetime('now'))
           ON CONFLICT(name) DO UPDATE SET
             path = excluded.path, description = excluded.description,
             enabled = 1, updated_at = excluded.updated_at`,
        )
        .run({ name, path, description });
      project = getProjectByName(name);
      created = true;
      log.info({ name, path }, 'ephemeral workspace project registered');
    }
    if (!project) return reply.code(500).send({ error: 'Failed to register workspace project' });

    if (parsed.data.activate !== false) {
      setActiveProject('default', project.name);
    }
    const session = getSessionState('default');
    const view: WorkspaceProjectView = {
      name: project.name,
      path: project.path,
      description: project.description,
      ephemeral: !isInConfig(project.name),
    };
    return { ok: true, created, project: view, activeProject: session.activeProject };
  });
}
