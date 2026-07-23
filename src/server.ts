/**
 * Fastify server — serves the PWA, exposes /api routes, runs the authenticated
 * control WebSocket for tool-call relay, and hosts the MCP SSE server.
 *
 * Route groups:
 *   GET  /healthz            — unauthenticated health check
 *   /api/*                   — Bearer-authenticated REST endpoints
 *   /ws/control              — authenticated control WebSocket (voice model relay)
 *   /ws/intelligence         — authenticated WebSocket (llm_intelligence workflow)
 *   GET|POST|DELETE /mcp     — MCP Streamable HTTP server (Cursor registers this)
 *
 * All /api/* and /mcp routes require a valid Bearer token (see auth.ts).
 * Security is enforced at the API level on every request and WS frame.
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { requireAuth, verifyWsToken, parseWsAuthMessage } from './auth.js';
import { getDb } from './state/db.js';
import {
  listProjects,
  resolveProject,
  setActiveProject,
  getSessionState,
} from './state/registry.js';
import { getConfig } from './config.js';
import { getRunModeInfo } from './runMode.js';
import { childLogger } from './log.js';
import { dispatchTool } from './mcp/handlers.js';
import { getNarrator, PhoneRelaySession } from './executor/narrator.js';
import { registerVoiceProviderRoutes } from './routes/voiceProviders.js';
import { registerIntelligenceWebSocket } from './intelligence/ws.js';
import { registerIntelligenceAudioRoutes } from './routes/intelligenceAudio.js';
import { registerCursorSessionRoutes } from './routes/cursorSessions.js';
import { registerVoiceSessionPrepareRoutes } from './routes/voiceSessionPrepare.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerAdminSettingsRoutes } from './routes/adminSettings.js';
import { registerServeRoutes } from './routes/serve.js';
import { registerProjectsAdminRoutes } from './routes/projectsAdmin.js';
import { registerMcpServer } from './mcp/server/index.js';
import { attachDevWebProxy, registerProductionWeb } from './webDispatch.js';
import { registerControlSocket } from './state/controlSocket.js';
import { registerPushRoutes } from './routes/push.js';
import { resolveRequest } from './mcp/server/approvalRegistry.js';
import { getImage, readImageBytes, clearImages } from './mcp/server/imageRegistry.js';
import { buildCursorAgentEnv } from './executor/cursorAgent.js';

/** Required for vosk-browser SharedArrayBuffer (wake-word WASM). */
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

const execFileAsync = promisify(execFile);
const log = childLogger('server');

// ── Health check helpers ──────────────────────────────────────────────────
//
// cursor-agent about can take several seconds — never block /healthz on it.
// Cache the version in the background; liveness checks must stay sub-second.

let cachedCliVersion: string | null = null;
let cliVersionRefreshInFlight: Promise<void> | null = null;

async function fetchCursorAgentVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('cursor-agent', ['about', '--format', 'json'], {
      timeout: 5000,
      env: buildCursorAgentEnv(),
    });
    const parsed = JSON.parse(stdout.trim()) as { cliVersion?: string };
    return parsed.cliVersion ?? null;
  } catch {
    return null;
  }
}

function refreshCliVersionCache(): void {
  if (cliVersionRefreshInFlight) return;
  cliVersionRefreshInFlight = (async () => {
    try {
      cachedCliVersion = await fetchCursorAgentVersion();
    } finally {
      cliVersionRefreshInFlight = null;
    }
  })();
}

// ── Server factory ────────────────────────────────────────────────────────

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  const { settings } = getConfig();
  const run = getRunModeInfo(settings);

  // Raw PCM uploads for Amazon Transcribe (PWA posts application/octet-stream).
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.addHook('onSend', async (req, reply, payload) => {
    // COOP/COEP are required for the PWA (Vosk WASM SharedArrayBuffer).
    // Do NOT send them on /mcp — Cursor's MCP process is not a browser and
    // some SSE clients reject responses with COEP/COOP set.
    if (!req.url.startsWith('/mcp')) {
      for (const [key, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) {
        reply.header(key, value);
      }
    }
    return payload;
  });

  // Test mode: allow cross-origin API calls when the PWA is opened directly on the
  // Angular dev port (http://localhost:4200) instead of the unified port.
  if (run.useDevWebServer) {
    const devOrigins = new Set([
      run.webUrl,
      `http://127.0.0.1:${run.webPort}`,
      `http://localhost:${run.webPort}`,
    ]);

    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers.origin;
      if (origin && devOrigins.has(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      }
      if (req.method === 'OPTIONS') {
        await reply.code(204).send();
      }
    });
  }

  await app.register(fastifyWebsocket);

  const webDistPath = resolve('web/dist');
  const isDevelopment = process.env.NODE_ENV === 'development';

  // ── Unauthenticated routes ─────────────────────────────────────────────

  app.get('/healthz', async (_req, _reply) => {
    const db = getDb();
    const projects = listProjects();
    refreshCliVersionCache();
    const cliVersion = cachedCliVersion;
    const { settings } = getConfig();
    const run = getRunModeInfo(settings);
    return {
      status: db.open ? 'ok' : 'degraded',
      db: db.open ? 'ok' : 'error',
      projects: projects.length,
      cliVersion,
      runMode: run.runMode,
      backendUrl: run.backendUrl,
      webUrl: run.webUrl,
      publicBaseUrl: run.publicBaseUrl ?? null,
      useDevWebServer: run.useDevWebServer,
      ts: new Date().toISOString(),
    };
  });

  // ── Auth gate for all /api/* ───────────────────────────────────────────

  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    if (req.url.startsWith('/api/')) {
      // Ephemeral key auth — img tags cannot send Bearer tokens.
      if (req.url.startsWith('/api/images/')) return;
      await requireAuth(req, reply);
    }
  });

  /** GET /api/images/:id?k= — serve carousel images (ephemeral key, not Bearer). */
  app.get<{ Params: { id: string }; Querystring: { k?: string } }>(
    '/api/images/:id',
    async (req, reply) => {
      const accessKey = typeof req.query.k === 'string' ? req.query.k : '';
      if (!accessKey) {
        return reply.code(401).send({ error: 'Missing access key' });
      }

      const stored = getImage(req.params.id, accessKey);
      if (!stored) {
        return reply.code(404).send({ error: 'Image not found or expired' });
      }

      if (stored.kind === 'url') {
        return reply.redirect(stored.value);
      }

      const bytes = readImageBytes(stored);
      if (!bytes) {
        return reply.code(404).send({ error: 'Image not readable' });
      }

      reply.header('Content-Type', stored.mime);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(bytes);
    },
  );

  // ── Project endpoints ──────────────────────────────────────────────────

  /** GET /api/projects — names + descriptions, never paths. */
  app.get('/api/projects', async () => {
    const projects = listProjects();
    return {
      projects: projects.map((p) => ({
        name: p.name,
        description: p.description,
        aliases: p.aliases,
        enabled: p.enabled,
      })),
    };
  });

  /** GET /api/active-project */
  app.get('/api/active-project', async () => {
    const session = getSessionState('default');
    return { activeProject: session.activeProject, activeModel: session.activeModel };
  });

  /** POST /api/active-project { project: string } */
  app.post<{ Body: { project: string } }>(
    '/api/active-project',
    {
      schema: {
        body: {
          type: 'object',
          required: ['project'],
          properties: { project: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const resolved = resolveProject(req.body.project);
      if (!resolved) {
        return reply
          .code(404)
          .send({ error: `Project "${req.body.project}" not found in registry` });
      }
      setActiveProject('default', resolved.name);
      return { activeProject: resolved.name, description: resolved.description };
    },
  );

  // ── Intelligence + MCP WebSockets ──────────────────────────────────────

  registerIntelligenceWebSocket(app);
  await registerVoiceProviderRoutes(app);
  await registerConfigRoutes(app);
  await registerIntelligenceAudioRoutes(app);
  await registerCursorSessionRoutes(app);
  await registerVoiceSessionPrepareRoutes(app);
  await registerAdminSettingsRoutes(app);
  await registerServeRoutes(app);
  await registerProjectsAdminRoutes(app);
  registerPushRoutes(app);

  /** GET /api/settings — non-secret operational settings. */
  app.get('/api/settings', async () => {
    const { settings: s } = getConfig();
    const run = getRunModeInfo(s);
    return {
      runMode: run.runMode,
      backendUrl: run.backendUrl,
      webUrl: run.webUrl,
      publicBaseUrl: run.publicBaseUrl ?? null,
      useDevWebServer: run.useDevWebServer,
      wakeWords: s.voice.wakeWords,
      turnSubmit: s.voice.turnSubmit,
      defaultMode: s.defaultMode,
      maxConcurrentJobs: s.maxConcurrentJobs,
      planFirst: s.planFirst,
      narratorEnabled: s.narratorEnabled,
      narratorCadenceMs: s.narratorCadenceMs,
      workflow: {
        default: s.workflow.default,
        llmIntelligence: {
          model: s.workflow.llmIntelligence.llm.model,
          region: s.workflow.llmIntelligence.llm.region,
          audio: {
            preferWebkit: s.workflow.llmIntelligence.audio.preferWebkit,
            pollyVoiceId: s.workflow.llmIntelligence.audio.pollyVoiceId,
            transcribeLanguageCode: s.workflow.llmIntelligence.audio.transcribeLanguageCode,
          },
        },
      },
    };
  });

  // ── Control WebSocket ──────────────────────────────────────────────────
  //
  // Full protocol (all frames are JSON):
  //
  // Phone → Bridge:
  //   { type: "auth", token: "<app-token>" }           First frame — auth
  //   { type: "tool_call", call_id, name, arguments }  Voice provider tool call
  //   { type: "speaking", value: bool }                TTS state update for narrator
  //
  // Bridge → Phone:
  //   { type: "auth_ok" }
  //   { type: "tool_result", call_id, result }
  //   { type: "tool_error",  call_id, error }
  //   { type: "narration",   text, kind? }             Narrator injection

  app.register(async (wsApp) => {
    wsApp.get('/ws/control', { websocket: true }, (socket, _req) => {
      let authenticated = false;
      // Voice tools share session state on the `default` key (same as /api/active-project).
      const sessionKey = 'default';
      let relaySession: PhoneRelaySession | null = null;

      log.debug({ sessionKey }, 'ws connection attempt');

      socket.on('message', (rawMsg: Buffer | string) => {
        const str = typeof rawMsg === 'string' ? rawMsg : rawMsg.toString('utf-8');

        // ── First frame: authenticate ──────────────────────────────────
        if (!authenticated) {
          const token = parseWsAuthMessage(str);
          if (!verifyWsToken(token)) {
            log.warn({ sessionKey }, 'ws auth failed — closing');
            socket.close(4001, 'Unauthorized');
            return;
          }
          authenticated = true;

          // Wire narrator to this connection.
          relaySession = new PhoneRelaySession((data) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(data);
            }
          });
          void getNarrator().setSession(relaySession);

          // Register socket broadcaster for approval push events.
          registerControlSocket((data) => {
            if (socket.readyState === socket.OPEN) socket.send(data);
          });

          socket.send(JSON.stringify({ type: 'auth_ok', sessionKey }));
          log.info({ sessionKey }, 'ws authenticated');
          return;
        }

        // ── Subsequent frames: tool calls + state updates ──────────────
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(str) as Record<string, unknown>;
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
          return;
        }

        // TTS state update (for narrator cadence)
        if (msg['type'] === 'speaking' && typeof msg['value'] === 'boolean') {
          relaySession?.setSpeaking(msg['value']);
          return;
        }

        // PWA → bridge: user answered an agent question or approved a plan
        if (msg['type'] === 'approval_response') {
          const request_id = typeof msg['request_id'] === 'string' ? msg['request_id'] : null;
          const response = msg['response'];
          if (request_id && response && typeof response === 'object') {
            const r = response as Record<string, unknown>;
            const kind = r['kind'] as string | undefined;
            let resolved = false;
            if (kind === 'user_input' && typeof r['answer'] === 'string') {
              resolved = resolveRequest(request_id, { kind: 'user_input', answer: r['answer'] });
            } else if (kind === 'plan_approval' && typeof r['decision'] === 'string') {
              resolved = resolveRequest(request_id, {
                kind: 'plan_approval',
                decision: r['decision'] as 'approved' | 'rejected' | 'modified',
                notes: typeof r['notes'] === 'string' ? r['notes'] : undefined,
              });
            }
            socket.send(JSON.stringify({ type: 'approval_ack', request_id, ok: resolved }));
          }
          return;
        }

        // Tool call relay
        if (msg['type'] === 'tool_call') {
          const callId = typeof msg['call_id'] === 'string' ? msg['call_id'] : randomUUID();
          const toolName = typeof msg['name'] === 'string' ? msg['name'] : '';
          const toolArgs = typeof msg['arguments'] === 'object' ? msg['arguments'] : {};

          log.debug({ sessionKey, tool: toolName, callId }, 'tool call received');

          void dispatchTool(toolName, toolArgs, sessionKey)
            .then((result) => {
              socket.send(
                JSON.stringify({ type: 'tool_result', call_id: callId, result }),
              );
            })
            .catch((err: Error) => {
              socket.send(
                JSON.stringify({
                  type: 'tool_error',
                  call_id: callId,
                  error: err.message,
                }),
              );
            });
          return;
        }

        log.debug({ msg }, 'unhandled ws message type');
      });

      socket.on('close', () => {
        log.info({ sessionKey }, 'ws closed');
        // Detach narrator — events will buffer until next connection.
        if (relaySession) {
          void getNarrator().setSession(null);
          relaySession = null;
        }
        // Deregister control socket broadcaster.
        registerControlSocket(null);
        clearImages();
      });

      socket.on('error', (err: Error) => {
        log.error({ err, sessionKey }, 'ws error');
      });
    });
  });

  registerMcpServer(app);

  // ── Web dispatch (after /api/* and /ws/* routes) ───────────────────────
  //
  // Development: proxy everything else to the Angular dev server (HMR).
  // Production: serve web/dist with SPA index.html fallback.
  if (isDevelopment) {
    attachDevWebProxy(app, run.webPort);
  } else {
    await registerProductionWeb(app, webDistPath);
  }

  app.setErrorHandler((err, req, reply) => {
    log.error({ err, url: req.url }, 'unhandled route error');
    reply.code(500).send({ error: 'Internal server error' });
  });

  log.info(
    {
      webDispatch: isDevelopment ? 'dev-proxy' : 'static',
      webDistPath: isDevelopment ? null : webDistPath,
    },
    'web dispatch configured',
  );

  refreshCliVersionCache();

  return app;
}

/** Start listening. Serve mode binds to 0.0.0.0 so Tailscale peers can reach the bridge directly. */
export async function startServer(app: FastifyInstance): Promise<string> {
  const { settings } = getConfig();
  const run = getRunModeInfo(settings);
  const host = run.runMode === 'serve' ? '0.0.0.0' : '127.0.0.1';
  const address = await app.listen({ port: run.backendPort, host });
  log.info(
    {
      address,
      runMode: run.runMode,
      webUrl: run.webUrl,
      angularDev: run.useDevWebServer ? `http://127.0.0.1:${run.webPort} (internal)` : null,
      useDevWebServer: run.useDevWebServer,
    },
    run.useDevWebServer
      ? `bridge listening on :${run.backendPort} — open ${run.webUrl} (PWA; proxies /api + /ws to bridge)`
      : 'bridge listening',
  );
  return address;
}
