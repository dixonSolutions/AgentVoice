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
 *   GET  /api/admin/narration       — what the bridge says aloud (docs/39 Part B)
 *   PATCH /api/admin/narration
 *   GET  /api/admin/session         — disconnect / unattended policy (docs/36)
 *   PATCH /api/admin/session
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
import {
  getConfig,
  AGENT_CLIENTS,
  AWAY_POLICIES,
  RESTART_POLICIES,
  NARRATION_KINDS,
  NarrationModeSchema,
  type AgentClient,
} from '../config.js';
import { phraseCatalog, validateTemplate } from '../voice/phrases.js';
import { getPresence } from '../state/presence.js';
import { readConfigFile, writeConfigFile } from '../state/configFile.js';
import {
  isAgentClientAvailable,
  resolvedAgentBinPath,
} from '../executor/agentProcess.js';
import { getAwsKeyStatus, updateAwsEnvKeys, isAwsConfigured } from '../state/envFile.js';
import { getDb } from '../state/db.js';
import { AUTO_MODEL_ID, getCachedModelsAnyAge, isValidModelId } from '../state/models.js';
import { getDefaultSelection, persistDefaultSelection, setSelectionForAllSessions } from '../state/registry.js';
import { childLogger } from '../log.js';
import { getProvider } from '../providers/agents/registry.js';
import {
  resolveAwsAuth,
  validateAwsCredentials,
  isAwsEnvViable,
} from '../intelligence/aws/credentials.js';

const log = childLogger('adminSettings');

// ── Validation schemas ─────────────────────────────────────────────────────

const WorkflowPatchSchema = z
  .object({
    // `cursor_native` is the pre-rename id — accepted and normalized so a
    // cached PWA build cannot 400 against a freshly migrated bridge.
    default: z
      .enum(['agent_native', 'cursor_native', 'llm_intelligence'])
      .optional()
      .transform((v) => (v === 'cursor_native' ? ('agent_native' as const) : v)),
    llmIntelligence: z
      .object({
        llm: z
          .object({
            model: z.string().min(1).optional(),
            region: z.string().min(1).optional(),
            maxTokens: z.number().int().min(256).max(8192).optional(),
          })
          .optional(),
        // Speech provider selection, models, voices and scopes live under
        // /api/speech (src/routes/speechProviders.ts) — only the AWS region for
        // Polly/Transcribe belongs to the workflow block.
        audio: z
          .object({ region: z.string().optional() })
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
    preRunFlags: z.array(z.string()).optional(),
    modelCacheTtlMs: z.number().int().positive().optional(),
    ghostKillEnabled: z.boolean().optional(),
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).optional(),
  })
  .strict();

/**
 * docs/39 Part B. `narratorEnabled` became `narration.enabled` and the cadence
 * interval is gone entirely — it only ever gated an event nothing emitted.
 */
const NarrationPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    events: z.record(z.enum(NARRATION_KINDS), NarrationModeSchema).optional(),
    templates: z.record(z.string(), z.string().max(400)).optional(),
    speakRawDetail: z.boolean().optional(),
    maxBufferEvents: z.number().int().positive().max(1000).optional(),
  })
  .strict();

const SessionPatchSchema = z
  .object({
    graceMs: z.number().int().min(0).max(300_000).optional(),
    onPhoneAway: z.enum(AWAY_POLICIES).optional(),
    onBridgeRestart: z.enum(RESTART_POLICIES).optional(),
    unattended: z
      .object({
        maxRuntimeMs: z.number().int().positive().optional(),
        maxToolCalls: z.number().int().min(0).optional(),
        approvals: z.enum(['wait_push', 'deny', 'skip']).optional(),
        approvalTimeoutMs: z.number().int().positive().optional(),
        secrets: z.enum(['wait_push', 'fail_fast']).optional(),
        requireWorktree: z.boolean().optional(),
        notifyOnFinish: z.boolean().optional(),
      })
      .strict()
      .optional(),
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
      preRunFlags,
      modelCacheTtlMs,
      ghostKillEnabled,
      logLevel,
    } = getConfig().settings;
    return {
      defaultMode,
      maxConcurrentJobs,
      jobTimeoutMs,
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
    const { defaultMode, maxConcurrentJobs, jobTimeoutMs, preRunFlags, modelCacheTtlMs, ghostKillEnabled, logLevel } =
      getConfig().settings;
    return { ok: true, defaultMode, maxConcurrentJobs, jobTimeoutMs, preRunFlags, modelCacheTtlMs, ghostKillEnabled, logLevel };
  });

  // ── What gets spoken (docs/39 Part B) ─────────────────────────────────

  function narrationState() {
    const { narration, narratorMaxBufferEvents } = getConfig().settings;
    return {
      enabled: narration.enabled,
      events: narration.events,
      templates: narration.templates,
      speakRawDetail: narration.speakRawDetail,
      maxBufferEvents: narratorMaxBufferEvents,
      /** Every spoken bridge line, its default wording and its placeholders. */
      catalog: phraseCatalog(),
    };
  }

  app.get('/api/admin/narration', async () => narrationState());

  app.patch<{ Body: unknown }>('/api/admin/narration', async (req, reply) => {
    const parsed = NarrationPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const patch = parsed.data;

    // A template naming a placeholder its event never supplies would be read
    // out with a literal `{hole}` in it. Reject it here instead.
    if (patch.templates) {
      const problems: Array<{ key: string; unknown: string[] }> = [];
      for (const [key, template] of Object.entries(patch.templates)) {
        const kind = key.split('@')[0] ?? key;
        if (!(NARRATION_KINDS as readonly string[]).includes(kind)) {
          problems.push({ key, unknown: ['<unknown event>'] });
          continue;
        }
        const result = validateTemplate(kind as (typeof NARRATION_KINDS)[number], template);
        if (!result.ok) problems.push({ key, unknown: result.unknown });
      }
      if (problems.length > 0) {
        return reply.code(400).send({
          error: 'Unknown placeholders in narration template(s)',
          problems,
        });
      }
    }

    const cfg = readConfigFile();
    const settings = cfg.settings as Record<string, unknown>;
    const narration = {
      ...(settings['narration'] as Record<string, unknown> | undefined),
    } as Record<string, unknown>;
    if (patch.enabled !== undefined) narration['enabled'] = patch.enabled;
    if (patch.speakRawDetail !== undefined) narration['speakRawDetail'] = patch.speakRawDetail;
    if (patch.events) {
      narration['events'] = { ...(narration['events'] as object), ...patch.events };
    }
    if (patch.templates) {
      const merged = { ...(narration['templates'] as Record<string, string> | undefined) };
      for (const [key, value] of Object.entries(patch.templates)) {
        // An empty string means "back to the default", not "say nothing".
        if (value.trim() === '') delete merged[key];
        else merged[key] = value;
      }
      narration['templates'] = merged;
    }
    settings['narration'] = narration;
    if (patch.maxBufferEvents !== undefined) {
      settings['narratorMaxBufferEvents'] = patch.maxBufferEvents;
    }
    writeConfigFile(cfg);
    log.info('narration settings updated');
    return { ok: true, ...narrationState() };
  });

  /**
   * Deprecated alias. Older PWA builds still PATCH the single boolean; map it
   * onto the master switch so an app that has not refreshed keeps working.
   */
  app.get('/api/admin/narrator', async () => {
    const { narration, narratorMaxBufferEvents } = getConfig().settings;
    return {
      narratorEnabled: narration.enabled,
      narratorMaxBufferEvents,
      deprecated: 'Use /api/admin/narration',
    };
  });

  app.patch<{ Body: unknown }>('/api/admin/narrator', async (req, reply) => {
    const parsed = z
      .object({
        narratorEnabled: z.boolean().optional(),
        narratorMaxBufferEvents: z.number().int().positive().optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const cfg = readConfigFile();
    const settings = cfg.settings as Record<string, unknown>;
    if (parsed.data.narratorEnabled !== undefined) {
      settings['narration'] = {
        ...(settings['narration'] as object),
        enabled: parsed.data.narratorEnabled,
      };
    }
    if (parsed.data.narratorMaxBufferEvents !== undefined) {
      settings['narratorMaxBufferEvents'] = parsed.data.narratorMaxBufferEvents;
    }
    writeConfigFile(cfg);
    const { narration, narratorMaxBufferEvents } = getConfig().settings;
    return {
      ok: true,
      narratorEnabled: narration.enabled,
      narratorMaxBufferEvents,
      deprecated: 'Use /api/admin/narration',
    };
  });

  // ── Disconnect & background work (docs/36) ────────────────────────────

  app.get('/api/admin/session', async () => {
    const { session } = getConfig().settings;
    return { ...session, presence: getPresence().snapshot() };
  });

  app.patch<{ Body: unknown }>('/api/admin/session', async (req, reply) => {
    const parsed = SessionPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const cfg = readConfigFile();
    const settings = cfg.settings as Record<string, unknown>;
    const current = { ...(settings['session'] as Record<string, unknown> | undefined) };
    const { unattended, ...rest } = parsed.data;
    Object.assign(current, rest);
    if (unattended) {
      current['unattended'] = { ...(current['unattended'] as object), ...unattended };
    }
    settings['session'] = current;
    writeConfigFile(cfg);
    // The grace window is held by the live tracker, not re-read per check.
    getPresence().setGraceMs(getConfig().settings.session.graceMs);
    log.info({ patch: parsed.data }, 'session policy updated');
    return { ok: true, ...getConfig().settings.session };
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

  // Labels come from each provider's own displayName — a second copy here
  // would be one more place to forget when a client is added.

  function getAgentClientStatus() {
    const { settings } = getConfig();
    return {
      active: settings.agentClient,
      clients: AGENT_CLIENTS.map((id) => {
        const provider = getProvider(id);
        return {
          id,
          label: provider.displayName,
          available: isAgentClientAvailable(id),
          binPath: resolvedAgentBinPath(id),
          /** Rendered by the config screen instead of a hardcoded list. */
          binEnvVar: provider.binEnvVar(),
          binEnvValue: provider.binEnvVar() ? (process.env[provider.binEnvVar()!] ?? null) : null,
        };
      }),
      /**
       * Extra launch flags belong to the active CLI, not to jobs in general —
       * the shipped default (`--trust`) is Cursor's (docs/39 A6).
       */
      extraArgs: settings.preRunFlags,
    };
  }

  app.get('/api/admin/agent-client', async () => {
    return getAgentClientStatus();
  });

  /**
   * The selected model is bridge-wide, but model ids are not: "sonnet" means
   * nothing to Cursor and "claude-4.6-sonnet-medium" means nothing to Claude
   * Code. Left alone, switching clients carries the old CLI's id across and
   * every spawn dies with "There's an issue with the selected model".
   *
   * So on each switch, keep the selection only if the new provider's cached
   * catalog actually lists it; otherwise fall back to `auto`, which passes no
   * --model flag and is therefore valid for all four providers. No CLI is
   * spawned here — an unknown catalog resolves to `auto` rather than blocking
   * the switch on a probe.
   */
  function reconcileModelForClient(client: AgentClient): string | null {
    const current = getDefaultSelection();
    if (current.model === AUTO_MODEL_ID) return null;
    const cached = getCachedModelsAnyAge(client);
    if (cached && isValidModelId(cached, current.model)) return null;
    const fallback = { model: AUTO_MODEL_ID, effort: null, fast: false };
    persistDefaultSelection(fallback);
    setSelectionForAllSessions(fallback);
    log.info({ client, was: current.model }, 'active model does not exist on the new client — reset to auto');
    return current.model;
  }

  const AgentClientPatchSchema = z.object({ client: z.enum(AGENT_CLIENTS) }).strict();

  app.patch<{ Body: unknown }>('/api/admin/agent-client', async (req, reply) => {
    const parsed = AgentClientPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const cfg = readConfigFile();
    cfg.settings.agentClient = parsed.data.client;
    writeConfigFile(cfg);
    const resetModel = reconcileModelForClient(parsed.data.client);
    log.info({ client: parsed.data.client, resetModel }, 'agent client updated');
    return { ok: true, resetModel, ...getAgentClientStatus() };
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
