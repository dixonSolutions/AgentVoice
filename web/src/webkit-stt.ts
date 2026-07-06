/**
 * WebKit SpeechRecognition — on-device STT on iPhone Safari.
 *
 * Uses Apple's on-device speech engine (same family as Siri): fast, accurate, zero API cost.
 * Wake gating is enforced by Vosk in LlmIntelligenceSession — STT only runs per utterance.
 */

import type { SttGate } from './stt-gate.js';
import { canUseWebkitStt, hasSpeechRecognitionApi } from './webkit-capabilities.js';

export interface SttCallbacks {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
}

interface SpeechRecognitionAlternative {
  transcript: string;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined' || !hasSpeechRecognitionApi()) return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** @deprecated use canUseWebkitStt — kept for existing imports */
export function isWebkitSttSupported(): boolean {
  return canUseWebkitStt();
}

export class WebkitSttSession {
  private recognition: SpeechRecognitionInstance | null = null;
  private running = false;
  private paused = false;

  constructor(
    private readonly lang: string,
    private readonly gate: SttGate,
    private readonly cb: SttCallbacks,
  ) {}

  start(): void {
    if (this.paused || this.gate.isPaused()) return;
    if (!canUseWebkitStt()) {
      this.cb.onError?.('Browser STT unavailable — use Amazon Transcribe fallback.');
      return;
    }
    const Ctor = getSpeechRecognition();
    if (!Ctor) {
      this.cb.onError?.('Speech recognition is not supported in this browser.');
      return;
    }

    this.stopRecognitionOnly();
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.maxAlternatives = 1;

    rec.onresult = (ev) => {
      if (this.gate.isPaused()) return;

      let interim = '';
      let finalText = '';

      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const result = ev.results[i];
        const transcript = result?.[0]?.transcript?.trim() ?? '';
        if (!transcript) continue;
        if (result.isFinal) {
          finalText = finalText ? `${finalText} ${transcript}` : transcript;
        } else {
          interim = interim ? `${interim} ${transcript}` : transcript;
        }
      }

      if (interim) this.cb.onInterim?.(interim);
      if (finalText) this.cb.onFinal(finalText);
    };

    rec.onerror = (ev) => {
      if (ev.error === 'aborted' || ev.error === 'no-speech') return;
      this.cb.onError?.(ev.message || ev.error);
    };

    rec.onend = () => {
      this.running = false;
      this.cb.onEnd?.();
    };

    this.recognition = rec;
    this.running = true;
    rec.start();
  }

  /** Stop recognition during TTS / orchestrator work (prevents echo loops). */
  pause(): void {
    this.paused = true;
    this.stopRecognitionOnly();
  }

  resume(): void {
    this.paused = false;
    if (!this.gate.isPaused()) this.start();
  }

  stop(): void {
    this.paused = false;
    this.stopRecognitionOnly();
  }

  /** End recognition so WebKit emits a final transcript (Vosk end-phrase path). */
  flushNow(): void {
    if (!this.recognition || !this.running || this.gate.isPaused()) return;
    try {
      this.recognition.stop();
    } catch {
      // ignore
    }
  }

  private stopRecognitionOnly(): void {
    if (!this.recognition) return;
    try {
      this.recognition.abort();
    } catch {
      // ignore
    }
    this.recognition = null;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }
}