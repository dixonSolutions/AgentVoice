/**
 * Serve admin routes — manual self-hosting maintenance (no heartbeat / auto-update).
 *
 * Routes:
 *   GET  /api/admin/serve              — config + live status
 *   PATCH /api/admin/serve             — update serve settings (branch / repoDir)
 *   POST /api/admin/serve/action       — rebase, restart, or health
 *   GET  /api/admin/serve/events       — recent step log
 *   GET  /api/admin/serve/logs         — journalctl snapshot
 *   GET  /api/admin/serve/logs/stream  — live journalctl -f (SSE)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { readConfigFile, writeConfigFile } from '../state/configFile.js';
import { listServeEvents } from '../state/serveEvents.js';
import {
  followServeServiceLogs,
  getServeServiceLogs,
  getServeStatus,
  refreshGitSnapshot,
  runServeAction,
  type ServeActionId,
} from '../serve/index.js';
import { getRunModeInfo } from '../runMode.js';
import { childLogger } from '../log.js';

const log = childLogger('serveRoutes');

const LEGACY_AUTO_KEYS = [
  'enabled',
  'intervalMs',
  'autoPull',
  'autoInstallDeps',
  'autoBuild',
  'autoRestart',
  'abortOnLocalChanges',
] as const;

const ServePatchSchema = z
  .object({
    branch: z.string().min(1).max(128).optional().or(z.literal('')),
    repoDir: z.string().min(1).optional().or(z.literal('')),
  })
  .strict();

const ServeActionSchema = z
  .object({
    action: z.enum(['pull', 'restart', 'health']),
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

function stripLegacyAutoKeys(serve: Record<string, unknown>): void {
  for (const key of LEGACY_AUTO_KEYS) {
    delete serve[key];
  }
}

function writeSse(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseHeaders(req: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };

  const { settings } = getConfig();
  const run = getRunModeInfo(settings);
  if (run.useDevWebServer) {
    const origin = req.headers.origin;
    const devOrigins = new Set([
      run.webUrl,
      `http://127.0.0.1:${run.webPort}`,
      `http://localhost:${run.webPort}`,
    ]);
    if (origin && devOrigins.has(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
  }

  return headers;
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

    const hasBranch = Object.prototype.hasOwnProperty.call(parsed.data, 'branch');
    const hasRepoDir = Object.prototype.hasOwnProperty.call(parsed.data, 'repoDir');
    const branch = parsed.data.branch?.trim() || undefined;
    const repoDir = parsed.data.repoDir?.trim() || undefined;

    const cfg = readConfigFile();
    cfg.settings.serve = applyDeepPatch(
      cfg.settings.serve,
      {
        ...(hasBranch && branch ? { branch } : {}),
        ...(hasRepoDir && repoDir ? { repoDir } : {}),
      },
    );
    stripLegacyAutoKeys(cfg.settings.serve as Record<string, unknown>);
    // Empty field means "follow origin's default branch" / cwd — persist the clear.
    if (hasBranch && !branch) {
      delete (cfg.settings.serve as { branch?: string }).branch;
    }
    if (hasRepoDir && !repoDir) {
      delete (cfg.settings.serve as { repoDir?: string }).repoDir;
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

  app.get<{ Querystring: { lines?: string } }>(
    '/api/admin/serve/logs/stream',
    async (req, reply) => {
      const lines = Math.min(Number(req.query.lines) || 80, 200);
      reply.hijack();
      req.raw.setTimeout(0);
      reply.raw.setTimeout(0);
      reply.raw.writeHead(200, sseHeaders(req));

      let closed = false;
      let follow: { stop: () => void; unit: string } | null = null;
      const keepalive: { id?: ReturnType<typeof setInterval> } = {};

      const finish = (endPayload?: { code: number | null }): void => {
        if (closed) return;
        closed = true;
        if (keepalive.id) clearInterval(keepalive.id);
        follow?.stop();
        follow = null;
        try {
          if (endPayload) writeSse(reply, 'end', endPayload);
          reply.raw.end();
        } catch {
          // already closed
        }
      };

      keepalive.id = setInterval(() => {
        if (closed) {
          if (keepalive.id) clearInterval(keepalive.id);
          return;
        }
        try {
          reply.raw.write(': keepalive\n\n');
        } catch {
          finish();
        }
      }, 15000);

      req.raw.on('close', () => finish());
      req.raw.on('error', () => finish());

      try {
        follow = await followServeServiceLogs({
          lines,
          onLine: (line) => {
            if (closed) return;
            writeSse(reply, 'log', { line });
          },
          onError: (detail) => {
            if (closed) return;
            writeSse(reply, 'error', { detail });
          },
          onClose: (code) => finish({ code }),
        });
        if (!closed) {
          writeSse(reply, 'meta', { unit: follow.unit, live: true });
        } else {
          follow.stop();
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (!closed) {
          writeSse(reply, 'error', { detail });
        }
        finish({ code: 1 });
      }
    },
  );
}
