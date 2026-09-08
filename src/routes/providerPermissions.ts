/**
 * Permission-mode routes — which approval policy the active CLI runs with.
 * Mirrors mcp/tools/permission.ts so the Voice tab and the voice agent agree.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { describePermissionModes, setPermissionMode } from '../providers/agents/permissions.js';
import { childLogger } from '../log.js';

const log = childLogger('routes:provider-permissions');

const SetBody = z.object({ mode: z.string().min(1) });

export async function registerProviderPermissionRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/providers/permission-modes — modes the active provider offers + the active one. */
  app.get('/api/providers/permission-modes', async () => describePermissionModes());

  /** POST /api/providers/permission-mode { mode } */
  app.post<{ Body: unknown }>('/api/providers/permission-mode', async (req, reply) => {
    const parsed = SetBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      return { ok: true, ...setPermissionMode(parsed.data.mode) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message }, 'set permission mode failed');
      return reply.code(400).send({ error: message });
    }
  });
}
