/**
 * REST answer path for pending approvals — for clients that cannot hold the
 * control WebSocket (the desk extension answers over `/ws/events` normally,
 * but a plain HTTP fallback keeps notifications working when the socket is
 * reconnecting).
 *
 *   POST /api/approvals/:id/respond   body = { kind, ... } (same shape as the WS `response`)
 *
 * Secrets are forwarded to the registry and never logged.
 */

import type { FastifyInstance } from 'fastify';
import { applyApprovalResponse } from '../mcp/server/approvalResponses.js';

export async function registerApprovalRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/approvals/:id/respond',
    async (req, reply) => {
      const result = applyApprovalResponse(req.params.id, req.body, 'rest');
      if (result.ok) return { ok: true, request_id: req.params.id };
      if (result.reason === 'invalid') {
        return reply.code(400).send({ error: 'Malformed approval response — expected { kind, ... }' });
      }
      return reply.code(404).send({ error: 'No pending approval with that id (already answered, timed out, or unknown)' });
    },
  );
}
