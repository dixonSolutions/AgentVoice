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

import { Readable } from 'node:stream';
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
import type { PcmStream } from '../providers/speech/output/types.js';

const log = childLogger('api:intelligence-audio');

/** Content type of a streamed reply: headerless PCM16LE mono at `rate`. */
export function pcmContentType(rate: number): string {
  return `audio/pcm;rate=${rate};channels=1;bits=16`;
}

/** Pass the chunks on untouched, logging time to first audio and the total. */
async function* metered(
  pcm: PcmStream,
  info: { provider: string; voice: string; startedAt: number },
): AsyncGenerator<Buffer> {
  let bytes = 0;
  let firstAt = 0;
  try {
    for await (const chunk of pcm.chunks) {
      if (!firstAt) firstAt = Date.now();
      bytes += chunk.length;
      yield chunk;
    }
    log.info(
      {
        provider: info.provider,
        voice: info.voice,
        sampleRate: pcm.sampleRate,
        bytes,
        firstChunkMs: firstAt - info.startedAt,
        latencyMs: Date.now() - info.startedAt,
      },
      'tts streamed',
    );
  } catch (err) {
    log.warn({ err, provider: info.provider, bytes }, 'tts stream ended early');
    throw err;
  }
}

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

  /**
   * POST /api/intelligence/tts { text, language?, stream? } → audio the phone can play.
   *
   * With `stream: true` and a streaming vendor, the reply is `audio/pcm`
   * (rate in the content type and `X-Audio-Sample-Rate`), written chunk by
   * chunk as the vendor produces it, so the phone starts playing on the first
   * one. Otherwise — or from a bridge that predates `stream` — it is one file,
   * and the phone decodes it whole as before.
   */
  app.post<{ Body: { text?: string; language?: string; stream?: boolean } }>(
    '/api/intelligence/tts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 4000 },
            language: { type: 'string', minLength: 2, maxLength: 16 },
            stream: { type: 'boolean' },
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
      // The phone hangs up mid-line on barge-in; stop pulling from the vendor.
      const hangUp = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) hangUp.abort();
      });
      try {
        const spoken = await synthesize(req.body.text ?? '', {
          ...(req.body.language ? { language: req.body.language } : {}),
          ...(req.body.stream ? { stream: true } : {}),
          signal: hangUp.signal,
        });
        if (spoken.pcm) {
          return reply
            .header('Content-Type', pcmContentType(spoken.pcm.sampleRate))
            .header('X-Audio-Sample-Rate', String(spoken.pcm.sampleRate))
            .header('X-Speech-Provider', spoken.provider)
            .header('X-Speech-Voice', spoken.voice)
            // Nothing between here and the phone may hold chunks back.
            .header('Cache-Control', 'no-cache, no-transform')
            .header('X-Accel-Buffering', 'no')
            .send(Readable.from(metered(spoken.pcm, { provider: spoken.provider, voice: spoken.voice, startedAt })));
        }
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
