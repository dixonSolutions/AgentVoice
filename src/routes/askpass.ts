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
import { askpassPolicy } from '../state/awayPolicy.js';
import { phrase, shouldSpeakNarration, narrationPayload } from '../voice/phrases.js';
import { isVoiceAgentRunning } from '../executor/voiceAgent.js';
import { getConfig } from '../config.js';

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

    /**
     * With nobody listening, a sudo prompt otherwise blocks the agent's shell
     * for the full five-minute timeout waiting for a password no one will
     * type. `fail_fast` is the default for exactly that reason (docs/36 §4).
     */
    const policy = askpassPolicy();
    if (!policy.ask) {
      log.info({ source, reason: policy.reason }, 'password prompt refused — nobody listening');
      return reply.code(409).send({ error: 'unattended', reason: policy.reason });
    }

    const { request_id, promise } = registerRequest((id) => {
      const request: SecretInputRequest = { kind: 'secret_input', request_id: id, prompt, source };
      void notifyPhone({ type: 'secret_input_request', ...request, agent });
      return request;
    }, policy.timeoutMs || ASKPASS_TIMEOUT_MS);

    /**
     * The spoken line is a phrase-catalog entry now, so it can be switched off,
     * reworded or translated like every other bridge line — and it never reads
     * the raw prompt text aloud unless the user asked for raw detail
     * (docs/39 Part B).
     */
    const speak = shouldSpeakNarration('secret_input', {
      agentOwnsNarration:
        getConfig().settings.workflow.default === 'agent_native' && isVoiceAgentRunning(),
    });
    void notifyPhone(
      narrationPayload({
        kind: 'secret_input',
        text: phrase('secret_input', { agent, prompt: source === 'sudo' ? 'your sudo password' : 'a password' }),
        speak,
        data: { source, request_id },
      }),
    );
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
