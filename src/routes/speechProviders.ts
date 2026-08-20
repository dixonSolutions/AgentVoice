/**
 * Speech provider admin routes — both directions.
 *
 * Covers everything the Config → Speech screen needs: which engines exist,
 * which have their key filled in, the active choice and its fallback chain,
 * per-provider scopes, keys written to `.env`, live round-trip tests, and the
 * self-hosted container lifecycle.
 *
 * Security: all /api/* routes require Bearer APP_TOKEN (server preHandler).
 * Keys are written to `.env` and never read back — only configured/complete.
 *
 * Routes:
 *   GET   /api/speech                       — both catalogs + settings in one round trip
 *   PATCH /api/speech/stt                   — provider / fallbacks / language / model / scopes
 *   PATCH /api/speech/tts                   — provider / fallbacks / language / model / voice / scopes
 *   PATCH /api/speech/keys                  — write provider API keys into .env
 *   GET   /api/speech/tts/:id/voices        — live voice catalog (Polly, ElevenLabs)
 *   POST  /api/speech/stt/:id/test          — real transcription of a probe clip
 *   POST  /api/speech/tts/:id/test          — real synthesis, returns the audio
 *   GET   /api/speech/server/status         — container runtime + image + health
 *   POST  /api/speech/server/setup          — pull + run + install models (background)
 *   GET   /api/speech/server/setup/:runId   — poll a setup run (WS-disconnect-safe)
 *   POST  /api/speech/server/stop           — stop (or remove) the managed container
 *   GET   /api/speech/server/logs           — container log tail
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getConfig,
  SPEECH_INPUT_PROVIDERS,
  SPEECH_OUTPUT_PROVIDERS,
  type SpeechInputProviderId,
  type SpeechOutputProviderId,
} from '../config.js';
import { childLogger } from '../log.js';
import { ScopeValuesSchema, visibleScopes } from '../providers/scopes.js';
import { friendlySpeechError } from '../providers/speech/errors.js';
import { LANGUAGES, supportedCatalogCodes } from '../providers/speech/languages.js';
import {
  getSpeechServerLogs,
  getSpeechServerStatus,
  setupSpeechServer,
  stopSpeechServer,
  type SpeechSetupProgressEvent,
  type SpeechSetupResult,
} from '../providers/speech/serverSetup.js';
import { probePcm16 } from '../providers/speech/wav.js';
import {
  getSpeechInputVendor,
  listSpeechInputVendors,
  speechInputChain,
  speechInputLanguages,
} from '../providers/speech/input/orchestrator.js';
import {
  resolveSpeechInputModel,
  resolveSpeechInputScopes,
  speechInputScopeDefs,
  transcribeWith,
} from '../providers/speech/input/service.js';
import { speechInputSettings } from '../providers/speech/input/settings.js';
import {
  getSpeechOutputVendor,
  listSpeechOutputVendors,
  speechOutputChain,
  speechOutputLanguages,
} from '../providers/speech/output/orchestrator.js';
import {
  listVoices,
  resolveSpeechOutputModel,
  resolveSpeechOutputScopes,
  resolveSpeechOutputVoice,
  speechOutputLanguage,
  speechOutputScopeDefs,
  speechOutputSettings,
  synthesizeWith,
} from '../providers/speech/output/service.js';
import { pushToPhone } from '../state/controlSocket.js';
import { readConfigFile, writeConfigFile } from '../state/configFile.js';
import { getSpeechKeyStatus, updateSpeechEnvKeys } from '../state/envFile.js';

const log = childLogger('routes:speech');

// ── Setup runs (in-memory; they need not survive a bridge restart) ──────────

interface SetupRun {
  runId: string;
  events: SpeechSetupProgressEvent[];
  done: boolean;
  result?: SpeechSetupResult;
  startedAt: number;
}

const runs = new Map<string, SetupRun>();
const MAX_RUNS = 10;
/** Only one pull/run/download at a time — concurrent setups fight over the container. */
let activeRunId: string | null = null;

function pruneOldRuns(): void {
  if (runs.size <= MAX_RUNS) return;
  const sorted = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const run of sorted.slice(0, runs.size - MAX_RUNS)) runs.delete(run.runId);
}

// ── Validation ─────────────────────────────────────────────────────────────

const InputParam = z.object({ id: z.enum(SPEECH_INPUT_PROVIDERS) });
const OutputParam = z.object({ id: z.enum(SPEECH_OUTPUT_PROVIDERS) });

const ServerPatchSchema = z
  .object({
    manage: z.enum(['container', 'external']).optional(),
    runtime: z.enum(['auto', 'docker', 'podman']).optional(),
    image: z.string().min(1).max(256).optional(),
    containerName: z.string().min(1).max(64).optional(),
    port: z.number().int().min(1024).max(65535).optional(),
    containerPort: z.number().int().min(1).max(65535).optional(),
    baseUrl: z.string().url().optional().or(z.literal('')),
    apiPath: z.string().min(1).max(128).optional(),
    gpu: z.boolean().optional(),
    modelVolume: z.string().min(1).max(64).optional(),
    modelCachePath: z.string().min(1).max(256).optional(),
  })
  .strict();

const InputPatchSchema = z
  .object({
    provider: z.enum(SPEECH_INPUT_PROVIDERS).optional(),
    fallbacks: z.array(z.enum(SPEECH_INPUT_PROVIDERS)).max(8).optional(),
    language: z.string().min(2).max(16).optional(),
    /** Model/scopes apply to `scopeProvider`, defaulting to the one being set. */
    model: z.string().min(1).max(200).optional(),
    scopes: ScopeValuesSchema.optional(),
    scopeProvider: z.enum(SPEECH_INPUT_PROVIDERS).optional(),
    server: ServerPatchSchema.optional(),
  })
  .strict();

const OutputPatchSchema = z
  .object({
    provider: z.enum(SPEECH_OUTPUT_PROVIDERS).optional(),
    fallbacks: z.array(z.enum(SPEECH_OUTPUT_PROVIDERS)).max(8).optional(),
    language: z.string().min(2).max(16).optional(),
    model: z.string().min(1).max(200).optional(),
    voice: z.string().min(1).max(200).optional(),
    scopes: ScopeValuesSchema.optional(),
    scopeProvider: z.enum(SPEECH_OUTPUT_PROVIDERS).optional(),
    server: ServerPatchSchema.optional(),
  })
  .strict();

const KeysPatchSchema = z.record(z.string(), z.string());
const InputTestSchema = z.object({ model: z.string().min(1).max(200).optional() }).strict().optional();
const OutputTestSchema = z
  .object({
    model: z.string().min(1).max(200).optional(),
    voice: z.string().min(1).max(200).optional(),
    text: z.string().min(1).max(500).optional(),
  })
  .strict()
  .optional();
const StopBodySchema = z.object({ remove: z.boolean().default(false) }).strict().optional();

// ── Serialization ──────────────────────────────────────────────────────────

/** `browser` has no server-side implementation; the UI still needs a card for it. */
const BROWSER_INPUT_CARD = {
  id: 'browser' as const,
  displayName: 'Browser (on device)',
  description:
    'The phone transcribes locally with SpeechRecognition. Free and lowest latency, but weakest on technical vocabulary — and unavailable in a standalone iOS PWA.',
  capabilities: {
    kind: 'device' as const,
    apiKeyEnvVar: null,
    languages: 'all' as const,
    languageHint: true,
    sendsAudioOffMachine: false,
    approxUsdPerAudioHour: null,
    docsUrl: 'https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition',
  },
  models: [],
  defaultModel: '',
  selectedModel: '',
  scopes: [],
  scopeValues: {},
  languages: [] as string[],
  keyStatus: null,
  configured: true,
  available: true,
};

const BROWSER_OUTPUT_CARD = {
  id: 'browser' as const,
  displayName: 'Browser (on device)',
  description:
    'The phone speaks with its own speechSynthesis voices. Free and instant, but the voice set depends on the device and iOS standalone PWAs cannot use it reliably.',
  capabilities: {
    kind: 'device' as const,
    apiKeyEnvVar: null,
    languages: 'all' as const,
    sendsTextOffMachine: false,
    approxUsdPerMillionChars: null,
    docsUrl: 'https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis',
  },
  models: [],
  defaultModel: '',
  selectedModel: '',
  voices: [],
  defaultVoice: '',
  selectedVoice: '',
  scopes: [],
  scopeValues: {},
  languages: [] as string[],
  keyStatus: null,
  configured: true,
  available: true,
};

async function describeInputProviders() {
  const env = process.env as Record<string, string | undefined>;
  const keyStatus = new Map(getSpeechKeyStatus(env).map((k) => [k.envVar, k]));
  const settings = speechInputSettings();

  const servers = await Promise.all(
    listSpeechInputVendors().map(async (vendor) => {
      let availability;
      try {
        availability = vendor.checkAvailability
          ? await vendor.checkAvailability()
          : {
              available: vendor.isConfigured(),
              ...(vendor.unconfiguredDetail ? { detail: vendor.unconfiguredDetail } : {}),
            };
      } catch (err) {
        availability = { available: false, detail: err instanceof Error ? err.message : String(err) };
      }

      const model = resolveSpeechInputModel(vendor.id, settings);
      const scopeValues = resolveSpeechInputScopes(vendor.id, settings, model);
      const envVar = vendor.capabilities.apiKeyEnvVar;

      return {
        id: vendor.id,
        displayName: vendor.displayName,
        description: vendor.description,
        capabilities: vendor.capabilities,
        models: vendor.models,
        defaultModel: vendor.defaultModel,
        selectedModel: model,
        scopes: visibleScopes(speechInputScopeDefs(vendor.id, model), scopeValues),
        scopeValues,
        languages: supportedCatalogCodes(speechInputLanguages(vendor.id, model)),
        keyStatus: envVar ? (keyStatus.get(envVar) ?? null) : null,
        configured: vendor.isConfigured(),
        ...availability,
      };
    }),
  );

  return [BROWSER_INPUT_CARD, ...servers];
}

async function describeOutputProviders() {
  const env = process.env as Record<string, string | undefined>;
  const keyStatus = new Map(getSpeechKeyStatus(env).map((k) => [k.envVar, k]));
  const settings = speechOutputSettings();

  const servers = await Promise.all(
    listSpeechOutputVendors().map(async (vendor) => {
      let availability;
      try {
        availability = vendor.checkAvailability
          ? await vendor.checkAvailability()
          : {
              available: vendor.isConfigured(),
              ...(vendor.unconfiguredDetail ? { detail: vendor.unconfiguredDetail } : {}),
            };
      } catch (err) {
        availability = { available: false, detail: err instanceof Error ? err.message : String(err) };
      }

      const model = resolveSpeechOutputModel(vendor.id, settings);
      const voice = resolveSpeechOutputVoice(vendor.id, settings, model);
      const scopeValues = resolveSpeechOutputScopes(vendor.id, settings, model);
      const envVar = vendor.capabilities.apiKeyEnvVar;

      return {
        id: vendor.id,
        displayName: vendor.displayName,
        description: vendor.description,
        capabilities: vendor.capabilities,
        models: vendor.models,
        defaultModel: vendor.defaultModel,
        selectedModel: model,
        // The static catalog; live catalogs are fetched on demand per vendor.
        voices: vendor.voices(model),
        defaultVoice: vendor.defaultVoice(model),
        selectedVoice: voice,
        scopes: visibleScopes(speechOutputScopeDefs(vendor.id, model), scopeValues),
        scopeValues,
        // What the provider *could* speak with this model — the orchestrator
        // will swap to a matching voice where the vendor supports it, so
        // reporting the current voice's range here would warn about languages
        // that actually work.
        languages: supportedCatalogCodes(speechOutputLanguages(vendor.id, model)),
        /** The selected voice's own range, for the "this voice is English-only" hint. */
        voiceLanguages: supportedCatalogCodes(speechOutputLanguages(vendor.id, model, voice)),
        keyStatus: envVar ? (keyStatus.get(envVar) ?? null) : null,
        configured: vendor.isConfigured(),
        ...availability,
      };
    }),
  );

  return [BROWSER_OUTPUT_CARD, ...servers];
}

async function speechView() {
  const { audio } = getConfig().settings.workflow.llmIntelligence;
  const [inputProviders, outputProviders] = await Promise.all([
    describeInputProviders(),
    describeOutputProviders(),
  ]);

  return {
    languages: LANGUAGES,
    stt: {
      provider: audio.stt.provider,
      fallbacks: audio.stt.fallbacks,
      language: audio.stt.language,
      /** Server-side chain actually walked at request time, browser removed. */
      chain: speechInputChain(),
      providers: inputProviders,
    },
    tts: {
      provider: audio.tts.provider,
      fallbacks: audio.tts.fallbacks,
      language: audio.tts.language,
      /** What `auto` resolves to right now (it follows the speech-in language). */
      effectiveLanguage: speechOutputLanguage() ?? 'auto',
      chain: speechOutputChain(),
      providers: outputProviders,
    },
    server: audio.speechServer,
  };
}

function applyServerPatch(
  server: Record<string, unknown>,
  patch: z.infer<typeof ServerPatchSchema>,
): void {
  const { baseUrl, ...rest } = patch;
  Object.assign(server, rest);
  // '' clears the override and goes back to the derived 127.0.0.1:port URL.
  if (baseUrl !== undefined) {
    if (baseUrl) server['baseUrl'] = baseUrl;
    else delete server['baseUrl'];
  }
}

export async function registerSpeechProviderRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/speech — everything both pickers need in one round trip. */
  app.get('/api/speech', async () => speechView());

  /** PATCH /api/speech/stt */
  app.patch<{ Body: unknown }>('/api/speech/stt', async (req, reply) => {
    const parsed = InputPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const patch = parsed.data;
    const cfg = readConfigFile();
    const audio = cfg.settings.workflow.llmIntelligence.audio;
    const stt = audio.stt;
    const target: SpeechInputProviderId = patch.scopeProvider ?? patch.provider ?? stt.provider;

    if (patch.provider !== undefined) stt.provider = patch.provider;
    if (patch.fallbacks !== undefined) {
      // A provider cannot be its own fallback — that is a silent no-op at best.
      stt.fallbacks = patch.fallbacks.filter((id) => id !== stt.provider);
    }
    if (patch.language !== undefined) stt.language = patch.language.trim() || 'auto';
    if (patch.model !== undefined) stt.models = { ...stt.models, [target]: patch.model.trim() };
    if (patch.scopes !== undefined) stt.scopes = { ...stt.scopes, [target]: patch.scopes };
    if (patch.server) applyServerPatch(audio.speechServer, patch.server);

    if (audio.speechServer.manage === 'external' && !audio.speechServer.baseUrl) {
      return reply
        .code(400)
        .send({ error: 'An external speech server needs a base URL (e.g. http://192.168.1.10:8000)' });
    }

    writeConfigFile(cfg);
    log.info({ provider: stt.provider, fallbacks: stt.fallbacks, language: stt.language }, 'speech input updated');
    return { ok: true, ...(await speechView()) };
  });

  /** PATCH /api/speech/tts */
  app.patch<{ Body: unknown }>('/api/speech/tts', async (req, reply) => {
    const parsed = OutputPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const patch = parsed.data;
    const cfg = readConfigFile();
    const audio = cfg.settings.workflow.llmIntelligence.audio;
    const tts = audio.tts;
    const target: SpeechOutputProviderId = patch.scopeProvider ?? patch.provider ?? tts.provider;

    if (patch.provider !== undefined) tts.provider = patch.provider;
    if (patch.fallbacks !== undefined) {
      tts.fallbacks = patch.fallbacks.filter((id) => id !== tts.provider);
    }
    if (patch.language !== undefined) tts.language = patch.language.trim() || 'auto';
    if (patch.model !== undefined) tts.models = { ...tts.models, [target]: patch.model.trim() };
    if (patch.voice !== undefined) tts.voices = { ...tts.voices, [target]: patch.voice.trim() };
    if (patch.scopes !== undefined) tts.scopes = { ...tts.scopes, [target]: patch.scopes };
    if (patch.server) applyServerPatch(audio.speechServer, patch.server);

    writeConfigFile(cfg);
    log.info({ provider: tts.provider, fallbacks: tts.fallbacks, language: tts.language }, 'speech output updated');
    return { ok: true, ...(await speechView()) };
  });

  /** PATCH /api/speech/keys — write provider keys to .env; never read back. */
  app.patch<{ Body: unknown }>('/api/speech/keys', async (req, reply) => {
    const parsed = KeysPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    try {
      updateSpeechEnvKeys(parsed.data);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return { ok: true, ...(await speechView()) };
  });

  /** GET /api/speech/tts/:id/voices — live catalog for providers that have one. */
  app.get<{ Params: { id: string }; Querystring: { model?: string } }>(
    '/api/speech/tts/:id/voices',
    async (req, reply) => {
      const params = OutputParam.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.message });

      const vendor = getSpeechOutputVendor(params.data.id);
      if (!vendor) return { provider: params.data.id, live: false, voices: [] };

      const model = req.query.model?.trim() || resolveSpeechOutputModel(vendor.id);
      try {
        return { provider: vendor.id, model, ...(await listVoices(vendor.id, model)) };
      } catch (err) {
        // A live catalog failure should not empty the picker — fall back to static.
        return {
          provider: vendor.id,
          model,
          live: false,
          voices: vendor.voices(model),
          error: friendlySpeechError(err, vendor.displayName, 'output'),
        };
      }
    },
  );

  /**
   * POST /api/speech/stt/:id/test — transcribe a 600 ms probe clip.
   *
   * A real round trip rather than an auth-only ping: it proves the key, the
   * model id, and the network path all work. The probe has no speech, so an
   * empty transcript is the expected success case.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/speech/stt/:id/test',
    async (req, reply) => {
      const params = InputParam.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.message });
      const body = InputTestSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.message });

      const vendor = getSpeechInputVendor(params.data.id);
      if (!vendor) {
        return {
          ok: true,
          provider: params.data.id,
          model: '',
          latencyMs: 0,
          note: 'Runs on the phone — nothing to test here.',
        };
      }

      const settings = speechInputSettings();
      const model = body.data?.model?.trim() || resolveSpeechInputModel(vendor.id, settings);
      const started = Date.now();

      const availability = vendor.checkAvailability
        ? await vendor.checkAvailability()
        : { available: vendor.isConfigured(), detail: vendor.unconfiguredDetail };
      if (!availability.available) {
        return {
          ok: false,
          provider: vendor.id,
          model,
          latencyMs: 0,
          error: availability.detail ?? 'Not configured',
        };
      }

      try {
        const { text } = await transcribeWith(vendor.id, probePcm16(), {
          model,
          ...(settings.language === 'auto' ? {} : { language: settings.language }),
        });
        log.info({ provider: vendor.id, model, latencyMs: Date.now() - started }, 'stt test ok');
        return { ok: true, provider: vendor.id, model, latencyMs: Date.now() - started, transcript: text };
      } catch (err) {
        log.warn({ provider: vendor.id, model, err }, 'stt test failed');
        return {
          ok: false,
          provider: vendor.id,
          model,
          latencyMs: Date.now() - started,
          error: friendlySpeechError(err, vendor.displayName, 'input'),
        };
      }
    },
  );

  /** POST /api/speech/tts/:id/test — synthesize a sample line and return the audio. */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/speech/tts/:id/test',
    async (req, reply) => {
      const params = OutputParam.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.message });
      const body = OutputTestSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.message });

      const vendor = getSpeechOutputVendor(params.data.id);
      if (!vendor) {
        return reply.code(400).send({ error: 'The browser voice is previewed on the device, not here.' });
      }

      const settings = speechOutputSettings();
      const model = body.data?.model?.trim() || resolveSpeechOutputModel(vendor.id, settings);
      const voice = body.data?.voice?.trim() || resolveSpeechOutputVoice(vendor.id, settings, model);

      const availability = vendor.checkAvailability
        ? await vendor.checkAvailability()
        : { available: vendor.isConfigured(), detail: vendor.unconfiguredDetail };
      if (!availability.available) {
        return reply.code(503).send({ error: availability.detail ?? 'Not configured' });
      }

      try {
        const spoken = await synthesizeWith(
          vendor.id,
          body.data?.text?.trim() ||
            'This is the AgentVoice preview. Speaking a file path: src slash providers slash speech.',
          { model, voice },
        );
        return reply
          .header('Content-Type', spoken.contentType)
          .header('X-Speech-Provider', vendor.id)
          .header('X-Speech-Voice', spoken.voice)
          .send(spoken.audio);
      } catch (err) {
        log.warn({ provider: vendor.id, model, voice, err }, 'tts test failed');
        return reply.code(502).send({ error: friendlySpeechError(err, vendor.displayName, 'output') });
      }
    },
  );

  // ── Self-hosted speech server ────────────────────────────────────────────

  app.get('/api/speech/server/status', async () => {
    return { ...(await getSpeechServerStatus()), setupRunning: activeRunId !== null, setupRunId: activeRunId };
  });

  app.post('/api/speech/server/setup', async (_req, reply) => {
    if (activeRunId) {
      return reply.code(409).send({ error: 'A setup run is already in progress', runId: activeRunId });
    }

    const runId = randomUUID();
    const run: SetupRun = { runId, events: [], done: false, startedAt: Date.now() };
    runs.set(runId, run);
    activeRunId = runId;
    pruneOldRuns();

    const onProgress = (event: SpeechSetupProgressEvent) => {
      run.events.push(event);
      if (event.done) run.done = true;
      pushToPhone({ type: 'speech_setup_progress', runId, ...event });
    };

    // Image pulls and model downloads run for minutes — never hold the request.
    void setupSpeechServer(onProgress)
      .then((result) => {
        run.result = result;
        run.done = true;
        log.info({ ok: result.ok }, 'speech server setup finished');
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        run.result = { ok: false, detail: message, serverUrl: null };
        run.done = true;
        run.events.push({ message, done: true, error: message });
        pushToPhone({ type: 'speech_setup_progress', runId, message, done: true, error: message });
        log.error({ err: message }, 'speech server setup threw');
      })
      .finally(() => {
        if (activeRunId === runId) activeRunId = null;
      });

    return reply.code(202).send({ runId });
  });

  app.get<{ Params: { runId: string } }>('/api/speech/server/setup/:runId', async (req, reply) => {
    const run = runs.get(req.params.runId);
    if (!run) return reply.code(404).send({ error: 'Unknown or expired setup run' });
    return { runId: run.runId, events: run.events, done: run.done, result: run.result };
  });

  app.post<{ Body: unknown }>('/api/speech/server/stop', async (req, reply) => {
    const parsed = StopBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const result = await stopSpeechServer(parsed.data?.remove ?? false);
    log.info({ remove: parsed.data?.remove ?? false, ok: result.ok }, 'speech server stop');
    return { ...result, status: await getSpeechServerStatus() };
  });

  app.get<{ Querystring: { lines?: string } }>('/api/speech/server/logs', async (req) => {
    const lines = Math.min(Math.max(Number(req.query.lines) || 80, 10), 500);
    return { lines, text: await getSpeechServerLogs(lines) };
  });
}
