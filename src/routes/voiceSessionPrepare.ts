/**
 * Voice session preparation — streams live setup logs (SSE).
 *
 * POST /api/voice-session/prepare
 *   Body: { project: string }
 *   Response: text/event-stream
 *     event: session_log  — incremental live voice session logs
 *     event: complete      — final result { ok, ... }
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ensureClientMcpSetup,
  cleanupLegacyProjectMcp,
  type SessionLogEvent,
} from '../mcp/globalMcpSetup.js';
import { getConfig } from '../config.js';
import { getRunModeInfo } from '../runMode.js';
import { childLogger } from '../log.js';

const log = childLogger('api:voice-prepare');

const PrepareBodySchema = z.object({
  project: z.string().min(1),
});

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

export async function registerVoiceSessionPrepareRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { project?: string } }>(
    '/api/voice-session/prepare',
    async (req, reply) => {
      const parsed = PrepareBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }

      reply.hijack();
      reply.raw.writeHead(200, sseHeaders(req));

      const project = parsed.data.project;
      log.info({ project }, 'voice session prepare started');

      const logs: SessionLogEvent[] = [];

      try {
        const { settings } = getConfig();
        const result = await ensureClientMcpSetup(settings.agentClient, (event) => {
          logs.push(event);
          writeSse(reply, 'session_log', event);
        });

        cleanupLegacyProjectMcp(project, (event) => {
          logs.push(event);
          writeSse(reply, 'session_log', event);
        });

        writeSse(reply, 'complete', { ...result, project });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errorEvent: SessionLogEvent = {
          phase: 'error',
          level: 'error',
          message,
          at: new Date().toISOString(),
        };
        writeSse(reply, 'session_log', errorEvent);
        writeSse(reply, 'complete', {
          ok: false,
          project,
          message,
          logs: [...logs, errorEvent],
        });
      }

      reply.raw.end();
    },
  );
}
