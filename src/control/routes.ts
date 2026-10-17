/**
 * `/api/control/*` — what the `squeaky` control commands call (sessions,
 * use, new, agent, say, config, default). App-token auth like every /api
 * route. Answers are data; the CLI words them (control/format.ts), so a chat
 * that runs the CLI reads exactly what a terminal does.
 *
 *   GET  /api/control/status?channel&conversation      agent, project, listener (+ this conversation's default)
 *   GET  /api/control/projects                          POST /api/control/project {name}
 *   GET  /api/control/sessions?project&channel&conversation&user
 *   POST /api/control/use {query}                       POST /api/control/new {project?, channel?, conversation?}
 *   POST /api/control/stop                              POST /api/control/say {text, channel?, conversation?}
 *   GET  /api/control/config                            POST /api/control/config {key, value}
 *   GET  /api/control/default?channel&conversation|user POST /api/control/default {channel, conversation|user, target}
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { childLogger } from '../log.js';
import { dbBindingStore, type BindingStore } from '../channels/bindings.js';
import { prepareAgentForChannels } from '../channels/prepare.js';
import { CHANNEL_IDS, type ChannelId } from '../channels/types.js';
import { deliverStreamTurn, type StreamTurnOutcome } from '../voice/streamTurns.js';
import { createBridgeOps, injectApi } from './ops.js';
import { applyBinding, pinDefault, useSession, voiceDefaultKey } from './sessions.js';
import type { BridgeOps } from './types.js';

const log = childLogger('control');

export interface ControlDeps {
  ops?: BridgeOps;
  bindings?: BindingStore;
  /** Hand a turn to the agent; the default prepares the agent CLI first. */
  submit?: (text: string, source: string) => Promise<StreamTurnOutcome>;
}

const ChannelQuery = z.object({
  channel: z.enum(CHANNEL_IDS as unknown as [ChannelId, ...ChannelId[]]).optional(),
  conversation: z.string().min(1).optional(),
  user: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
});

/** The binding key a request means: a conversation's default, or (user only) a person's voice default. */
function keyOf(q: { conversation?: string | undefined; user?: string | undefined }): string | null {
  if (q.conversation) return q.conversation;
  return q.user ? voiceDefaultKey(q.user) : null;
}

async function defaultSubmit(text: string, source: string): Promise<StreamTurnOutcome> {
  try {
    await prepareAgentForChannels();
  } catch (err) {
    return { ok: false, reason: 'ERROR', message: err instanceof Error ? err.message : String(err) };
  }
  return deliverStreamTurn(text, source);
}

export function registerControlRoutes(app: FastifyInstance, deps: ControlDeps = {}): void {
  const ops = deps.ops ?? createBridgeOps(injectApi(app));
  const bindings = deps.bindings ?? dbBindingStore;
  const submit = deps.submit ?? defaultSubmit;

  /** Run a handler; a thrown error is the command's answer (400), not a crash. */
  const guard = async <T>(reply: FastifyReply, fn: () => T | Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.debug({ err: message }, 'control command refused');
      return reply.code(400).send({ error: message });
    }
  };
  const parse = <S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> => {
    const r = schema.safeParse(raw ?? {});
    if (!r.success) throw new Error(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    return r.data as z.infer<S>;
  };
  const bindingOf = (q: z.infer<typeof ChannelQuery>) => {
    const key = q.channel ? keyOf(q) : null;
    return q.channel && key ? bindings.get(q.channel, key) : null;
  };

  app.get('/api/control/status', async (req, reply) =>
    guard(reply, () => {
      const q = parse(ChannelQuery, req.query);
      return { status: ops.status(), binding: bindingOf({ ...q, user: undefined }) };
    }),
  );

  app.get('/api/control/projects', async () => ({ projects: ops.projects() }));

  app.post('/api/control/project', async (req, reply) =>
    guard(reply, () => ({ project: ops.setProject(parse(z.object({ name: z.string().min(1) }), req.body).name) })),
  );

  app.get('/api/control/sessions', async (req, reply) =>
    guard(reply, () => {
      const q = parse(ChannelQuery, req.query);
      return {
        rows: ops.sessions(q.project),
        binding: bindingOf({ ...q, user: undefined }),
        voiceBinding: q.channel && q.user ? bindings.get(q.channel, voiceDefaultKey(q.user)) : null,
      };
    }),
  );

  app.post('/api/control/use', async (req, reply) =>
    guard(reply, () => ({ message: useSession(ops, parse(z.object({ query: z.string().min(1) }), req.body).query) })),
  );

  app.post('/api/control/new', async (req, reply) =>
    guard(reply, async () => {
      const b = parse(ChannelQuery, req.body);
      const binding = bindingOf({ ...b, user: undefined });
      const message = await ops.newSession(b.project ?? binding?.project ?? undefined);
      // A fresh thread replaces whatever this conversation had pinned for its project.
      if (binding && (!b.project || b.project === binding.project)) {
        bindings.set({ ...binding, sessionId: null, label: `latest on ${binding.project}` });
      }
      return { message };
    }),
  );

  app.post('/api/control/stop', async () => ({ stopped: ops.stopAgent() }));

  app.post('/api/control/say', async (req, reply) =>
    guard(reply, async () => {
      const b = parse(ChannelQuery.extend({ text: z.string().trim().min(1) }), req.body);
      const pinned = applyBinding(bindingOf({ ...b, user: undefined }), ops);
      const outcome = await submit(b.text, b.channel ?? 'cli');
      if (!outcome.ok) throw new Error(outcome.message);
      return { pinned, delivery: outcome.delivery };
    }),
  );

  app.get('/api/control/config', async () => ({
    keys: ops.configKeys().map((k) => ({ ...k, value: ops.getConfig(k.key) })),
  }));

  app.post('/api/control/config', async (req, reply) =>
    guard(reply, async () => {
      const b = parse(z.object({ key: z.string().min(1), value: z.string() }), req.body);
      if (!ops.configKeys().some((k) => k.key === b.key)) throw new Error(`Unknown setting \`${b.key}\`. \`config\` lists them.`);
      return { message: await ops.setConfig(b.key, b.value) };
    }),
  );

  app.get('/api/control/default', async (req, reply) =>
    guard(reply, () => {
      const q = parse(ChannelQuery, req.query);
      if (!q.channel || !keyOf(q)) throw new Error('channel and conversation (or user) are required');
      return { binding: bindings.get(q.channel, keyOf(q)!) };
    }),
  );

  app.post('/api/control/default', async (req, reply) =>
    guard(reply, () => {
      const b = parse(ChannelQuery.extend({ target: z.string().trim().min(1) }), req.body);
      const key = keyOf(b);
      if (!b.channel || !key) throw new Error('channel and conversation (or user) are required');
      return { message: pinDefault(ops, bindings, b.channel, key, b.target, b.conversation ? 'this conversation' : 'your voice calls') };
    }),
  );
}
