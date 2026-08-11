/**
 * Serve admin routes — manual self-hosting maintenance (no auto-update).
 *
 * Routes:
 *   GET  /api/admin/serve         — config + live status
 *   PATCH /api/admin/serve        — update serve settings (branch / repoDir)
 *   POST /api/admin/serve/run     — full update: rebase → deps → build → restart
 *   POST /api/admin/serve/action  — single action (pull=rebase, deps, build, restart, health)
 *   GET  /api/admin/serve/events  — recent step log
 *   GET  /api/admin/serve/logs    — journalctl for agentvoice.service
 *   POST /api/admin/serve/install — spawn install-systemd.sh
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { readConfigFile, writeConfigFile } from '../state/configFile.js';
import { listServeEvents } from '../state/serveEvents.js';
import {
  getServeServiceLogs,
  getServeStatus,
  refreshGitSnapshot,
  runServe,
  runServeAction,
  spawnInstallSystemd,
  type ServeActionId,
} from '../serve/index.js';
import { childLogger } from '../log.js';

const log = childLogger('serveRoutes');

const ServePatchSchema = z
  .object({
    branch: z.string().min(1).max(128).optional().or(z.literal('')),
    repoDir: z.string().min(1).optional().or(z.literal('')),
  })
  .strict();

const ServeActionSchema = z
  .object({
    action: z.enum(['pull', 'deps', 'build', 'restart', 'health']),
  })
  .strict();

function applyDeepPatch<T extends object>(target: T, patch: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const patchVal = patch[key];
    if (patchVal !== undefined) {
      result[key] = patchVal as T[keyof T];
    }
  }
  return result;
}

export async function registerServeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/serve', async () => {
    const { serve } = getConfig().settings;
    let status = getServeStatus();
    if (!status.git) {
      try {
        await refreshGitSnapshot();
        status = getServeStatus();
      } catch {
        // git snapshot optional on read
      }
    }
    return { serve, status };
  });

  app.patch<{ Body: unknown }>('/api/admin/serve', async (req, reply) => {
    const parsed = ServePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }

    const patch = { ...parsed.data };
    if (patch.branch === '') patch.branch = undefined;
    if (patch.repoDir === '') patch.repoDir = undefined;

    const cfg = readConfigFile();
    cfg.settings.serve = applyDeepPatch(
      cfg.settings.serve,
      patch as Partial<typeof cfg.settings.serve>,
    );
    // Drop legacy auto-update keys if still present in the on-disk object.
    const serve = cfg.settings.serve as Record<string, unknown>;
    for (const key of [
      'enabled',
      'intervalMs',
      'autoPull',
      'autoInstallDeps',
      'autoBuild',
      'autoRestart',
      'abortOnLocalChanges',
    ]) {
      delete serve[key];
    }
    writeConfigFile(cfg);
    log.info('serve settings updated');

    try {
      await refreshGitSnapshot();
    } catch {
      // non-fatal
    }

    return {
      ok: true,
      serve: getConfig().settings.serve,
      status: getServeStatus(),
    };
  });

  app.post('/api/admin/serve/run', async (_req, reply) => {
    const status = getServeStatus();
    if (status.running) {
      return reply.code(409).send({ error: 'Serve is already running' });
    }

    const runId = randomUUID();
    void runServe()
      .then((result) => {
        log.info({ runId: result.runId, outcome: result.outcome }, 'manual serve finished');
      })
      .catch((err) => {
        log.error({ err, runId }, 'manual serve failed');
      });

    return { ok: true, started: true, runId };
  });

  app.post<{ Body: unknown }>('/api/admin/serve/action', async (req, reply) => {
    const parsed = ServeActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }

    const status = getServeStatus();
    if (status.running) {
      return reply.code(409).send({ error: 'Serve is already running' });
    }

    const action = parsed.data.action as ServeActionId;
    try {
      const result = await runServeAction(action);
      return {
        ok: true,
        outcome: result.outcome,
        detail: result.detail,
        runId: result.runId,
        status: getServeStatus(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: message });
    }
  });

  app.get<{ Querystring: { limit?: string } }>(
    '/api/admin/serve/events',
    async (req) => {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      return { entries: listServeEvents(limit) };
    },
  );

  app.get<{ Querystring: { lines?: string } }>(
    '/api/admin/serve/logs',
    async (req) => {
      const lines = Math.min(Number(req.query.lines) || 80, 500);
      return getServeServiceLogs(lines);
    },
  );

  app.post('/api/admin/serve/install', async () => {
    const repoDir = getConfig().settings.serve.repoDir?.trim() || process.cwd();
    const result = spawnInstallSystemd(repoDir);
    return { ok: result.ok, detail: result.detail };
  });
}
