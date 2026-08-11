/**
 * Provider auth routes — in-app, phone-driven login for whichever CLI
 * (Cursor / Codex / Claude Code) is currently active.
 *
 * Flow:
 *   1. Bridge detects an AUTH_REQUIRED spawn failure (see providers/agents/authNotify.ts)
 *      and pushes { type: 'auth_required', provider, flows } to the phone.
 *   2. PWA shows the auth-card, calls GET /api/providers to confirm flows,
 *      then POST /auth/start with the flow the user picked.
 *   3. For browser-url/device-code: PWA shows the returned url/code and polls
 *      /auth/poll until it resolves; for token-paste/api-key it resolves immediately.
 *
 * All routes require the same Bearer APP_TOKEN as the rest of /api/* — security
 * is enforced at the API level, not just hidden in the UI.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENT_CLIENTS, getConfig, type AgentClient } from '../config.js';
import { getProvider, listAgentProviders } from '../providers/agents/registry.js';
import type { AuthCheckResult, AuthFlowId } from '../providers/agents/types.js';
import { childLogger } from '../log.js';

const log = childLogger('routes:provider-auth');

const AgentClientParam = z.object({ id: z.enum(AGENT_CLIENTS) });
const AuthStartBody = z.object({
  flow: z.enum(['browser-url', 'device-code', 'token-paste', 'api-key']),
  pasted: z.string().optional(),
});

interface PendingLogin {
  attemptId: string;
  provider: AgentClient;
  flow: AuthFlowId;
  url?: string;
  code?: string;
  instructions: string;
  startedAt: number;
  settled: boolean;
  result: AuthCheckResult | null;
  cancel(): void;
}

const pending = new Map<string, PendingLogin>();

/** Sweep attempts older than 15 minutes so the map can't grow unbounded. */
function sweepStale(): void {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [id, entry] of pending.entries()) {
    if (entry.startedAt < cutoff) pending.delete(id);
  }
}

export async function registerProviderAuthRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/providers — every provider's install state (fast, no CLI calls). */
  app.get('/api/providers', async () => {
    const active = getConfig().settings.agentClient;
    return {
      active,
      providers: listAgentProviders().map((p) => ({
        id: p.id,
        displayName: p.displayName,
        installed: p.isInstalled(),
        supportsModelSelection: p.supportsModelSelection(),
        authFlows: p.authFlows(),
      })),
    };
  });

  /** GET /api/providers/:id/status — live auth check (may shell out; a few seconds). */
  app.get<{ Params: { id: string } }>('/api/providers/:id/status', async (req, reply) => {
    const parsed = AgentClientParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const provider = getProvider(parsed.data.id);
    const status = await provider.checkAuth();
    return { provider: provider.id, displayName: provider.displayName, ...status };
  });

  /** POST /api/providers/:id/auth/start — kick off a login flow. */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/providers/:id/auth/start',
    async (req, reply) => {
      const paramsParsed = AgentClientParam.safeParse(req.params);
      if (!paramsParsed.success) return reply.code(400).send({ error: paramsParsed.error.message });
      const bodyParsed = AuthStartBody.safeParse(req.body);
      if (!bodyParsed.success) return reply.code(400).send({ error: bodyParsed.error.message });

      const provider = getProvider(paramsParsed.data.id);
      sweepStale();

      try {
        const start = await provider.startLogin(bodyParsed.data.flow, { pasted: bodyParsed.data.pasted });
        const attemptId = randomUUID();

        const entry: PendingLogin = {
          attemptId,
          provider: provider.id,
          flow: start.flow,
          url: start.url,
          code: start.code,
          instructions: start.instructions,
          startedAt: Date.now(),
          settled: false,
          result: null,
          cancel: start.cancel,
        };
        pending.set(attemptId, entry);

        void start.done.then((result) => {
          entry.settled = true;
          entry.result = result;
          log.info(
            { provider: provider.id, flow: start.flow, authenticated: result.authenticated },
            'login attempt settled',
          );
        });

        // token-paste / api-key flows resolve `done` synchronously — yield one
        // microtask so the `.then` above (queued first, FIFO) can flush before
        // we read entry.settled, letting the caller skip an unnecessary poll.
        await Promise.resolve();

        log.info({ provider: provider.id, flow: start.flow, attemptId }, 'login flow started');

        return {
          attemptId,
          flow: start.flow,
          url: start.url ?? null,
          code: start.code ?? null,
          instructions: start.instructions,
          settled: entry.settled,
          result: entry.result,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  /** GET /api/providers/:id/auth/poll/:attemptId — non-blocking peek at a login attempt. */
  app.get<{ Params: { id: string; attemptId: string } }>(
    '/api/providers/:id/auth/poll/:attemptId',
    async (req, reply) => {
      const entry = pending.get(req.params.attemptId);
      if (!entry || entry.provider !== req.params.id) {
        return reply.code(404).send({ error: 'Unknown login attempt' });
      }
      return {
        attemptId: entry.attemptId,
        flow: entry.flow,
        url: entry.url ?? null,
        code: entry.code ?? null,
        settled: entry.settled,
        result: entry.result,
      };
    },
  );

  /** POST /api/providers/:id/auth/cancel/:attemptId — abort an in-flight login. */
  app.post<{ Params: { id: string; attemptId: string } }>(
    '/api/providers/:id/auth/cancel/:attemptId',
    async (req, reply) => {
      const entry = pending.get(req.params.attemptId);
      if (!entry || entry.provider !== req.params.id) {
        return reply.code(404).send({ error: 'Unknown login attempt' });
      }
      entry.cancel();
      pending.delete(req.params.attemptId);
      return { ok: true };
    },
  );
}
