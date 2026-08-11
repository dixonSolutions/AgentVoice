/**
 * Pluggable hosting/tunnel provider admin routes.
 *
 * Distinct from /api/admin/hosting (ports + runMode) in adminSettings.ts —
 * this namespace is about *which* tunnel/reverse-proxy mechanism exposes the
 * bridge (Tailscale, Cloudflare, ngrok, Dev Tunnels, LAN, local, manual).
 *
 * Routes:
 *   GET   /api/admin/hosting-providers            — list all providers + detect() status
 *   PATCH /api/admin/hosting-providers/active      — set/clear the explicit provider override
 *   POST  /api/admin/hosting-providers/setup       — run provider.setup(), streams progress over the control socket
 *   GET   /api/admin/hosting-providers/setup/:runId — poll a setup run (WS-disconnect-safe fallback)
 *   GET   /api/admin/hosting-providers/doctor      — run provider.doctor() for one or all providers
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HOSTING_PROVIDERS, type HostingProviderId } from '../config.js';
import { detectActiveHostingProviderId, getHostingProvider, listHostingProviders } from '../providers/hosting/registry.js';
import { persistHostingProvider } from '../providers/hosting/persist.js';
import { pushToPhone } from '../state/controlSocket.js';
import type { HostingDetectResult, HostingProgressEvent, HostingSetupResult } from '../providers/hosting/types.js';
import { childLogger } from '../log.js';

const log = childLogger('hostingAdminRoute');

interface SetupRun {
  runId: string;
  provider: HostingProviderId;
  events: HostingProgressEvent[];
  done: boolean;
  result?: HostingSetupResult;
  startedAt: number;
}

/** In-memory only — setup runs don't need to survive a bridge restart. */
const runs = new Map<string, SetupRun>();
const MAX_RUNS = 20;

function pruneOldRuns(): void {
  if (runs.size <= MAX_RUNS) return;
  const sorted = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const run of sorted.slice(0, runs.size - MAX_RUNS)) {
    runs.delete(run.runId);
  }
}

async function describeProviders(): Promise<
  Array<{ id: HostingProviderId; displayName: string; capabilities: unknown; detected: HostingDetectResult }>
> {
  const providers = listHostingProviders();
  return Promise.all(
    providers.map(async (p) => {
      let detected: HostingDetectResult;
      try {
        detected = await p.detect();
      } catch (err) {
        detected = { active: false, installed: false, publicUrl: null, detail: err instanceof Error ? err.message : String(err) };
      }
      return { id: p.id, displayName: p.displayName, capabilities: p.capabilities, detected };
    }),
  );
}

const SetupBodySchema = z
  .object({
    provider: z.enum(HOSTING_PROVIDERS),
    hostname: z.string().min(1).max(253).optional(),
    loginServer: z.string().url().optional(),
  })
  .strict();

const ActivePatchSchema = z
  .object({
    /** Omit or null to clear the override and go back to auto-detect. */
    provider: z.enum(HOSTING_PROVIDERS).nullable().optional(),
  })
  .strict();

export async function registerHostingAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/hosting-providers', async () => {
    const [providers, active] = await Promise.all([describeProviders(), Promise.resolve(detectActiveHostingProviderId())]);
    return { active, providers };
  });

  app.patch<{ Body: unknown }>('/api/admin/hosting-providers/active', async (req, reply) => {
    const parsed = ActivePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    persistHostingProvider(parsed.data.provider ?? undefined);
    log.info({ provider: parsed.data.provider ?? null }, 'hosting provider override updated');
    return { ok: true, active: detectActiveHostingProviderId() };
  });

  app.post<{ Body: unknown }>('/api/admin/hosting-providers/setup', async (req, reply) => {
    const parsed = SetupBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const { provider: providerId, hostname, loginServer } = parsed.data;
    const provider = getHostingProvider(providerId);

    const runId = randomUUID();
    const run: SetupRun = { runId, provider: providerId, events: [], done: false, startedAt: Date.now() };
    runs.set(runId, run);
    pruneOldRuns();

    const onProgress = (event: HostingProgressEvent) => {
      run.events.push(event);
      if (event.done) run.done = true;
      pushToPhone({ type: 'hosting_setup_progress', runId, provider: providerId, ...event });
    };

    // Setup can block on CLI auth (tailscale up, cloudflared login, …) — run in
    // the background and let the client poll/stream instead of holding the request.
    void provider
      .setup({ hostname, loginServer }, onProgress)
      .then((result) => {
        run.result = result;
        run.done = true;
        // Lock in the explicit choice on success — otherwise registry.ts's
        // ts.net-only auto-detect would silently fall back to "manual" for
        // every non-Tailscale provider on the next lookup.
        if (result.ok) persistHostingProvider(providerId);
        pushToPhone({ type: 'hosting_setup_progress', runId, provider: providerId, message: result.detail, done: true, result });
        log.info({ provider: providerId, ok: result.ok }, 'hosting setup finished');
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        run.result = { ok: false, publicUrl: null, detail: message };
        run.done = true;
        pushToPhone({ type: 'hosting_setup_progress', runId, provider: providerId, message, done: true, error: message });
        log.error({ provider: providerId, err: message }, 'hosting setup threw');
      });

    return reply.code(202).send({ runId, provider: providerId });
  });

  app.get<{ Params: { runId: string } }>('/api/admin/hosting-providers/setup/:runId', async (req, reply) => {
    const run = runs.get(req.params.runId);
    if (!run) {
      return reply.code(404).send({ error: 'Unknown or expired setup run' });
    }
    return { runId: run.runId, provider: run.provider, events: run.events, done: run.done, result: run.result };
  });

  app.get<{ Querystring: { provider?: string } }>('/api/admin/hosting-providers/doctor', async (req, reply) => {
    const requested = req.query.provider;
    if (requested) {
      const parsed = z.enum(HOSTING_PROVIDERS).safeParse(requested);
      if (!parsed.success) {
        return reply.code(400).send({ error: `Unknown provider "${requested}"` });
      }
      const provider = getHostingProvider(parsed.data);
      const result = await provider.doctor();
      return { provider: parsed.data, ...result };
    }
    const providers = listHostingProviders();
    const results = await Promise.all(
      providers.map(async (p) => ({ provider: p.id, ...(await p.doctor()) })),
    );
    return { results };
  });
}
