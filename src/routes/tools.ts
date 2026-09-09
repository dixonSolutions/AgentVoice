/**
 * Generic REST relay to the MCP tool dispatcher — the desk client gets the
 * entire `agent_*` surface (submit, ask, diff, revert, sessions, models, …)
 * through the same allowlist, schema validation and audit log that the phone's
 * control-WebSocket `tool_call` frames pass through. Voice I/O tools (speak,
 * done, next_voice_turn) are not dispatchable here by construction.
 *
 *   POST /api/tools/:name   body = tool arguments
 */

import type { FastifyInstance } from 'fastify';
import { dispatchTool } from '../mcp/handlers.js';
import { childLogger } from '../log.js';

const log = childLogger('routes:tools');

/** The desk shares the phone's session key so project/model state is one thing. */
const SESSION_KEY = 'default';

export async function registerToolRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { name: string }; Body: unknown }>('/api/tools/:name', async (req, reply) => {
    const name = req.params.name;
    const args = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const result = await dispatchTool(name, args, SESSION_KEY);
      return { ok: true, tool: name, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ tool: name, err: message }, 'tool call failed');
      const status = message.startsWith('Unknown tool') ? 404 : message.startsWith('Invalid args') ? 400 : 500;
      return reply.code(status).send({ error: message, tool: name });
    }
  });
}
