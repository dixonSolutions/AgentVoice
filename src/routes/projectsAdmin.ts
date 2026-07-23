/**
 * Project admin routes — full CRUD for the projects registry.
 *
 * These routes expose paths and full project details to authenticated admin
 * clients (the config tab). Paths are intentionally hidden from the regular
 * GET /api/projects endpoint used by the voice layer.
 *
 * Routes:
 *   GET    /api/admin/projects            — list all projects with paths
 *   POST   /api/admin/projects            — add project
 *   PATCH  /api/admin/projects/:name      — update project
 *   DELETE /api/admin/projects/:name      — soft-delete (disable) project
 *   POST   /api/admin/projects/:name/ping — check if path exists on disk
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { getConfig } from '../config.js';
import { addProject, removeProject, updateProject } from '../state/projectsConfig.js';
import { readConfigFile } from '../state/configFile.js';
import { getDb } from '../state/db.js';
import { childLogger } from '../log.js';

const log = childLogger('projectsAdmin');

// ── Validation schemas ─────────────────────────────────────────────────────

const ProjectNameParam = z.object({ name: z.string().regex(/^[a-z0-9_-]+$/) });

const ProjectCreateSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9_-]+$/, 'Name must be lowercase slug (a-z0-9_-)'),
    path: z.string().min(1, 'Path is required'),
    description: z.string().max(200).optional(),
    aliases: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

const ProjectUpdateSchema = z
  .object({
    path: z.string().min(1).optional(),
    description: z.string().max(200).nullable().optional(),
    aliases: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

// ── Route registration ─────────────────────────────────────────────────────

export async function registerProjectsAdminRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/admin/projects — full project list including paths
  // config.json is source of truth; registry supplies resume_id / model only.
  // Soft-disabled DB orphans (removed from config) must not reappear in the UI.
  app.get('/api/admin/projects', async () => {
    const cfg = getConfig();
    const db = getDb();

    const rows = db
      .prepare('SELECT name, resume_id, model, updated_at FROM project')
      .all() as Array<{
        name: string;
        resume_id: string | null;
        model: string | null;
        updated_at: string;
      }>;
    const registryByName = new Map(rows.map((r) => [r.name, r]));

    const projects = cfg.projects
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => {
        const reg = registryByName.get(p.name);
        return {
          name: p.name,
          path: p.path,
          description: p.description ?? null,
          aliases: p.aliases,
          enabled: p.enabled,
          resumeId: reg?.resume_id ?? null,
          model: reg?.model ?? null,
          pathExists: existsSync(p.path),
          updatedAt: reg?.updated_at ?? new Date().toISOString(),
        };
      });

    return { projects };
  });

  // POST /api/admin/projects — add new project
  app.post<{ Body: unknown }>('/api/admin/projects', async (req, reply) => {
    const parsed = ProjectCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const { name, path, description, aliases, enabled } = parsed.data;

    try {
      const project = addProject({ name, path, description, aliases, enabled });
      log.info({ name, path }, 'project added via admin API');
      return { ok: true, project };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('already exists')) {
        return reply.code(409).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
  });

  // PATCH /api/admin/projects/:name — update project
  app.patch<{ Params: unknown; Body: unknown }>('/api/admin/projects/:name', async (req, reply) => {
    const paramsParsed = ProjectNameParam.safeParse(req.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: 'Invalid project name' });
    }
    const { name } = paramsParsed.data;

    const bodyParsed = ProjectUpdateSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: bodyParsed.error.message });
    }

    const cfg = readConfigFile();
    const idx = cfg.projects.findIndex((p) => p.name === name);
    if (idx === -1) {
      return reply.code(404).send({ error: `Project "${name}" not found` });
    }

    const patch = bodyParsed.data;

    try {
      const project = updateProject({
        name,
        path: patch.path,
        description: patch.description,
        aliases: patch.aliases,
        enabled: patch.enabled,
      });
      log.info({ name }, 'project updated via admin API');
      return { ok: true, project };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  // DELETE /api/admin/projects/:name — soft-delete (disable + remove from config)
  app.delete<{ Params: unknown }>('/api/admin/projects/:name', async (req, reply) => {
    const paramsParsed = ProjectNameParam.safeParse(req.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: 'Invalid project name' });
    }
    const { name } = paramsParsed.data;

    try {
      const removed = removeProject(name);
      log.info({ name }, 'project removed via admin API');
      return { ok: true, ...removed };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.includes('last project') ? 400 : 404;
      return reply.code(code).send({ error: message });
    }
  });

  // POST /api/admin/projects/:name/ping — check if project path exists
  app.post<{ Params: unknown }>('/api/admin/projects/:name/ping', async (req, reply) => {
    const paramsParsed = ProjectNameParam.safeParse(req.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: 'Invalid project name' });
    }
    const { name } = paramsParsed.data;

    const cfg = getConfig();
    const project = cfg.projects.find((p) => p.name === name);
    if (!project) {
      return reply.code(404).send({ error: `Project "${name}" not found` });
    }

    return { name, path: project.path, exists: existsSync(project.path) };
  });
}
