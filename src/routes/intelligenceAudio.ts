/**
 * HTTP routes for intelligence audio fallbacks (Polly TTS, Transcribe STT).
 *
 * Security: all /api/* routes require Bearer APP_TOKEN (see server preHandler).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAmazonAudioAvailable } from '../intelligence/audio/awsClient.js';
import { listPollyVoices, synthesizePollyMp3 } from '../intelligence/audio/polly.js';
import { TRANSCRIBE_MODELS, transcribePcm16 } from '../intelligence/audio/transcribe.js';
import { friendlyTranscribeError } from '../intelligence/audio/transcribeErrors.js';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';

const log = childLogger('api:intelligence-audio');

const PollyVoicesQuerySchema = z.object({
  engine: z.enum(['standard', 'neural', 'generative']).optional(),
});

export async function registerIntelligenceAudioRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/intelligence/audio — capabilities for the PWA. */
  app.get('/api/intelligence/audio', async () => {
    const { audio } = getConfig().settings.workflow.llmIntelligence;
    const amazonAvailable = isAmazonAudioAvailable();
    return {
      preferWebkit: audio.preferWebkit,
      ttsProvider: audio.ttsProvider,
      amazonAvailable,
      sttFallback: amazonAvailable ? 'amazon_transcribe' : null,
      ttsFallback: amazonAvailable ? 'amazon_polly' : null,
      pollyVoiceId: audio.pollyVoiceId,
      pollyEngine: audio.pollyEngine,
      transcribeModel: audio.transcribeModel,
      transcribeLanguageMode: audio.transcribeLanguageMode,
      transcribeLanguageCode: audio.transcribeLanguageCode,
      transcribeLanguageOptions: audio.transcribeLanguageOptions,
      transcribePreferredLanguage: audio.transcribePreferredLanguage ?? audio.transcribeLanguageCode,
      transcribePartialResultsStabilization: audio.transcribePartialResultsStabilization,
      transcribePartialResultsStability: audio.transcribePartialResultsStability,
    };
  });

  /** GET /api/intelligence/transcribe-models — curated STT catalog (SFM only). */
  app.get('/api/intelligence/transcribe-models', async () => {
    return {
      models: TRANSCRIBE_MODELS,
      note:
        'Amazon Transcribe Speech Foundation Model powers StartStreamTranscription. Bedrock has no native real-time STT.',
    };
  });

  /** GET /api/intelligence/polly-voices?engine=neural — DescribeVoices catalog. */
  app.get<{ Querystring: { engine?: string } }>(
    '/api/intelligence/polly-voices',
    async (req, reply) => {
      const parsed = PollyVoicesQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      if (!isAmazonAudioAvailable()) {
        return reply
          .code(503)
          .send({ error: 'Amazon Polly not configured — set IAM keys in .env', voices: [] });
      }
      const { audio } = getConfig().settings.workflow.llmIntelligence;
      const engine = parsed.data.engine ?? audio.pollyEngine;
      try {
        const voices = await listPollyVoices(engine);
        return { engine, voices };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: message, voices: [] });
      }
    },
  );

  /** POST /api/intelligence/tts { text, voiceId?, engine? } → MP3 audio. */
  app.post<{ Body: { text?: string; voiceId?: string; engine?: string } }>(
    '/api/intelligence/tts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 3000 },
            voiceId: { type: 'string', minLength: 1, maxLength: 64 },
            engine: { type: 'string', enum: ['standard', 'neural', 'generative'] },
          },
        },
      },
    },
    async (req, reply) => {
      if (!isAmazonAudioAvailable()) {
        return reply.code(503).send({ error: 'Amazon Polly not configured — set IAM keys in .env' });
      }
      const engine =
        req.body.engine === 'standard' ||
        req.body.engine === 'neural' ||
        req.body.engine === 'generative'
          ? req.body.engine
          : undefined;
      const { audio, contentType } = await synthesizePollyMp3(req.body.text ?? '', {
        voiceId: req.body.voiceId,
        engine,
      });
      return reply.header('Content-Type', contentType).send(audio);
    },
  );

  /** POST /api/intelligence/transcribe { pcm: base64 } → { text }. */
  app.post<{ Body: { pcm?: string } }>(
    '/api/intelligence/transcribe',
    {
      schema: {
        body: {
          type: 'object',
          required: ['pcm'],
          properties: { pcm: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      if (!isAmazonAudioAvailable()) {
        return reply.code(503).send({ error: 'Amazon Transcribe not configured — set IAM keys in .env' });
      }

      let pcm: Buffer;
      try {
        pcm = Buffer.from(req.body.pcm ?? '', 'base64');
      } catch {
        return reply.code(400).send({ error: 'Invalid base64 PCM payload' });
      }

      log.info({ pcmBytes: pcm.length }, 'transcribe request');
      try {
        const text = await transcribePcm16(pcm);
        if (!text) {
          log.warn({ pcmBytes: pcm.length }, 'transcribe returned empty transcript');
          return reply.code(422).send({
            error: 'No speech detected — speak louder or closer to the mic and try again.',
          });
        }
        log.info({ pcmBytes: pcm.length, textLen: text.length }, 'transcribe ok');
        return { text };
      } catch (err) {
        const message = friendlyTranscribeError(err);
        log.error({ err, pcmBytes: pcm.length, message }, 'transcribe failed');
        return reply.code(500).send({ error: message });
      }
    },
  );
}
