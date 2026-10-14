/**
 * /ws/stt — a turn's audio, uploaded while it is spoken.
 *
 * The phone used to buffer an utterance and POST it to
 * /api/intelligence/transcribe after the speaker stopped, so a long request
 * spent its upload time after the end of speech. Here the mic audio goes up in
 * the chunks the phone captures it in, as it captures them
 * (voice/sttUpload.ts): a live engine (Amazon Transcribe) hears it as it is
 * spoken, and every other engine gets the whole utterance the moment it ends,
 * with nothing left to upload. The POST route stays — it is the fallback when
 * this socket is unavailable, and what older phones use.
 *
 * Protocol (JSON text frames; audio is binary):
 *
 *   client → { type: "auth", token }                          first frame, always
 *   client → { type: "begin", id, sampleRate?: 16000, encoding?: "pcm_s16le", channels?: 1 }
 *   client → <binary>  PCM16LE mono 16 kHz for the current utterance, any chunk size
 *   client → { type: "end", id }       speaker stopped — transcribe it
 *   client → { type: "cancel", id }    drop it
 *   client → { type: "ping" }
 *
 *   bridge → { type: "auth_ok", live, stt }    live: the primary engine transcribes as you speak
 *   bridge → { type: "transcript", id, text, provider, model, live, latency_ms }
 *   bridge → { type: "error", id?, message, code? }   code "EMPTY" = no speech heard
 *   bridge → { type: "pong" }
 *
 * One utterance at a time: a new `begin` cancels one still open.
 */

import type { FastifyInstance } from 'fastify';
import { parseWsAuthMessage, verifyWsToken } from '../auth.js';
import { childLogger } from '../log.js';
import { friendlySpeechError } from '../providers/speech/errors.js';
import { getSpeechInputSpecializer, getSpeechInputVendor } from '../providers/speech/input/orchestrator.js';
import {
  hasServerSpeechInput,
  openLiveTranscription,
  primaryServerSpeechInputId,
  transcribe,
} from '../providers/speech/input/service.js';
import { Utterance, UtteranceTooLargeError } from '../voice/sttUpload.js';

const log = childLogger('api:stt-socket');

const WS_OPEN = 1;
const SAMPLE_RATE = 16_000;
const ENCODING = 'pcm_s16le';
/** Same ceiling as the POST upload (server.ts bodyLimit). */
const MAX_UTTERANCE_BYTES = 10 * 1024 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;

function sttLabel(): string {
  const id = primaryServerSpeechInputId();
  if (!id) return 'Transcription';
  return getSpeechInputSpecializer(id)?.displayName ?? id;
}

function primaryIsLive(): boolean {
  const id = primaryServerSpeechInputId();
  return Boolean(id && getSpeechInputVendor(id)?.capabilities.liveStreaming);
}

export function registerSttWebSocket(app: FastifyInstance): void {
  app.register(async (wsApp) => {
    wsApp.get('/ws/stt', { websocket: true }, (socket, req) => {
      let authenticated = false;
      let closed = false;
      let current: { id: string; utterance: Utterance } | null = null;
      /** Ended utterances still being transcribed — dropped on cancel or if the phone leaves. */
      const transcribing = new Map<string, Utterance>();

      const sendJson = (payload: unknown): void => {
        if (socket.readyState === WS_OPEN) socket.send(JSON.stringify(payload));
      };

      const cancelCurrent = (): void => {
        current?.utterance.cancel();
        current = null;
      };

      const begin = (msg: Record<string, unknown>): void => {
        cancelCurrent();
        const id = String(msg['id'] ?? '');
        const sampleRate = msg['sampleRate'] === undefined ? SAMPLE_RATE : Number(msg['sampleRate']);
        const encoding = msg['encoding'] === undefined ? ENCODING : String(msg['encoding']);
        const channels = msg['channels'] === undefined ? 1 : Number(msg['channels']);
        if (!id) {
          sendJson({ type: 'error', message: 'begin needs an id' });
          return;
        }
        if (sampleRate !== SAMPLE_RATE || encoding !== ENCODING || channels !== 1) {
          sendJson({ type: 'error', id, message: `Send ${ENCODING} mono at ${SAMPLE_RATE} Hz.` });
          return;
        }
        if (!hasServerSpeechInput()) {
          sendJson({ type: 'error', id, message: 'No speech-to-text provider is configured — pick one in Config → Speech' });
          return;
        }
        current = {
          id,
          utterance: new Utterance({
            openLive: openLiveTranscription,
            transcribe: async (pcm, signal) => {
              const result = await transcribe(pcm, { signal });
              return { text: result.text, provider: result.provider, model: result.model };
            },
            onLiveFailed: (err, provider) =>
              log.warn({ err, provider, id }, 'live transcription failed — transcribing the whole utterance'),
            maxBytes: MAX_UTTERANCE_BYTES,
          }),
        };
      };

      const end = (id: string): void => {
        const turn = current;
        if (!turn || turn.id !== id) {
          sendJson({ type: 'error', id, message: 'No speech captured for this utterance.' });
          return;
        }
        current = null;
        if (turn.utterance.receivedBytes < 2) {
          turn.utterance.cancel();
          sendJson({ type: 'error', id, message: 'PCM payload too short' });
          return;
        }
        transcribing.set(id, turn.utterance);
        void turn.utterance.end().finally(() => transcribing.delete(id)).then(
          (t) => {
            if (!t.text) {
              log.warn({ id, bytes: t.bytes, provider: t.provider }, 'stt upload: empty transcript');
              sendJson({
                type: 'error',
                id,
                code: 'EMPTY',
                message: 'No speech detected — speak louder or closer to the mic and try again.',
              });
              return;
            }
            log.info(
              { id, bytes: t.bytes, textLen: t.text.length, provider: t.provider, model: t.model, live: t.live, latencyMs: t.latencyMs },
              'stt upload transcribed',
            );
            sendJson({
              type: 'transcript',
              id,
              text: t.text,
              provider: t.provider,
              model: t.model,
              live: t.live,
              latency_ms: t.latencyMs,
            });
          },
          (err: unknown) => {
            if (closed || turn.utterance.isCancelled) return;
            const message = friendlySpeechError(err, sttLabel(), 'input');
            log.error({ err, id, message }, 'stt upload failed');
            sendJson({ type: 'error', id, message });
          },
        );
      };

      socket.on('message', (raw: Buffer, isBinary: boolean) => {
        if (closed) return;

        if (!authenticated) {
          if (isBinary || !verifyWsToken(parseWsAuthMessage(raw.toString('utf-8')))) {
            log.warn({ ip: req.ip }, 'stt socket auth failed');
            socket.close(4001, 'Unauthorized');
            return;
          }
          authenticated = true;
          sendJson({ type: 'auth_ok', live: primaryIsLive(), stt: sttLabel() });
          return;
        }

        if (isBinary) {
          if (!current) return;
          if (raw.length > MAX_FRAME_BYTES) {
            sendJson({ type: 'error', id: current.id, message: `Audio frame too large (${raw.length} bytes)` });
            cancelCurrent();
            return;
          }
          try {
            current.utterance.push(raw);
          } catch (err) {
            const message = err instanceof UtteranceTooLargeError ? err.message : String(err);
            sendJson({ type: 'error', id: current.id, message });
            cancelCurrent();
          }
          return;
        }

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString('utf-8')) as Record<string, unknown>;
        } catch {
          sendJson({ type: 'error', message: 'Invalid JSON' });
          return;
        }

        switch (msg['type']) {
          case 'begin':
            begin(msg);
            break;
          case 'end':
            end(String(msg['id'] ?? ''));
            break;
          case 'cancel': {
            const id = String(msg['id'] ?? '');
            if (!current || current.id === id) cancelCurrent();
            transcribing.get(id)?.cancel();
            break;
          }
          case 'ping':
            sendJson({ type: 'pong' });
            break;
          default:
            log.debug({ type: msg['type'] }, 'unhandled stt socket message');
        }
      });

      socket.on('close', () => {
        closed = true;
        cancelCurrent();
        for (const utterance of transcribing.values()) utterance.cancel();
        transcribing.clear();
      });

      socket.on('error', (err: Error) => {
        log.error({ err }, 'stt socket error');
      });
    });
  });
}
