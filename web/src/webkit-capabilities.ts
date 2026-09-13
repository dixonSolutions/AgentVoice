/**
 * Browser speech API capability checks — WebKit STT/TTS require a secure context.
 */

import { browserTtsHasAnyVoice } from './browser-tts-settings.js';

function getSpeechRecognitionCtor(): (new () => unknown) | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & {
    SpeechRecognition?: new () => unknown;
    webkitSpeechRecognition?: new () => unknown;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** HTTPS or localhost — required for getUserMedia and speech APIs in production. */
export function isLikelySecureVoiceContext(): boolean {
  if (typeof window === 'undefined') return false;
  return window.isSecureContext === true;
}

/**
 * iOS home-screen PWA (standalone display mode).
 * SpeechRecognition is exposed but broken in standalone PWAs — use Amazon STT fallback instead.
 * @see https://firt.dev/ios-14.5/#speech-recognition-api
 */
export function isIosStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIos) return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return window.matchMedia('(display-mode: standalone)').matches;
}

export function hasSpeechRecognitionApi(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

export function hasSpeechSynthesisApi(): boolean {
  return typeof window !== 'undefined' && Boolean(window.speechSynthesis);
}

export function hasMicApi(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

/** Sync check: WebKit STT APIs + secure context + mic API present. */
export function canUseWebkitStt(): boolean {
  if (isIosStandalonePwa()) return false;
  return isLikelySecureVoiceContext() && hasSpeechRecognitionApi() && hasMicApi();
}

/** Human-readable reason WebKit STT was skipped (for session logs). */
export function webkitSttSkipReason(): string | null {
  if (isIosStandalonePwa()) {
    return 'iOS home-screen PWA — WebKit STT unavailable; open in Safari tab or use Amazon Transcribe';
  }
  if (!isLikelySecureVoiceContext()) return 'Not a secure context (need HTTPS)';
  if (!hasSpeechRecognitionApi()) return 'SpeechRecognition API not available';
  if (!hasMicApi()) return 'getUserMedia not available';
  return null;
}

/** Sync check: WebKit TTS API + secure context + at least one installed voice. */
export function canUseWebkitTts(): boolean {
  if (isIosStandalonePwa()) return false;
  if (!isLikelySecureVoiceContext() || !hasSpeechSynthesisApi()) return false;
  // An engine with an empty voice catalog reports success and plays silence,
  // so "the API exists" is not enough to call this usable.
  return browserTtsHasAnyVoice();
}

/** Human-readable reason WebKit TTS was skipped (for session logs). */
export function webkitTtsSkipReason(): string | null {
  if (isIosStandalonePwa()) {
    return 'iOS home-screen PWA — use Amazon Polly for TTS (WebKit TTS unreliable here)';
  }
  if (!isLikelySecureVoiceContext()) return 'Not a secure context (need HTTPS)';
  if (!hasSpeechSynthesisApi()) return 'speechSynthesis API not available';
  if (!browserTtsHasAnyVoice()) {
    return 'Browser has no speech voices installed (on Linux, install speech-dispatcher and a voice; a Flatpak browser also needs access to its socket)';
  }
  return null;
}

/**
 * Runtime mic probe — call after a user gesture (orb tap) when WebKit STT looks available.
 * Returns false when permission is denied or no input device is present.
 */
export async function probeMicAccess(): Promise<boolean> {
  if (!canUseWebkitStt()) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch {
    return false;
  }
}
