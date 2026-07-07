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

export const VOSK_MODEL_URL = '/vosk/model.tar.gz';
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
    this.cb.onStatus?.('Loading Vosk model…');

    await unlockAudioContext();
    const model = await loadVoskModel();

    const grammar = buildVoskGrammar(this.phrase);
    this.recognizer = new model.KaldiRecognizer(VOSK_SAMPLE_RATE, grammar);

    this.recognizer.on('result', (message) => {
      if (message.event === 'result') {
        this.handleRecognition(message.result.text, true);
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
    this.processor = ctx.createScriptProcessor(1024, 1, 1);
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

  private handleRecognition(text: string | undefined, _fromFinal: boolean): void {
    if (this.triggered || !text?.trim()) return;
    if (!voskPhraseMatches(text, this.phrase)) return;
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
