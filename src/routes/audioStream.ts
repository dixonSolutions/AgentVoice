/**
 * /ws/audio-stream — pipe raw audio straight to the voice agent.
 *
 * The alternative to taking turns. Instead of wake phrase → VAD → one
 * transcript, a client streams PCM continuously; the bridge cuts it at natural
 * pauses (voice/audioStream/segmenter.ts), transcribes each segment through the
 * normal speech-to-text chain, and hands every transcript to the agent_native
 * voice agent the moment it lands (executor/agentTurns.ts, source "stream"). Turns remain the recommended mode — they
 * give the agent whole requests — but this is fully usable, and it is the only
 * way to talk to the agent from something that is not the PWA:
 *
 *   arecord -f S16_LE -r 16000 -c 1 -t raw | agentvoice pipe
 *   agentvoice pipe --mic
 *
 * Protocol (all JSON frames are text; audio frames are binary):
 *
 *   client → { type: "auth", token }                          first frame, always
 *   client → { type: "start", sampleRate: 16000, encoding: "pcm_s16le",
 *              channels: 1, client?: "cli" | "pwa", name?, listen?, segment? }
 *   client → <binary>  PCM16LE mono 16 kHz, any chunk size
 *   client → { type: "flush" }   cut the current segment now (push-to-talk release)
 *   client → { type: "end" }     no more audio — finish transcribing, reply "drained"
 *   client → { type: "ping" }
 *
 *   bridge → { type: "auth_ok" }
 *   bridge → { type: "ready", sampleRate, encoding, channels, segment, stt }
 *   bridge → { type: "segment", index, text, audio_ms, latency_ms, provider, delivered, delivery?, reason?, message? }
 *   bridge → { type: "segment_empty", index, audio_ms }
 *   bridge → { type: "drained", stats }
 *   bridge → { type: "error", message, fatal? }
 *   bridge → { type: "pong" }
 *
 * With `listen` (default true) the socket also registers as a voice session,
 * so it receives the agent's replies — `speak`, `thinking`, `turn_complete`,
 * `voice_agent_status` — exactly as the phone does, and the agent's voice
 * tools work with no phone connected at all. The PWA's own stream sets
 * `listen: false` because its /ws/intelligence socket already listens.
 */

import type { FastifyInstance } from 'fastify';
import { parseWsAuthMessage, verifyWsToken } from '../auth.js';
import { AudioStreamSettingsSchema, getConfig } from '../config.js';
import { childLogger } from '../log.js';
import { friendlySpeechError } from '../providers/speech/errors.js';
import { getSpeechInputSpecializer } from '../providers/speech/input/orchestrator.js';
import {
  hasServerSpeechInput,
  primaryServerSpeechInputId,
  transcribe,
} from '../providers/speech/input/service.js';
import { submitAgentNativeTurn, TurnError, type TurnDelivery } from '../executor/agentTurns.js';
import {
  broadcastToVoiceSessions,
  registerVoiceSession,
} from '../mcp/server/voiceToolHandlers.js';
import { recordTranscriptEvent } from '../logging/transcripts.js';
import { getPresence, type PresenceClient } from '../state/presence.js';
import { AudioStreamPipe } from '../voice/audioStream/pipe.js';

const log = childLogger('api:audio-stream');

/** The one format the pipe accepts; `agentvoice pipe` converts anything else. */
export const AUDIO_STREAM_SAMPLE_RATE = 16_000;
export const AUDIO_STREAM_ENCODING = 'pcm_s16le';

/** Largest single binary frame (~8 s of audio). Clients send 20–250 ms frames. */
const MAX_FRAME_BYTES = 256 * 1024;

const WS_OPEN = 1;

const SegmentOverridesSchema = AudioStreamSettingsSchema.partial();

function sttLabel(): string {
  const id = primaryServerSpeechInputId();
  if (!id) return 'none';
  return getSpeechInputSpecializer(id)?.displayName ?? id;
}

type StreamTurnOutcome =
  | { ok: true; delivery: TurnDelivery }
  | { ok: false; reason: TurnError['code'] | 'ERROR'; message: string };

/**
 * Hand one streamed segment to the voice agent — spawn it or queue for it —
 * through the same path as a phone turn, and tell every voice client what
 * happened the way the phone socket does.
 */
function deliverStreamTurn(text: string): StreamTurnOutcome {
  broadcastToVoiceSessions({ type: 'thinking', value: true });
  try {
    return { ok: true, delivery: submitAgentNativeTurn(text, { source: 'stream' }) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = err instanceof TurnError ? err.code : 'ERROR';
    broadcastToVoiceSessions({
      type: 'speak',
      text: reason === 'NO_PROJECT' ? 'No project is selected. Choose a project in the voice tab first.' : message,
    });
    if (reason !== 'NO_PROJECT') broadcastToVoiceSessions({ type: 'error', message });
    broadcastToVoiceSessions({ type: 'thinking', value: false });
    broadcastToVoiceSessions({ type: 'turn_complete' });
    log.warn({ reason, message }, 'streamed segment not delivered');
    return { ok: false, reason, message };
  }
}

export function registerAudioStreamWebSocket(app: FastifyInstance): void {
  app.register(async (wsApp) => {
    wsApp.get('/ws/audio-stream', { websocket: true }, (socket, req) => {
      let authenticated = false;
      let pipe: AudioStreamPipe | null = null;
      let unregisterVoice: (() => void) | null = null;
      let presence: PresenceClient | null = null;
      let clientName = 'audio pipe';
      let listening = false;
      let closed = false;
      const openedAt = Date.now();

      const sendJson = (payload: unknown): void => {
        if (socket.readyState === WS_OPEN) socket.send(JSON.stringify(payload));
      };

      const fail = (message: string, code = 4400): void => {
        log.warn({ ip: req.ip, message }, 'audio stream refused');
        sendJson({ type: 'error', message, fatal: true });
        socket.close(code, message.slice(0, 120));
      };

      const start = (msg: Record<string, unknown>): void => {
        if (pipe) return;
        const { settings } = getConfig();

        const sampleRate = msg['sampleRate'] === undefined ? AUDIO_STREAM_SAMPLE_RATE : Number(msg['sampleRate']);
        const encoding = msg['encoding'] === undefined ? AUDIO_STREAM_ENCODING : String(msg['encoding']);
        const channels = msg['channels'] === undefined ? 1 : Number(msg['channels']);
        if (sampleRate !== AUDIO_STREAM_SAMPLE_RATE || encoding !== AUDIO_STREAM_ENCODING || channels !== 1) {
          fail(
            `Send ${AUDIO_STREAM_ENCODING} mono at ${AUDIO_STREAM_SAMPLE_RATE} Hz ` +
              `(got ${encoding}, ${channels} ch, ${sampleRate} Hz) — \`agentvoice pipe\` converts WAV and other rates for you.`,
          );
          return;
        }
        if (settings.workflow.default !== 'agent_native') {
          fail(
            'The audio pipe feeds the agent_native voice agent — switch Config → Workflow to agent_native to use it.',
          );
          return;
        }
        if (!hasServerSpeechInput()) {
          fail(
            'No server speech-to-text provider is configured, and a streamed pipe cannot use browser STT — ' +
              'pick one in Config → Speech (e.g. the self-hosted Whisper container or Groq).',
            4503,
          );
          return;
        }

        const overrides = SegmentOverridesSchema.safeParse(msg['segment'] ?? {});
        const segment = { ...settings.voice.stream, ...(overrides.success ? overrides.data : {}) };

        const isPwa = msg['client'] === 'pwa';
        const rawName = typeof msg['name'] === 'string' ? msg['name'].trim().slice(0, 40) : '';
        clientName = rawName || (isPwa ? 'phone (stream)' : 'audio pipe');
        const listen = msg['listen'] !== false;
        listening = listen;

        if (listen) {
          unregisterVoice = registerVoiceSession(sendJson, clientName);
          // A listening pipe is someone talking to the agent — the away
          // policies (docs/36) must see them as present, not gone.
          presence = getPresence().register({
            kind: 'audio_pipe',
            close: (code, reason) => socket.close(code, reason),
          });
        } else {
          recordTranscriptEvent(`${clientName} started streaming`);
        }

        pipe = new AudioStreamPipe({
          segmenter: { sampleRate: AUDIO_STREAM_SAMPLE_RATE, ...segment },
          transcribe: async (pcm, signal) => {
            const result = await transcribe(pcm, { signal });
            return { text: result.text, provider: result.provider, model: result.model };
          },
          onTranscript: (t) => {
            const outcome = deliverStreamTurn(t.text);
            log.info(
              {
                client: clientName,
                index: t.index,
                audioMs: t.audioMs,
                latencyMs: t.latencyMs,
                provider: t.provider,
                merged: t.merged,
                reason: t.reason,
                textLen: t.text.length,
                delivered: outcome.ok,
              },
              'stream segment transcribed',
            );
            sendJson({
              type: 'segment',
              index: t.index,
              text: t.text,
              audio_ms: t.audioMs,
              latency_ms: t.latencyMs,
              provider: t.provider ?? null,
              merged: t.merged,
              delivered: outcome.ok,
              ...(outcome.ok
                ? { delivery: outcome.delivery.delivery }
                : { reason: outcome.reason, message: outcome.message }),
            });
          },
          onEmpty: ({ index, audioMs }) => {
            log.debug({ client: clientName, index, audioMs }, 'stream segment had no speech');
            sendJson({ type: 'segment_empty', index, audio_ms: audioMs });
          },
          onError: (err, { index, audioMs }) => {
            const message = friendlySpeechError(err, sttLabel(), 'input');
            log.error({ err, client: clientName, index, audioMs, message }, 'stream segment transcription failed');
            sendJson({ type: 'error', message, index });
          },
        });

        log.info(
          { client: clientName, listen, ip: req.ip, stt: sttLabel(), segment },
          'audio stream started',
        );
        sendJson({
          type: 'ready',
          sampleRate: AUDIO_STREAM_SAMPLE_RATE,
          encoding: AUDIO_STREAM_ENCODING,
          channels: 1,
          segment,
          stt: sttLabel(),
          listening: listen,
        });
      };

      socket.on('message', (raw: Buffer, isBinary: boolean) => {
        if (closed) return;
        presence?.alive();

        if (!authenticated) {
          if (isBinary || !verifyWsToken(parseWsAuthMessage(raw.toString('utf-8')))) {
            log.warn({ ip: req.ip }, 'audio stream auth failed');
            socket.close(4001, 'Unauthorized');
            return;
          }
          authenticated = true;
          sendJson({ type: 'auth_ok' });
          return;
        }

        if (isBinary) {
          if (raw.length > MAX_FRAME_BYTES) {
            fail(`Audio frame too large (${raw.length} bytes) — send chunks under ${MAX_FRAME_BYTES} bytes.`, 1009);
            return;
          }
          if (!pipe) start({});
          pipe?.push(raw);
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
          case 'start':
            start(msg);
            break;
          case 'flush':
            pipe?.flush();
            break;
          case 'end': {
            const current = pipe;
            if (!current) {
              sendJson({ type: 'drained', stats: null });
              break;
            }
            void current.drain().then(() => {
              sendJson({ type: 'drained', stats: current.getStats() });
            });
            break;
          }
          case 'ping':
            sendJson({ type: 'pong' });
            break;
          default:
            log.debug({ type: msg['type'] }, 'unhandled audio stream message');
        }
      });

      socket.on('close', () => {
        closed = true;
        const stats = pipe?.getStats();
        pipe?.close();
        pipe = null;
        unregisterVoice?.();
        unregisterVoice = null;
        presence?.release();
        presence = null;
        if (stats && !listening) recordTranscriptEvent(`${clientName} stopped streaming`);
        if (stats) {
          log.info(
            { client: clientName, durationMs: Date.now() - openedAt, ...stats },
            'audio stream closed',
          );
        }
      });

      socket.on('error', (err: Error) => {
        log.error({ err, client: clientName }, 'audio stream socket error');
      });
    });
  });
}
