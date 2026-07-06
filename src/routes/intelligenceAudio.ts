/**
 * HTTP routes for intelligence audio fallbacks (Polly TTS, Transcribe STT).
 *
 * Security: all /api/* routes require Bearer APP_TOKEN (see server preHandler).
 */

import type { FastifyInstance } from 'fastify';
import { isAmazonAudioAvailable } from '../intelligence/audio/awsClient.js';
import { synthesizePollyMp3 } from '../intelligence/audio/polly.js';
import { transcribePcm16 } from '../intelligence/audio/transcribe.js';
import { friendlyTranscribeError } from '../intelligence/audio/transcribeErrors.js';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';

const log = childLogger('api:intelligence-audio');

export async function registerIntelligenceAudioRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/intelligence/audio — capabilities for the PWA. */
  app.get('/api/intelligence/audio', async () => {
    const { audio } = getConfig().settings.workflow.llmIntelligence;
    const amazonAvailable = isAmazonAudioAvailable();
    return {
      preferWebkit: audio.preferWebkit,
      amazonAvailable,
      sttFallback: amazonAvailable ? 'amazon_transcribe' : null,
      ttsFallback: amazonAvailable ? 'amazon_polly' : null,
      pollyVoiceId: audio.pollyVoiceId,
      transcribeLanguageCode: audio.transcribeLanguageCode,
    };
  });

  /** POST /api/intelligence/tts { text } → MP3 audio. */
  app.post<{ Body: { text?: string } }>(
    '/api/intelligence/tts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          properties: { text: { type: 'string', minLength: 1, maxLength: 3000 } },
        },
      },
    },
    async (req, reply) => {
      if (!isAmazonAudioAvailable()) {
        return reply.code(503).send({ error: 'Amazon Polly not configured — set IAM keys in .env' });
      }
      const { audio, contentType } = await synthesizePollyMp3(req.body.text ?? '');
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
