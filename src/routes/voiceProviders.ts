/**
 * Voice settings API — wake words and turn-submit timing.
 *
 * Security:
 *   - All routes require app token (server preHandler).
 */

import type { FastifyInstance } from 'fastify';
import {
  getVoiceSettingsView,
  setWakeWords,
  setUserName,
  setVoiceTts,
  setVoiceUi,
} from '../voice/voiceSettingsRegistry.js';
import { childLogger } from '../log.js';

const log = childLogger('api:voice');

function handleError(err: unknown): { status: number; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const clientErrors = ['Invalid wake phrase', 'cannot be empty', 'Invalid on-screen', 'Provide touchControls'];
  const status = clientErrors.some((s) => message.includes(s)) ? 400 : 500;
  return { status, message };
}

export async function registerVoiceProviderRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/voice/providers — wake words + turn submit + on-screen controls. */
  app.get('/api/voice/providers', async () => getVoiceSettingsView());

  /** PATCH /api/voice/wake-words { start, end?, silenceMs?, vadEnabled? } */
  app.patch<{ Body: { start: string } }>(
    '/api/voice/wake-words',
    async (req, reply) => {
      try {
        return setWakeWords(req.body);
      } catch (err) {
        const { status, message } = handleError(err);
        log.warn({ err }, 'update wake words failed');
        return reply.code(status).send({ error: message });
      }
    },
  );

  /** PATCH /api/voice/user-name { userName: string | null } */
  app.patch<{ Body: { userName?: string | null } }>(
    '/api/voice/user-name',
    async (req, reply) => {
      try {
        return setUserName(req.body);
      } catch (err) {
        const { status, message } = handleError(err);
        log.warn({ err }, 'update userName failed');
        return reply.code(status).send({ error: message });
      }
    },
  );

  /** PATCH /api/voice/tts — agent voice on/off, error feedback, WebKit defaults */
  app.patch('/api/voice/tts', async (req, reply) => {
    try {
      return setVoiceTts(req.body);
    } catch (err) {
      const { status, message } = handleError(err);
      log.warn({ err }, 'update voice TTS failed');
      return reply.code(status).send({ error: message });
    }
  });

  /** PATCH /api/voice/ui — touchControls, wakeWordsEnabled, defaultMicMuted, touchOnlyPreset */
  app.patch('/api/voice/ui', async (req, reply) => {
    try {
      return setVoiceUi(req.body);
    } catch (err) {
      const { status, message } = handleError(err);
      log.warn({ err }, 'update voice UI settings failed');
      return reply.code(status).send({ error: message });
    }
  });
}
