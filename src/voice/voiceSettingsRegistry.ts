/**
 * Voice settings registry — wake words and turn-submit timing.
 *
 * Persisted in config.json under settings.voice.
 */

import { z } from 'zod';
import {
  LEGACY_WAKE_SENSITIVITY_THRESHOLD,
  getConfig,
  type TurnSubmit,
  type VoiceSettings,
  type VoiceSettingsInput,
  type VoiceTtsSettings,
  type WakeWords,
} from '../config.js';
import { readConfigFile, writeConfigFile } from '../state/configFile.js';
import { writeAudit } from '../state/db.js';
import { childLogger } from '../log.js';

const log = childLogger('voiceSettings');

export interface VoiceSettingsResponse {
  wakeWords: WakeWords;
  turnSubmit: TurnSubmit;
  tts: VoiceTtsSettings;
  userName?: string;
}

function persistVoiceUpdate(
  mutate: (voice: VoiceSettingsInput) => void,
  auditReason: string,
): VoiceSettings {
  const file = readConfigFile();
  mutate(file.settings.voice);
  writeConfigFile(file);
  writeAudit({ tool: 'voice_settings', result: 'ok', reason: auditReason });
  log.info({ reason: auditReason }, 'voice settings updated');
  return getConfig().settings.voice;
}

export function getVoiceSettingsView(): VoiceSettingsResponse {
  const settings = getConfig().settings;
  const { wakeWords, turnSubmit, tts } = settings.voice;
  const { userName } = settings;
  return { wakeWords, turnSubmit, tts, ...(userName ? { userName } : {}) };
}

const WakeWordsBodySchema = z
  .object({
    start: z.string().min(1).max(100),
    end: z.string().max(100).optional(),
    cancel: z.string().max(100).optional(),
    /** @deprecated — use wakeConfidenceThreshold */
    sensitivity: z.enum(['high', 'balanced', 'strict']).optional(),
    wakeConfidenceThreshold: z.coerce.number().min(0).max(1).optional(),
    silenceMs: z.coerce.number().int().min(500).max(30_000).optional(),
    vadEnabled: z.boolean().optional(),
  })
  .transform(({ sensitivity, wakeConfidenceThreshold, ...rest }) => ({
    ...rest,
    wakeConfidenceThreshold:
      wakeConfidenceThreshold ??
      (sensitivity ? LEGACY_WAKE_SENSITIVITY_THRESHOLD[sensitivity] : undefined),
  }));

const UserNameBodySchema = z.object({
  userName: z.string().min(1).max(64).optional().nullable(),
});

const VoiceTtsBodySchema = z.object({
  cursorVoiceEnabled: z.boolean().optional(),
  interruptMode: z.enum(['deafen', 'stop']).optional(),
  interruptDeafenFactor: z.number().min(0).max(1).optional(),
  errorSoundEnabled: z.boolean().optional(),
  errorSpeakEnabled: z.boolean().optional(),
  webkit: z
    .object({
      rate: z.number().min(0.1).max(10).optional(),
      pitch: z.number().min(0).max(2).optional(),
      volume: z.number().min(0).max(1).optional(),
      lang: z.string().min(2).max(16).optional(),
    })
    .optional(),
});

export function setUserName(raw: unknown): VoiceSettingsResponse {
  const parsed = UserNameBodySchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid userName — must be a string up to 64 characters');

  const name = parsed.data.userName?.trim() || undefined;
  const file = readConfigFile();
  if (name) {
    (file.settings as Record<string, unknown>)['userName'] = name;
  } else {
    delete (file.settings as Record<string, unknown>)['userName'];
  }
  writeConfigFile(file);
  writeAudit({ tool: 'voice_settings', result: 'ok', reason: `userName → "${name ?? '(cleared)'}"` });
  log.info({ name }, 'userName updated');
  return getVoiceSettingsView();
}

export function setWakeWords(raw: unknown): VoiceSettingsResponse {
  const parsed = WakeWordsBodySchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid wake phrase — start is required');

  const startTrim = parsed.data.start.trim();
  const endTrim = parsed.data.end?.trim();
  const cancelTrim = parsed.data.cancel?.trim();
  if (!startTrim) throw new Error('Activation phrase cannot be empty');

  persistVoiceUpdate((voice) => {
    voice.wakeWords = {
      start: startTrim,
      end: parsed.data.end !== undefined ? endTrim ?? '' : (voice.wakeWords.end ?? 'send'),
      cancel: parsed.data.cancel !== undefined ? cancelTrim ?? 'cancel' : (voice.wakeWords.cancel ?? 'cancel'),
      wakeConfidenceThreshold:
        parsed.data.wakeConfidenceThreshold ??
        voice.wakeWords.wakeConfidenceThreshold ??
        0.45,
    };
    if (parsed.data.silenceMs !== undefined || parsed.data.vadEnabled !== undefined) {
      voice.turnSubmit = {
        silenceMs: parsed.data.silenceMs ?? voice.turnSubmit.silenceMs,
        vadEnabled: parsed.data.vadEnabled ?? voice.turnSubmit.vadEnabled ?? true,
      };
    }
  }, `wake phrase → start="${startTrim}" end="${endTrim ?? '(unchanged)'}" cancel="${cancelTrim ?? '(unchanged)'}" wakeConfidenceThreshold="${parsed.data.wakeConfidenceThreshold ?? '(unchanged)'}"`);

  return getVoiceSettingsView();
}

export function setVoiceTts(raw: unknown): VoiceSettingsResponse {
  const parsed = VoiceTtsBodySchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid TTS settings');

  persistVoiceUpdate((voice) => {
    const current = voice.tts ?? {
      cursorVoiceEnabled: true,
      interruptMode: 'deafen' as const,
      interruptDeafenFactor: 0.2,
      errorSoundEnabled: true,
      errorSpeakEnabled: true,
      webkit: { rate: 1.02, pitch: 1, volume: 1, lang: 'en-US' },
    };
    voice.tts = {
      cursorVoiceEnabled: parsed.data.cursorVoiceEnabled ?? current.cursorVoiceEnabled,
      interruptMode: parsed.data.interruptMode ?? current.interruptMode,
      interruptDeafenFactor:
        parsed.data.interruptDeafenFactor ?? current.interruptDeafenFactor,
      errorSoundEnabled: parsed.data.errorSoundEnabled ?? current.errorSoundEnabled ?? true,
      errorSpeakEnabled: parsed.data.errorSpeakEnabled ?? current.errorSpeakEnabled ?? true,
      webkit: {
        ...current.webkit,
        ...(parsed.data.webkit ?? {}),
      },
    };
  }, 'voice TTS settings updated');

  return getVoiceSettingsView();
}
