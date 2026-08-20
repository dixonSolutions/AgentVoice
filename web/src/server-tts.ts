/**
 * Amazon Polly TTS playback — fallback when WebKit speechSynthesis is unavailable.
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

export function stopAmazonTts(): void {
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

export interface SpeakAmazonPollyOptions {
  voiceId?: string;
  engine?: 'standard' | 'neural' | 'generative';
}

/** Fetch Polly MP3 from bridge and play; resolves when playback ends or aborts. */
export async function speakAmazonPolly(
  text: string,
  bridgeBase: string,
  appToken: string,
  ctx?: TtsPlayContext,
  options?: SpeakAmazonPollyOptions,
): Promise<void> {
  const clean = cleanText(text);
  if (!clean) return;
  if (ctx?.signal.aborted) return;

  stopAmazonTts();

  const res = await fetch(`${bridgeBase}/api/intelligence/tts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: clean,
      ...(options?.voiceId ? { voiceId: options.voiceId } : {}),
      ...(options?.engine ? { engine: options.engine } : {}),
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
    throw new Error(`Polly TTS failed: ${detail}`);
  }

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
