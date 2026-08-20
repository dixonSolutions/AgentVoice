/**
 * Server-side TTS playback — used when the device's own speechSynthesis is
 * unavailable, or cannot speak the language the reply is in.
 *
 * Which engine answers is the bridge's business (Polly, ElevenLabs, OpenAI,
 * Gemini, a self-hosted Kokoro container, …); this just posts the text and
 * plays whatever audio comes back. The response's `X-Speech-Provider` header
 * names the engine that actually spoke, so a silent fallback is still visible
 * in the voice log. See docs/30-provider-scopes-and-speech-output.md.
 */

import { getSharedAudioContext, unlockAudioContext } from './audio.js';
import type { TtsPlayContext } from './tts-interrupt.js';
import { canUseWebkitTts } from './webkit-capabilities.js';

const MAX_TTS_CHARS = 3000;
let currentAudio: HTMLAudioElement | null = null;
let currentBufferSource: AudioBufferSourceNode | null = null;
let currentGainNode: GainNode | null = null;

function cleanText(text: string): string {
  return text.replace(/^\[Speak to user\]:\s*/i, '').trim().slice(0, MAX_TTS_CHARS);
}

function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function stopServerTts(): void {
  if (currentBufferSource) {
    try {
      currentBufferSource.stop();
    } catch {
      // already stopped
    }
    currentBufferSource.disconnect();
    currentBufferSource = null;
  }
  if (currentGainNode) {
    currentGainNode.disconnect();
    currentGainNode = null;
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
}

/** @deprecated use canUseWebkitTts — kept for existing imports */
export function isWebkitTtsSupported(): boolean {
  return canUseWebkitTts();
}

export interface SpeakServerTtsOptions {
  /** Override the configured language for this line (e.g. a quoted phrase). */
  language?: string;
}

/** Which engine spoke the last line — surfaced in the voice log. */
let lastProvider: string | null = null;

export function lastServerTtsProvider(): string | null {
  return lastProvider;
}

/** Fetch synthesized audio from the bridge and play it; resolves when done. */
export async function speakServerTts(
  text: string,
  bridgeBase: string,
  appToken: string,
  ctx?: TtsPlayContext,
  options?: SpeakServerTtsOptions,
): Promise<void> {
  const clean = cleanText(text);
  if (!clean) return;
  if (ctx?.signal.aborted) return;

  stopServerTts();

  const res = await fetch(`${bridgeBase}/api/intelligence/tts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: clean,
      ...(options?.language ? { language: options.language } : {}),
    }),
  });

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // ignore
    }
    throw new Error(`Text-to-speech failed: ${detail}`);
  }

  lastProvider = res.headers.get('X-Speech-Provider');
  const blob = await res.blob();

  if (isIosDevice()) {
    await playBlobViaAudioContext(blob, ctx);
    return;
  }

  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.setAttribute('webkit-playsinline', 'true');
  const baseVol = ctx?.baseVolume ?? 1;
  audio.volume = baseVol;
  currentAudio = audio;

  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      ctx?.signal.removeEventListener('abort', onAbort);
      resolve();
    };

    const onAbort = () => {
      audio.pause();
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      finish();
    };

    ctx?.signal.addEventListener('abort', onAbort, { once: true });

    audio.onplay = () => ctx?.onStart();
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      finish();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      reject(new Error('Polly audio playback failed'));
    };
    void audio.play().catch(reject);
  });
}

async function playBlobViaAudioContext(blob: Blob, ctx?: TtsPlayContext): Promise<void> {
  await unlockAudioContext();
  const audioCtx = getSharedAudioContext();
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  const buffer = await audioCtx.decodeAudioData(await blob.arrayBuffer());
  const source = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  const baseVol = ctx?.baseVolume ?? 1;
  gain.gain.value = baseVol;
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(audioCtx.destination);
  currentBufferSource = source;
  currentGainNode = gain;

  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      ctx?.signal.removeEventListener('abort', onAbort);
      if (currentBufferSource === source) currentBufferSource = null;
      if (currentGainNode === gain) currentGainNode = null;
      resolve();
    };

    const onAbort = () => {
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source.disconnect();
      gain.disconnect();
      finish();
    };

    ctx?.signal.addEventListener('abort', onAbort, { once: true });

    source.onended = finish;
    try {
      source.start(0);
      ctx?.onStart();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
