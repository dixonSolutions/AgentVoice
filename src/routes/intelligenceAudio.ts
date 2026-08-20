/**
 * The two audio endpoints the phone actually calls during a voice session:
 * transcribe a turn, and speak a reply.
 *
 * Both route through their provider chain (src/providers/speech/), so which
 * engine answers is a settings question, not a code question. Provider
 * selection, keys, scopes, and the self-hosted container live in
 * src/routes/speechProviders.ts.
 *
 * Security: all /api/* routes require Bearer APP_TOKEN (see server preHandler).
 */

import type { FastifyInstance } from 'fastify';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';
import { friendlySpeechError } from '../providers/speech/errors.js';
import { getSpeechInputSpecializer } from '../providers/speech/input/orchestrator.js';
import {
  describeSpeechInputChain,
  hasServerSpeechInput,
  primaryServerSpeechInputId,
  transcribe,
} from '../providers/speech/input/service.js';
import { getSpeechOutputSpecializer } from '../providers/speech/output/orchestrator.js';
import {
  describeSpeechOutputChain,
  hasServerSpeechOutput,
  primaryServerSpeechOutputId,
  speechOutputLanguage,
  synthesize,
} from '../providers/speech/output/service.js';

const log = childLogger('api:intelligence-audio');

function providerLabel(id: string | null, direction: 'input' | 'output'): string | null {
  if (!id) return null;
  const specializer =
    direction === 'input'
      ? getSpeechInputSpecializer(id as never)
      : getSpeechOutputSpecializer(id as never);
  return specializer?.displayName ?? id;
}

export async function registerIntelligenceAudioRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/intelligence/audio — what the PWA needs to pick its backends.
   *
   * The phone only needs to know whether the bridge can answer and what to call
   * it; which of the eight engines actually runs is decided here per request.
   */
  app.get('/api/intelligence/audio', async () => {
    const { audio } = getConfig().settings.workflow.llmIntelligence;
    const sttId = primaryServerSpeechInputId();
    const ttsId = primaryServerSpeechOutputId();

    return {
      sttProvider: audio.stt.provider,
      sttFallback: sttId,
      sttProviderLabel: providerLabel(sttId, 'input'),
      sttAvailable: hasServerSpeechInput(),
      sttLanguage: audio.stt.language,
      sttChain: describeSpeechInputChain(),

      ttsProvider: audio.tts.provider,
      ttsFallback: ttsId,
      ttsProviderLabel: providerLabel(ttsId, 'output'),
      ttsAvailable: hasServerSpeechOutput(),
      ttsLanguage: speechOutputLanguage() ?? 'auto',
      ttsChain: describeSpeechOutputChain(),
    };
  });

  /** POST /api/intelligence/tts { text, language? } → audio the phone can play. */
  app.post<{ Body: { text?: string; language?: string } }>(
    '/api/intelligence/tts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 4000 },
            language: { type: 'string', minLength: 2, maxLength: 16 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!hasServerSpeechOutput()) {
        return reply
          .code(503)
          .send({ error: 'No text-to-speech provider is configured — pick one in Config → Speech' });
      }

      const startedAt = Date.now();
      try {
        const spoken = await synthesize(req.body.text ?? '', {
          ...(req.body.language ? { language: req.body.language } : {}),
        });
        log.info(
          {
            provider: spoken.provider,
            voice: spoken.voice,
            bytes: spoken.audio.length,
            latencyMs: Date.now() - startedAt,
            ...(spoken.skipped.length ? { skipped: spoken.skipped } : {}),
          },
          'tts ok',
        );
        return reply
          .header('Content-Type', spoken.contentType)
          // The phone shows which engine spoke, so a silent fallback is visible.
          .header('X-Speech-Provider', spoken.provider)
          .header('X-Speech-Voice', spoken.voice)
          .send(spoken.audio);
      } catch (err) {
        const label = providerLabel(primaryServerSpeechOutputId(), 'output') ?? 'Text-to-speech';
        const message = friendlySpeechError(err, label, 'output');
        log.error({ err, message }, 'tts failed');
        return reply.code(502).send({ error: message });
      }
    },
  );

  /**
   * POST /api/intelligence/transcribe
   * Body: raw PCM16LE octet-stream (preferred) or JSON `{ pcm: base64 }` (legacy).
   */
  app.post('/api/intelligence/transcribe', async (req, reply) => {
    if (!hasServerSpeechInput()) {
      return reply
        .code(503)
        .send({ error: 'No speech-to-text provider is configured — pick one in Config → Speech' });
    }

    let pcm: Buffer;
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    try {
      if (contentType.includes('application/octet-stream')) {
        const raw = req.body;
        if (Buffer.isBuffer(raw)) {
          pcm = raw;
        } else if (raw instanceof Uint8Array) {
          pcm = Buffer.from(raw);
        } else if (typeof raw === 'string') {
          pcm = Buffer.from(raw, 'binary');
        } else {
          return reply.code(400).send({ error: 'Expected raw PCM16LE body' });
        }
      } else {
        const body = req.body as { pcm?: string } | null;
        if (!body?.pcm || typeof body.pcm !== 'string') {
          return reply.code(400).send({ error: 'Missing pcm (send octet-stream or JSON { pcm: base64 })' });
        }
        pcm = Buffer.from(body.pcm, 'base64');
      }
    } catch {
      return reply.code(400).send({ error: 'Invalid PCM payload' });
    }

    if (pcm.length < 2) {
      return reply.code(400).send({ error: 'PCM payload too short' });
    }

    const startedAt = Date.now();
    try {
      const result = await transcribe(pcm);
      if (!result.text) {
        log.warn({ pcmBytes: pcm.length, provider: result.provider }, 'transcribe returned empty transcript');
        return reply.code(422).send({
          error: 'No speech detected — speak louder or closer to the mic and try again.',
        });
      }
      log.info(
        {
          pcmBytes: pcm.length,
          textLen: result.text.length,
          provider: result.provider,
          model: result.model,
          latencyMs: Date.now() - startedAt,
          ...(result.skipped.length ? { skipped: result.skipped } : {}),
        },
        'transcribe ok',
      );
      return { text: result.text, provider: result.provider, model: result.model };
    } catch (err) {
      const label = providerLabel(primaryServerSpeechInputId(), 'input') ?? 'Transcription';
      const message = friendlySpeechError(err, label, 'input');
      log.error({ err, pcmBytes: pcm.length, message }, 'transcribe failed');
      return reply.code(500).send({ error: message });
    }
  });
}
