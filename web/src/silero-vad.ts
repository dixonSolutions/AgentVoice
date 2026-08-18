/**
 * Silero VAD (via @ricky0123/vad-web) — detects when the user has finished speaking.
 * Runs in the browser alongside the shared mic stream; does not stop mic tracks on pause.
 */

import { MicVAD } from '@ricky0123/vad-web';

import { getSharedAudioContext } from './audio.js';
import { SILERO_ASSET_BASE, prefetchVoiceModels } from './model-download.js';

export interface SileroVadCallbacks {
  onSpeechEnd?: () => void;
  onSpeechStart?: () => void;
  onError?: (message: string) => void;
}

export interface SileroVadStartOptions extends SileroVadCallbacks {
  /** Silence after speech before onSpeechEnd fires (maps to turnSubmit.silenceMs). */
  redemptionMs?: number;
}

export class SileroVadDetector {
  private micVad: MicVAD | null = null;

  async start(stream: MediaStream, opts: SileroVadStartOptions): Promise<void> {
    await this.dispose();

    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    // Pull the ONNX graph with progress first; MicVAD.new() then reads it from
    // Cache Storage rather than fetching it silently on the first turn.
    await prefetchVoiceModels({ vosk: false, silero: true });

    try {
      this.micVad = await MicVAD.new({
        getStream: async () => stream,
        pauseStream: async () => {},
        resumeStream: async () => stream,
        audioContext: ctx,
        baseAssetPath: SILERO_ASSET_BASE,
        onnxWASMBasePath: SILERO_ASSET_BASE,
        startOnLoad: false,
        processorType: 'auto',
        redemptionMs: opts.redemptionMs ?? 1400,
        onSpeechEnd: () => opts.onSpeechEnd?.(),
        onSpeechStart: () => opts.onSpeechStart?.(),
      });
      await this.micVad.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.onError?.(message);
      throw err;
    }
  }

  pause(): void {
    void this.micVad?.pause();
  }

  resume(): void {
    void this.micVad?.start();
  }

  async dispose(): Promise<void> {
    if (this.micVad) {
      await this.micVad.destroy();
      this.micVad = null;
    }
  }
}
