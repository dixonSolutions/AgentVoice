/**
 * Offline grammar-restricted phrase spotting via vosk-browser (WASM).
 *
 * Used for wake (start) and submit (end) phrases. Shares one cached model load.
 */

import type { Model } from 'vosk-browser';
import { captureMicStream, getSharedAudioContext, unlockAudioContext, connectSilentSink } from './audio.js';
import { isCrossOriginIsolated, voskCoopError } from './cross-origin-isolation.js';
import { loadVoskModel } from './vosk-model-cache.js';
import { normalizeForWakeMatch } from './wake-words.js';

export { VOSK_MODEL_URL } from './model-download.js';
export const VOSK_SAMPLE_RATE = 16000;

export interface VoskGrammarSpotterCallbacks {
  onReady?: () => void;
  /** `heard` is the raw Vosk transcript; `phrase` is the configured grammar phrase. */
  onMatch?: (phrase: string, heard: string) => void;
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
  onStatus?: (status: string) => void;
}

export function buildVoskGrammar(phrase: string): string {
  const word = normalizeForWakeMatch(phrase) || phrase.trim().toLowerCase();
  return JSON.stringify([word, '[unk]']);
}

/** True when Vosk heard the full grammar phrase (exact or trailing in an utterance). */
export function voskPhraseMatches(heard: string, phrase: string): boolean {
  const normHeard = normalizeForWakeMatch(heard);
  const normPhrase = normalizeForWakeMatch(phrase);
  if (!normPhrase || !normHeard) return false;
  if (normHeard === normPhrase) return true;
  return normHeard.endsWith(` ${normPhrase}`);
}

export interface VoskSpotterStartOptions {
  mediaStream?: MediaStream;
  /** When false, only final results fire onMatch (recommended for submit/end phrase). */
  matchPartial?: boolean;
  /** Minimum mean Vosk word confidence for final-result matching. */
  minimumConfidence?: number;
}

/** Partial results lack per-word confidence — enable them only at lower thresholds. */
export const WAKE_PARTIAL_MATCH_THRESHOLD = 0.55;

/** Convert wake confidence threshold (0–1) into concrete Vosk spotter behavior. */
export function wakeSpotterOptions(
  threshold = 0.45,
): Pick<VoskSpotterStartOptions, 'matchPartial' | 'minimumConfidence'> {
  const minimumConfidence = Math.min(1, Math.max(0, threshold));
  return {
    matchPartial: minimumConfidence < WAKE_PARTIAL_MATCH_THRESHOLD,
    minimumConfidence,
  };
}

/** @deprecated use buildVoskGrammar */
export const buildWakeGrammar = buildVoskGrammar;

export class VoskGrammarSpotter {
  private recognizer: InstanceType<Model['KaldiRecognizer']> | null = null;
  private mediaStream: MediaStream | null = null;
  private ownsStream = false;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private running = false;
  private paused = false;
  private phrase = '';
  private triggered = false;
  private matchPartial = true;
  private minimumConfidence = 0;

  constructor(private readonly cb: VoskGrammarSpotterCallbacks) {}

  /**
   * Start listening for `phrase` with grammar mode.
   * Pass `mediaStream` in options to share mic with STT.
   */
  async start(phrase: string, streamOrOpts?: MediaStream | VoskSpotterStartOptions): Promise<void> {
    const opts: VoskSpotterStartOptions =
      streamOrOpts instanceof MediaStream ? { mediaStream: streamOrOpts } : (streamOrOpts ?? {});
    if (this.running) return;

    if (!isCrossOriginIsolated()) {
      const message = voskCoopError();
      this.cb.onError?.(message);
      throw new Error(message);
    }

    this.phrase = normalizeForWakeMatch(phrase) || phrase.trim().toLowerCase();
    this.triggered = false;
    this.paused = false;
    this.matchPartial = opts.matchPartial ?? true;
    this.minimumConfidence = opts.minimumConfidence ?? 0;
    this.cb.onStatus?.('Loading Vosk model…');

    await unlockAudioContext();
    const model = await loadVoskModel();

    const grammar = buildVoskGrammar(this.phrase);
    this.recognizer = new model.KaldiRecognizer(VOSK_SAMPLE_RATE, grammar);
    this.recognizer.setWords(true);

    this.recognizer.on('result', (message) => {
      if (message.event === 'result') {
        const words = message.result.result ?? [];
        const confidence =
          words.length > 0
            ? words.reduce((sum, word) => sum + word.conf, 0) / words.length
            : null;
        this.handleRecognition(message.result.text, true, confidence);
      }
    });
    this.recognizer.on('partialresult', (message) => {
      if (message.event !== 'partialresult') return;
      const partial = message.result.partial ?? '';
      this.cb.onPartial?.(partial);
      if (this.matchPartial) {
        this.handleRecognition(partial, false);
      }
    });

    if (opts.mediaStream) {
      this.mediaStream = opts.mediaStream;
      this.ownsStream = false;
    } else {
      this.mediaStream = await captureMicStream();
      this.ownsStream = true;
    }

    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    this.source = ctx.createMediaStreamSource(this.mediaStream);
    // 4096 ≈ 85 ms at 48 kHz — fewer main-thread wakeups than 1024; still fine for wake words.
    this.processor = ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (!this.running || this.paused || !this.recognizer) return;
      try {
        this.recognizer.acceptWaveform(event.inputBuffer);
      } catch (err) {
        console.warn('[vosk-spotter]', err);
      }
    };
    this.source.connect(this.processor);
    connectSilentSink(ctx, this.processor);

    this.running = true;
    this.cb.onReady?.();
    this.cb.onStatus?.(`Listening for "${this.phrase}"…`);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  resetTrigger(): void {
    this.triggered = false;
  }

  /** Mic stream used by this spotter (for mute registration). */
  getMediaStream(): MediaStream | null {
    return this.mediaStream;
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    this.triggered = false;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.recognizer?.remove();
    this.recognizer = null;
    if (this.ownsStream) {
      this.mediaStream?.getTracks().forEach((track) => track.stop());
    }
    this.mediaStream = null;
    this.ownsStream = false;
    this.processor = null;
    this.source = null;
  }

  dispose(): void {
    this.stop();
  }

  private handleRecognition(
    text: string | undefined,
    fromFinal: boolean,
    confidence: number | null = null,
  ): void {
    if (this.triggered || !text?.trim()) return;
    if (!voskPhraseMatches(text, this.phrase)) return;
    if (
      fromFinal &&
      this.minimumConfidence > 0 &&
      (confidence === null || confidence < this.minimumConfidence)
    ) {
      return;
    }
    this.triggered = true;
    this.cb.onMatch?.(this.phrase, text.trim());
  }
}

/** Back-compat alias for wake-word test tab. */
export type VoskWakeWordCallbacks = VoskGrammarSpotterCallbacks & {
  onWakeWord?: (word: string) => void;
};

export class VoskWakeWordDetector extends VoskGrammarSpotter {
  constructor(cb: VoskWakeWordCallbacks) {
    super({
      onReady: cb.onReady,
      onPartial: cb.onPartial,
      onError: cb.onError,
      onStatus: cb.onStatus,
      onMatch: (word, heard) => {
        cb.onMatch?.(word, heard);
        cb.onWakeWord?.(word);
      },
    });
  }
}
