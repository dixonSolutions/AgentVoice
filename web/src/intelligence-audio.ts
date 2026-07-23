/**
 * Intelligence audio routing — WebKit primary, Amazon Polly/Transcribe fallback.
 */

import {
  canUseWebkitStt,
  canUseWebkitTts,
  isIosStandalonePwa,
  probeMicAccess,
  webkitSttSkipReason,
  webkitTtsSkipReason,
} from './webkit-capabilities.js';

export type TtsProvider = 'browser' | 'amazon_polly';

export interface IntelligenceAudioConfig {
  preferWebkit: boolean;
  /** Preferred speech output. Defaults to browser when omitted (legacy configs). */
  ttsProvider?: TtsProvider;
  amazonAvailable: boolean;
  sttFallback: 'amazon_transcribe' | null;
  ttsFallback: 'amazon_polly' | null;
  pollyVoiceId?: string;
  pollyEngine?: 'standard' | 'neural' | 'generative';
  transcribeLanguageCode?: string;
}

export type SttBackend = 'webkit' | 'amazon_transcribe' | 'text_only';
export type TtsBackend = 'webkit' | 'amazon_polly' | 'none';

function resolvePreferredTtsProvider(config: IntelligenceAudioConfig): TtsProvider {
  if (config.ttsProvider === 'browser' || config.ttsProvider === 'amazon_polly') {
    return config.ttsProvider;
  }
  // Legacy: preferWebkit gated both STT and TTS.
  return config.preferWebkit ? 'browser' : 'amazon_polly';
}

export function resolveSttBackend(
  config: IntelligenceAudioConfig,
  webkitSttReady = canUseWebkitStt(),
): SttBackend {
  if (config.preferWebkit && webkitSttReady) return 'webkit';
  if (config.amazonAvailable && config.sttFallback === 'amazon_transcribe') {
    return 'amazon_transcribe';
  }
  return 'text_only';
}

export function resolveTtsBackend(config: IntelligenceAudioConfig): TtsBackend {
  const provider = resolvePreferredTtsProvider(config);
  const pollyReady = config.amazonAvailable && config.ttsFallback === 'amazon_polly';

  // Standalone iOS PWA cannot use speechSynthesis reliably — force Polly when available.
  if (isIosStandalonePwa() && pollyReady) {
    return 'amazon_polly';
  }

  if (provider === 'amazon_polly') {
    if (pollyReady) return 'amazon_polly';
    if (canUseWebkitTts()) return 'webkit';
    return 'none';
  }

  // provider === 'browser'
  if (canUseWebkitTts()) return 'webkit';
  if (pollyReady) return 'amazon_polly';
  return 'none';
}

export function describeAudioBackends(config: IntelligenceAudioConfig): {
  stt: SttBackend;
  tts: TtsBackend;
} {
  return {
    stt: resolveSttBackend(config),
    tts: resolveTtsBackend(config),
  };
}

export interface AudioBackendResolution {
  stt: SttBackend;
  tts: TtsBackend;
  /** Why WebKit STT was not selected, if applicable. */
  sttNote?: string;
  /** Why WebKit TTS was not selected, if applicable. */
  ttsNote?: string;
}

/** Session init — probe mic after user gesture; fall back to Amazon when WebKit STT unavailable. */
export async function resolveAudioBackendsAsync(
  config: IntelligenceAudioConfig,
): Promise<AudioBackendResolution> {
  const tts = resolveTtsBackend(config);
  let webkitSttReady = canUseWebkitStt();
  let sttNote: string | undefined;

  if (config.preferWebkit && !webkitSttReady) {
    sttNote = webkitSttSkipReason() ?? 'WebKit STT unavailable';
  } else if (config.preferWebkit && webkitSttReady) {
    webkitSttReady = await probeMicAccess();
    if (!webkitSttReady) {
      sttNote = 'Microphone permission denied or no input device';
    }
  }

  const stt = resolveSttBackend(config, webkitSttReady);
  if (stt !== 'webkit' && !sttNote && stt === 'text_only') {
    sttNote = 'No STT backend — configure AWS IAM keys for Amazon Transcribe fallback';
  }

  let ttsNote: string | undefined;
  const preferred = resolvePreferredTtsProvider(config);
  if (tts !== 'webkit' && preferred === 'browser') {
    ttsNote = webkitTtsSkipReason() ?? undefined;
  }
  if (tts === 'amazon_polly' && preferred === 'browser') {
    ttsNote = (ttsNote ? `${ttsNote} — ` : '') + 'Falling back to Amazon Polly';
  }
  if (tts === 'none' && !ttsNote) {
    ttsNote =
      preferred === 'amazon_polly'
        ? 'Amazon Polly unavailable — configure AWS IAM keys'
        : 'No TTS backend — browser speechSynthesis unavailable and Polly not configured';
  }

  return { stt, tts, sttNote, ttsNote };
}
