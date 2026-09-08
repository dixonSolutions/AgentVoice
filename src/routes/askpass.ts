/**
 * POST /api/askpass — the askpass helper (executor/askpass.ts) calls this when
 * sudo / git / ssh inside an agent's shell needs a password. The prompt is
 * relayed to the phone as a `secret_input` approval; the reply goes straight
 * back to the helper. Nothing here logs the secret.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerRequest, type SecretInputRequest } from '../mcp/server/approvalRegistry.js';
import { notifyPhone } from '../push/notifyPhone.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import { childLogger } from '../log.js';

const log = childLogger('routes:askpass');

const Body = z.object({ prompt: z.string().max(500).optional() });

/** sudo's default passwd_timeout is 5 minutes — match it. */
const ASKPASS_TIMEOUT_MS = 290_000;

function classifyPrompt(prompt: string): SecretInputRequest['source'] {
  const p = prompt.toLowerCase();
  if (p.includes('sudo')) return 'sudo';
  if (p.includes('git') || p.includes('username for') || p.includes('password for \'http')) return 'git';
  if (p.includes('ssh') || p.includes('passphrase') || p.includes('authenticity')) return 'ssh';
  return 'other';
}

export async function registerAskpassRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: unknown }>('/api/askpass', async (req, reply) => {
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const prompt = parsed.data.prompt?.trim() || 'Password:';
    const source = classifyPrompt(prompt);
    const agent = getActiveProvider().displayName;

    const { request_id, promise } = registerRequest((id) => {
      const request: SecretInputRequest = { kind: 'secret_input', request_id: id, prompt, source };
      void notifyPhone({ type: 'secret_input_request', ...request, agent });
      return request;
    }, ASKPASS_TIMEOUT_MS);

    void notifyPhone({
      type: 'narration',
      kind: 'secret_input',
      text:
        source === 'sudo'
          ? `${agent} needs your sudo password — enter it on your phone.`
          : `${agent} needs a password — enter it on your phone.`,
    });
    log.info({ request_id, source }, 'password prompt relayed to phone');

    try {
      const response = await promise;
      if (response.kind === 'secret_input' && typeof response.secret === 'string') {
        log.info({ request_id, source }, 'password prompt answered');
        return { secret: response.secret };
      }
      log.info({ request_id, source, kind: response.kind }, 'password prompt not answered');
      return reply.code(409).send({ error: 'cancelled' });
    } catch (err) {
      log.warn({ request_id, source, err: err instanceof Error ? err.message : String(err) }, 'password prompt timed out');
      return reply.code(408).send({ error: 'timeout' });
    }
  });
}
