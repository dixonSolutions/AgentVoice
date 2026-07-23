/**
 * Admin settings routes — full developer control centre.
 *
 * All routes require the Bearer APP_TOKEN (enforced by the /api/* preHandler).
 * Exposes granular PATCH endpoints for each settings section so the config
 * tab can save individual sections without clobbering the whole file.
 *
 * Routes:
 *   GET  /api/admin/workflow        — LLM & workflow settings
 *   PATCH /api/admin/workflow
 *   GET  /api/admin/hosting         — run mode, ports, public URL
 *   PATCH /api/admin/hosting
 *   GET  /api/admin/jobs            — job scheduler settings
 *   PATCH /api/admin/jobs
 *   GET  /api/admin/narrator        — narrator settings
 *   PATCH /api/admin/narrator
 *   GET  /api/admin/keys            — AWS key status (masked)
 *   PATCH /api/admin/keys           — update AWS keys in .env
 *   POST /api/admin/keys/test       — STS credential ping
 *   GET  /api/admin/agent-client    — active agent client + availability
 *   PATCH /api/admin/agent-client   — change active agent client
 *   GET  /api/admin/db/stats        — table row counts + file size
 *   GET  /api/admin/db/audit        — recent audit log entries
 *   DELETE /api/admin/sessions      — clear session_state table
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getConfig, AGENT_CLIENTS, type AgentClient } from '../config.js';
import { readConfigFile, writeConfigFile } from '../state/configFile.js';
import {
  isAgentClientAvailable,
  resolvedAgentBinPath,
} from '../executor/cursorAgent.js';
import { getAwsKeyStatus, updateAwsEnvKeys, isAwsConfigured } from '../state/envFile.js';
import { getDb } from '../state/db.js';
import { childLogger } from '../log.js';
import {
  resolveAwsAuth,
  validateAwsCredentials,
  isAwsEnvViable,
} from '../intelligence/aws/credentials.js';

const log = childLogger('adminSettings');

// ── Validation schemas ─────────────────────────────────────────────────────

const WorkflowPatchSchema = z
  .object({
    default: z.enum(['cursor_native', 'llm_intelligence']).optional(),
    llmIntelligence: z
      .object({
        llm: z
          .object({
            model: z.string().min(1).optional(),
            region: z.string().min(1).optional(),
            maxTokens: z.number().int().min(256).max(8192).optional(),
          })
          .optional(),
        audio: z
          .object({
            preferWebkit: z.boolean().optional(),
            ttsProvider: z.enum(['browser', 'amazon_polly']).optional(),
            region: z.string().optional(),
            pollyVoiceId: z.string().min(1).optional(),
            pollyEngine: z.enum(['standard', 'neural', 'generative']).optional(),
            transcribeModel: z.enum(['speech_foundation_model']).optional(),
            transcribeLanguageMode: z.enum(['fixed', 'identify']).optional(),
            transcribeLanguageCode: z.string().min(1).optional(),
            transcribeLanguageOptions: z.string().min(2).optional(),
            transcribePreferredLanguage: z.string().min(2).optional(),
            transcribePartialResultsStabilization: z.boolean().optional(),
            transcribePartialResultsStability: z.enum(['low', 'medium', 'high']).optional(),
          })
          .optional(),
        memory: z
          .object({
            maxTurns: z.number().int().min(4).max(40).optional(),
            keepTurns: z.number().int().min(2).max(20).optional(),
            summarySentences: z.number().int().min(1).max(6).optional(),
          })
          .optional(),
        readOutputMaxChars: z.number().int().min(1000).max(32768).optional(),
      })
      .optional(),
  })
  .strict();

const HostingPatchSchema = z
  .object({
    runMode: z.enum(['test', 'serve']).optional(),
    runModes: z
      .object({
        test: z
          .object({
            backendPort: z.number().int().min(1024).max(65535).optional(),
            webPort: z.number().int().min(1024).max(65535).optional(),
          })
          .optional(),
        serve: z
          .object({
            backendPort: z.number().int().min(1024).max(65535).optional(),
            publicBaseUrl: z.string().url().optional().or(z.literal('')),
          })
          .optional(),
      })
      .optional(),
  })
  .strict();

const JobsPatchSchema = z
  .object({
    defaultMode: z.enum(['agent', 'plan']).optional(),
    maxConcurrentJobs: z.number().int().min(1).max(4).optional(),
    jobTimeoutMs: z.number().int().positive().optional(),
    planFirst: z.boolean().optional(),
    preRunFlags: z.array(z.string()).optional(),
    modelCacheTtlMs: z.number().int().positive().optional(),
    ghostKillEnabled: z.boolean().optional(),
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).optional(),
  })
  .strict();

const NarratorPatchSchema = z
  .object({
    narratorEnabled: z.boolean().optional(),
    narratorCadenceMs: z.number().int().positive().optional(),
    narratorMaxBufferEvents: z.number().int().positive().optional(),
  })
  .strict();

const KeysPatchSchema = z.record(z.string(), z.string());

// ── Helper: shallow-merge a validated patch into config.settings ──────────

function applyPatch<T extends object>(target: T, patch: Partial<T>): T {
  return { ...target, ...patch };
}

function applyDeepPatch<T extends object>(target: T, patch: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const patchVal = patch[key];
    if (
      patchVal !== null &&
      typeof patchVal === 'object' &&
      !Array.isArray(patchVal) &&
      typeof result[key] === 'object' &&
      result[key] !== null
    ) {
      result[key] = applyDeepPatch(result[key] as object, patchVal as object) as T[keyof T];
    } else if (patchVal !== undefined) {
      result[key] = patchVal as T[keyof T];
    }
  }
  return result;
}

// ── Route registration ─────────────────────────────────────────────────────

export async function registerAdminSettingsRoutes(app: FastifyInstance): Promise<void> {
  // ── Workflow ──────────────────────────────────────────────────────────

  app.get('/api/admin/workflow', async () => {
    return { workflow: getConfig().settings.workflow };
  });

  app.patch<{ Body: unknown }>('/api/admin/workflow', async (req, reply) => {
    const parsed = WorkflowPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const cfg = readConfigFile();
    cfg.settings.workflow = applyDeepPatch(
      cfg.settings.workflow,
      parsed.data as Partial<typeof cfg.settings.workflow>,
    );
    writeConfigFile(cfg);
    log.info('workflow settings updated');
    return { ok: true, workflow: getConfig().settings.workflow };
  });

  // ── Hosting & Network ─────────────────────────────────────────────────

  app.get('/api/admin/hosting', async () => {
    const { runMode, runModes } = getConfig().settings;
    return { runMode, runModes };
  });

  app.patch<{ Body: unknown }>('/api/admin/hosting', async (req, reply) => {
    const parsed = HostingPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const cfg = readConfigFile();
    if (parsed.data.runMode !== undefined) {
      cfg.settings.runMode = parsed.data.runMode;
    }
    if (parsed.data.runModes !== undefined) {
      cfg.settings.runModes = applyDeepPatch(
        cfg.settings.runModes,
        parsed.data.runModes as Partial<typeof cfg.settings.runModes>,
      );
    }
    writeConfigFile(cfg);
    log.info('hosting settings updated');
    const { runMode, runModes } = getConfig().settings;
    return { ok: true, runMode, runModes };
  });

  // ── Job Settings ──────────────────────────────────────────────────────

  app.get('/api/admin/jobs', async () => {
    const {
      defaultMode,
      maxConcurrentJobs,
      jobTimeoutMs,
      planFirst,
      preRunFlags,
      modelCacheTtlMs,
      ghostKillEnabled,
      logLevel,
    } = getConfig().settings;
    return {
      defaultMode,
      maxConcurrentJobs,
      jobTimeoutMs,
      planFirst,
      preRunFlags,
      modelCacheTtlMs,
      ghostKillEnabled,
      logLevel,
    };
  });

  app.patch<{ Body: unknown }>('/api/admin/jobs', async (req, reply) => {
    const parsed = JobsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const cfg = readConfigFile();
    cfg.settings = applyPatch(cfg.settings, parsed.data as Partial<typeof cfg.settings>);
    writeConfigFile(cfg);
    log.info('job settings updated');
    const { defaultMode, maxConcurrentJobs, jobTimeoutMs, planFirst, preRunFlags, modelCacheTtlMs, ghostKillEnabled, logLevel } =
      getConfig().settings;
    return { ok: true, defaultMode, maxConcurrentJobs, jobTimeoutMs, planFirst, preRunFlags, modelCacheTtlMs, ghostKillEnabled, logLevel };
  });

  // ── Narrator ──────────────────────────────────────────────────────────

  app.get('/api/admin/narrator', async () => {
    const { narratorEnabled, narratorCadenceMs, narratorMaxBufferEvents } = getConfig().settings;
    return { narratorEnabled, narratorCadenceMs, narratorMaxBufferEvents };
  });

  app.patch<{ Body: unknown }>('/api/admin/narrator', async (req, reply) => {
    const parsed = NarratorPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const cfg = readConfigFile();
    cfg.settings = applyPatch(cfg.settings, parsed.data as Partial<typeof cfg.settings>);
    writeConfigFile(cfg);
    log.info('narrator settings updated');
    const { narratorEnabled, narratorCadenceMs, narratorMaxBufferEvents } = getConfig().settings;
    return { ok: true, narratorEnabled, narratorCadenceMs, narratorMaxBufferEvents };
  });

  // ── AWS Keys ──────────────────────────────────────────────────────────

  app.get('/api/admin/keys', async () => {
    const env = process.env as Record<string, string | undefined>;
    const keys = getAwsKeyStatus(env);
    const viable = isAwsEnvViable(env);
    const configured = isAwsConfigured(env);
    return { keys, viable, configured };
  });

  app.patch<{ Body: unknown }>('/api/admin/keys', async (req, reply) => {
    const parsed = KeysPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    try {
      updateAwsEnvKeys(parsed.data);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
    const env = process.env as Record<string, string | undefined>;
    const keys = getAwsKeyStatus(env);
    const viable = isAwsEnvViable(env);
    const configured = isAwsConfigured(env);
    return { ok: true, keys, viable, configured };
  });

  app.post('/api/admin/keys/test', async () => {
    const start = Date.now();
    const env = process.env as Record<string, string | undefined>;
    if (!isAwsEnvViable(env)) {
      return {
        ok: false,
        latencyMs: 0,
        error: 'IAM credentials not configured — set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
      };
    }
    try {
      const auth = resolveAwsAuth(env);
      const region =
        (process.env.AWS_REGION?.trim() || null) ??
        getConfig().settings.workflow.llmIntelligence.llm.region;
      await validateAwsCredentials(region, auth);
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // ── Agent Client ──────────────────────────────────────────────────────

  const CLIENT_LABELS: Record<AgentClient, string> = {
    cursor: 'Cursor',
    codex: 'Codex',
    'claude-code': 'Claude Code',
  };

  function getAgentClientStatus() {
    const { settings } = getConfig();
    return {
      active: settings.agentClient,
      clients: AGENT_CLIENTS.map((id) => ({
        id,
        label: CLIENT_LABELS[id],
        available: isAgentClientAvailable(id),
        binPath: resolvedAgentBinPath(id),
      })),
    };
  }

  app.get('/api/admin/agent-client', async () => {
    return getAgentClientStatus();
  });

  const AgentClientPatchSchema = z.object({ client: z.enum(AGENT_CLIENTS) }).strict();

  app.patch<{ Body: unknown }>('/api/admin/agent-client', async (req, reply) => {
    const parsed = AgentClientPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const cfg = readConfigFile();
    cfg.settings.agentClient = parsed.data.client;
    writeConfigFile(cfg);
    log.info({ client: parsed.data.client }, 'agent client updated');
    return { ok: true, ...getAgentClientStatus() };
  });

  // ── Database Stats ────────────────────────────────────────────────────

  app.get('/api/admin/db/stats', async () => {
    const db = getDb();
    const tables = [
      'project',
      'session_state',
      'job',
      'job_event',
      'audit',
      'voice_agent_run',
      'model_cache',
      'serve_event',
    ] as const;
    const counts: Record<string, number> = {};
    for (const t of tables) {
      const row = db.prepare(`SELECT count(*) as n FROM ${t}`).get() as { n: number };
      counts[t] = row.n;
    }
    const pageCount = (
      db.prepare('PRAGMA page_count').get() as { page_count: number }
    ).page_count;
    const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    const sizeBytes = pageCount * pageSize;
    const dbPath = process.env['DB_PATH'] ?? './data/state.db';
    return { counts, sizeBytes, dbPath };
  });

  // ── Audit Log ─────────────────────────────────────────────────────────

  app.get<{ Querystring: { limit?: string } }>('/api/admin/db/audit', async (req) => {
    const db = getDb();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const entries = db
      .prepare('SELECT id, tool, result, reason, ts AS created_at FROM audit ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{
        id: number;
        tool: string;
        result: string;
        reason: string | null;
        created_at: string;
      }>;
    return { entries };
  });

  // ── Clear Sessions ────────────────────────────────────────────────────

  app.delete('/api/admin/sessions', async () => {
    const db = getDb();
    const { changes } = db.prepare('DELETE FROM session_state').run();
    log.info({ changes }, 'session_state cleared via admin API');
    return { ok: true, cleared: changes };
  });
}
