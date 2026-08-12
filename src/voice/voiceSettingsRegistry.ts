/**
 * Voice settings registry — wake words, turn-submit, TTS, and on-screen controls.
 *
 * Persisted in config.json under settings.voice.
 */

import { z } from 'zod';
import {
  LEGACY_WAKE_SENSITIVITY_THRESHOLD,
  getConfig,
  type TouchControlsMode,
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
  touchControls: TouchControlsMode;
  wakeWordsEnabled: boolean;
  defaultMicMuted: boolean;
  workerPollTimeoutMs: number;
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
  const {
    wakeWords,
    turnSubmit,
    tts,
    workerPollTimeoutMs,
    touchControls,
    wakeWordsEnabled,
    defaultMicMuted,
  } = settings.voice;
  const { userName } = settings;
  return {
    wakeWords,
    turnSubmit,
    tts,
    touchControls: touchControls ?? 'when_muted',
    wakeWordsEnabled: wakeWordsEnabled !== false,
    defaultMicMuted: defaultMicMuted === true,
    workerPollTimeoutMs: workerPollTimeoutMs ?? 25_000,
    ...(userName ? { userName } : {}),
  };
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
    workerPollTimeoutMs: z.coerce.number().int().min(5_000).max(60_000).optional(),
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

const VoiceUiBodySchema = z.object({
  touchControls: z.enum(['off', 'when_muted', 'always']).optional(),
  wakeWordsEnabled: z.boolean().optional(),
  defaultMicMuted: z.boolean().optional(),
  /** Convenience: always + wakeWordsEnabled false */
  touchOnlyPreset: z.boolean().optional(),
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
    if (parsed.data.workerPollTimeoutMs !== undefined) {
      voice.workerPollTimeoutMs = parsed.data.workerPollTimeoutMs;
    }
  }, `wake phrase → start="${startTrim}" end="${endTrim ?? '(unchanged)'}" cancel="${cancelTrim ?? '(unchanged)'}" wakeConfidenceThreshold="${parsed.data.wakeConfidenceThreshold ?? '(unchanged)'}" workerPollTimeoutMs="${parsed.data.workerPollTimeoutMs ?? '(unchanged)'}"`);

  return getVoiceSettingsView();
}

export function setVoiceTts(raw: unknown): VoiceSettingsResponse {
  const parsed = VoiceTtsBodySchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid TTS settings');

  persistVoiceUpdate((voice) => {
    const current = voice.tts ?? {
      cursorVoiceEnabled: true,
      errorSoundEnabled: true,
      errorSpeakEnabled: true,
      webkit: { rate: 1.02, pitch: 1, volume: 1, lang: 'en-US' },
    };
    voice.tts = {
      cursorVoiceEnabled: parsed.data.cursorVoiceEnabled ?? current.cursorVoiceEnabled,
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

export function setVoiceUi(raw: unknown): VoiceSettingsResponse {
  const parsed = VoiceUiBodySchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid on-screen control settings');

  const data = parsed.data;
  if (
    data.touchControls === undefined &&
    data.wakeWordsEnabled === undefined &&
    data.defaultMicMuted === undefined &&
    data.touchOnlyPreset === undefined
  ) {
    throw new Error('Provide touchControls, wakeWordsEnabled, defaultMicMuted, and/or touchOnlyPreset');
  }

  persistVoiceUpdate((voice) => {
    if (data.touchOnlyPreset === true) {
      voice.touchControls = 'always';
      voice.wakeWordsEnabled = false;
    }
    if (data.touchControls !== undefined) voice.touchControls = data.touchControls;
    if (data.wakeWordsEnabled !== undefined) voice.wakeWordsEnabled = data.wakeWordsEnabled;
    if (data.defaultMicMuted !== undefined) voice.defaultMicMuted = data.defaultMicMuted;
  }, 'voice UI / touch controls updated');

  return getVoiceSettingsView();
}
