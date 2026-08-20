/**
 * Audio backend routing on the phone.
 *
 * The bridge sends the configured chain for each direction — an ordered list of
 * `browser` and server providers with bridge-side readiness already resolved.
 * The phone walks it and takes the first entry it can actually use, so the
 * precedence rules live in settings rather than being duplicated here.
 *
 * The one thing only the device can answer is whether *it* can do the job:
 * SpeechRecognition may be missing, mic permission may be denied, and a
 * speechSynthesis voice may not exist for the requested language. Those checks
 * are what make a `browser` entry get skipped in favour of the next provider.
 *
 * See docs/30-provider-scopes-and-speech-output.md.
 */

import { hasBrowserVoiceForLanguage } from './browser-tts-settings.js';
import {
  canUseWebkitStt,
  canUseWebkitTts,
  isIosStandalonePwa,
  probeMicAccess,
  webkitSttSkipReason,
  webkitTtsSkipReason,
} from './webkit-capabilities.js';

/** One step of the configured chain, as sent by the bridge. */
export interface SpeechChainEntry {
  id: string;
  label: string;
  /** Runs here rather than on the bridge. */
  device: boolean;
  /** Bridge-side readiness. Always true for device entries — we decide those. */
  ready: boolean;
}

export interface IntelligenceAudioConfig {
  sttProvider: string;
  sttFallback: string | null;
  sttProviderLabel?: string | null;
  sttAvailable: boolean;
  sttLanguage: string;
  sttChain: SpeechChainEntry[];

  ttsProvider: string;
  ttsFallback: string | null;
  ttsProviderLabel?: string | null;
  ttsAvailable: boolean;
  /** Resolved language for replies ('auto' when it follows detection). */
  ttsLanguage: string;
  ttsChain: SpeechChainEntry[];
}

export const EMPTY_AUDIO_CONFIG: IntelligenceAudioConfig = {
  sttProvider: 'browser',
  sttFallback: null,
  sttAvailable: false,
  sttLanguage: 'auto',
  sttChain: [{ id: 'browser', label: 'Browser STT', device: true, ready: true }],
  ttsProvider: 'browser',
  ttsFallback: null,
  ttsAvailable: false,
  ttsLanguage: 'auto',
  ttsChain: [{ id: 'browser', label: 'Browser TTS', device: true, ready: true }],
};

/** `server` = whichever engine the bridge routes the request to. */
export type SttBackend = 'webkit' | 'server' | 'text_only';
export type TtsBackend = 'webkit' | 'server' | 'none';

function serverLabel(chain: SpeechChainEntry[], fallbackLabel: string): string {
  return chain.find((e) => !e.device && e.ready)?.label ?? fallbackLabel;
}

export function serverSttLabel(config: IntelligenceAudioConfig): string {
  return config.sttProviderLabel?.trim() || serverLabel(config.sttChain, 'Server STT');
}

export function serverTtsLabel(config: IntelligenceAudioConfig): string {
  return config.ttsProviderLabel?.trim() || serverLabel(config.ttsChain, 'Server TTS');
}

// ── Speech in ──────────────────────────────────────────────────────────────

export function resolveSttBackend(
  config: IntelligenceAudioConfig,
  webkitSttReady = canUseWebkitStt(),
): SttBackend {
  for (const entry of config.sttChain) {
    if (entry.device) {
      if (webkitSttReady) return 'webkit';
      continue;
    }
    if (entry.ready) return 'server';
  }
  return 'text_only';
}

// ── Speech out ─────────────────────────────────────────────────────────────

/**
 * Can this device speak the language itself?
 *
 * A missing voice is the common case people hit: Safari ships en-* and little
 * else, so a Polish reply comes out as English phonemes or silence. Treating
 * that as "browser can't do this one" is what lets the chain hand it to a
 * provider that can.
 */
function deviceCanSpeak(language: string): boolean {
  if (!canUseWebkitTts()) return false;
  // Standalone iOS PWAs report voices but do not reliably play them.
  if (isIosStandalonePwa()) return false;
  if (!language || language === 'auto') return true;
  return hasBrowserVoiceForLanguage(language);
}

export function resolveTtsBackend(config: IntelligenceAudioConfig): TtsBackend {
  for (const entry of config.ttsChain) {
    if (entry.device) {
      if (deviceCanSpeak(config.ttsLanguage)) return 'webkit';
      continue;
    }
    if (entry.ready) return 'server';
  }
  // Nothing in the chain worked. A device voice that merely lacks the language
  // still beats silence, so try it before giving up.
  return canUseWebkitTts() ? 'webkit' : 'none';
}

export function describeAudioBackends(config: IntelligenceAudioConfig): {
  stt: SttBackend;
  tts: TtsBackend;
} {
  return { stt: resolveSttBackend(config), tts: resolveTtsBackend(config) };
}

export interface AudioBackendResolution {
  stt: SttBackend;
  tts: TtsBackend;
  /** Why the chosen speech-in backend is not the first choice, if applicable. */
  sttNote?: string;
  ttsNote?: string;
}

/** Session init — probe the mic after the user gesture, then walk both chains. */
export async function resolveAudioBackendsAsync(
  config: IntelligenceAudioConfig,
): Promise<AudioBackendResolution> {
  const prefersDeviceStt = config.sttChain[0]?.device === true;
  let webkitSttReady = canUseWebkitStt();
  let sttNote: string | undefined;

  if (prefersDeviceStt && !webkitSttReady) {
    sttNote = webkitSttSkipReason() ?? 'Browser STT unavailable';
  } else if (prefersDeviceStt) {
    webkitSttReady = await probeMicAccess();
    if (!webkitSttReady) sttNote = 'Microphone permission denied or no input device';
  }

  const stt = resolveSttBackend(config, webkitSttReady);
  if (stt === 'text_only') {
    sttNote = sttNote
      ? `${sttNote} — and no server provider is ready`
      : 'No speech-to-text backend — pick a provider in Config → Speech';
  } else if (stt === 'server' && sttNote) {
    sttNote = `${sttNote} — falling back to ${serverSttLabel(config)}`;
  }

  const tts = resolveTtsBackend(config);
  let ttsNote: string | undefined;
  const prefersDeviceTts = config.ttsChain[0]?.device === true;

  if (prefersDeviceTts && tts !== 'webkit') {
    const language = config.ttsLanguage;
    ttsNote =
      language && language !== 'auto' && canUseWebkitTts() && !hasBrowserVoiceForLanguage(language)
        ? `This device has no ${language} voice`
        : (webkitTtsSkipReason() ?? 'Browser TTS unavailable');
    if (tts === 'server') ttsNote = `${ttsNote} — falling back to ${serverTtsLabel(config)}`;
  }
  if (tts === 'none' && !ttsNote) {
    ttsNote = 'No text-to-speech backend — pick a provider in Config → Speech';
  }

  return {
    stt,
    tts,
    ...(sttNote ? { sttNote } : {}),
    ...(ttsNote ? { ttsNote } : {}),
  };
}
