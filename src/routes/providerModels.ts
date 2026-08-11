/**
 * Provider model routes — live model view + selection for the PWA Voice tab.
 * Mirrors the semantics of mcp/tools/model.ts (same cache, same scope rules)
 * so the app UI and the voice model never disagree about the active model.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSessionState } from '../state/registry.js';
import { handleListModels, handleSetModel } from '../mcp/tools/model.js';
import { childLogger } from '../log.js';

const log = childLogger('routes:provider-models');

/** The web app's admin/config surface always acts on the 'default' session key. */
const ADMIN_SESSION_KEY = 'default';

const SetModelBody = z.object({
  model_id: z.string().min(1),
  scope: z.enum(['global', 'session']).optional(),
});

export async function registerProviderModelRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/providers/models?query= — live models for the active provider. */
  app.get<{ Querystring: { query?: string } }>('/api/providers/models', async (req, reply) => {
    const activeModel = getSessionState(ADMIN_SESSION_KEY).activeModel;
    try {
      return await handleListModels({ query: req.query.query }, activeModel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message }, 'list models failed');
      return reply.code(400).send({ error: message });
    }
  });

  /** POST /api/providers/model — set the model (default scope: global). */
  app.post<{ Body: unknown }>('/api/providers/model', async (req, reply) => {
    const parsed = SetModelBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const result = await handleSetModel(parsed.data, ADMIN_SESSION_KEY);
      return { ok: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message }, 'set model failed');
      return reply.code(400).send({ error: message });
    }
  });
}
