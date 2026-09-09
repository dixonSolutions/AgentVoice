/**
 * Typed turns and agent state for desk clients.
 *
 *   POST /api/turns { text, is_interrupt? }  → spawn-or-queue (agent_native only)
 *   GET  /api/agent/state                     → the same snapshot `/ws/events` sends on auth
 *   GET  /api/jobs?project=&limit=&status=    → job history (same rows as list_jobs_history)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { submitAgentNativeTurn, TurnError } from '../executor/agentTurns.js';
import { deskStateSnapshot } from './eventsSocket.js';
import { getJobsHistory } from '../executor/jobManager.js';
import { childLogger } from '../log.js';

const log = childLogger('routes:turns');

const TurnBody = z.object({
  text: z.string().min(1).max(20_000),
  is_interrupt: z.boolean().optional(),
  source: z.string().max(40).optional(),
});

export async function registerTurnRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: unknown }>('/api/turns', async (req, reply) => {
    const parsed = TurnBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const workflow = getConfig().settings.workflow.default;
    if (workflow !== 'agent_native') {
      return reply.code(409).send({
        error: `Typed turns need the agent_native workflow (active: ${workflow}). Switch it in Config.`,
      });
    }

    try {
      const delivery = submitAgentNativeTurn(parsed.data.text, {
        source: parsed.data.source ?? 'rest',
        isInterrupt: parsed.data.is_interrupt,
      });
      return { ok: true, ...delivery };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof TurnError ? err.code : 'ERROR';
      log.warn({ code, err: message }, 'turn rejected');
      return reply.code(code === 'NO_PROJECT' ? 409 : 500).send({ error: message, code });
    }
  });

  app.get('/api/agent/state', async () => deskStateSnapshot());

  app.get<{ Querystring: { project?: string; limit?: string; status?: string } }>('/api/jobs', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const status = req.query.status;
    const filter = status === 'done' || status === 'error' || status === 'stopped' ? status : 'all';
    const jobs = getJobsHistory(req.query.project || undefined, limit, filter).map((j) => ({
      id: j.id,
      project: j.project,
      mode: j.mode,
      prompt: j.prompt,
      status: j.status,
      session_id: j.sessionId,
      summary: j.summary,
      error: j.error,
      files_changed: j.diffstat ? (j.diffstat.match(/(\d+) files? changed/)?.[1] ? Number(j.diffstat.match(/(\d+) files? changed/)![1]) : null) : null,
      started_at: j.startedAt,
      finished_at: j.finishedAt,
      elapsed_ms: j.finishedAt ? new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime() : null,
      checkpoint: j.checkpoint,
    }));
    return { jobs };
  });
}
