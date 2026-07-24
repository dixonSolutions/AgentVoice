/**
 * llm_intelligence voice session — WebKit STT/TTS with Amazon Polly/Transcribe fallback.
 *
 * Vosk (offline) gates the wake phrase; Silero VAD detects speech end and triggers STT submit.
 * STT only runs during an utterance and transcribes once — never used for phrase detection.
 */

import {
  captureMicStream,
  createMicProcessingChain,
  getSharedAudioContext,
  primeTtsPlaybackUnlock,
  connectSilentSink,
  type MicProcessingChain,
} from './audio.js';
import { getVoiceAudioMeter } from './voice-audio-meter.js';
import type { SessionCallbacks, VoiceAgentStatusEvent, VoiceLogLevel, VoiceLogSubcategory } from './voice-session-types.js';
import { type TurnSubmit, type WakeWords, textContainsWakePhrase } from './wake-words.js';
import {
  cancelTtsFallback,
  stopAllTts,
  TtsPile,
  prepareSpeechSynthesisForPlayback,
  type TtsPlayContext,
} from './tts-fallback.js';
import {
  snapshotToPayload,
  summarizeTtsInterrupt,
  withLastHeardWords,
  type TtsInterruptSnapshot,
} from './tts-interrupt.js';
import { WebkitSttSession } from './webkit-stt.js';
import { AmazonSttSession } from './amazon-stt.js';
import { speakAmazonPolly, stopAmazonTts } from './amazon-tts.js';
import { canUseWebkitTts } from './webkit-capabilities.js';
import {
  resolveAudioBackendsAsync,
  type IntelligenceAudioConfig,
  type SttBackend,
  type TtsBackend,
} from './intelligence-audio.js';
import type { SttGate } from './stt-gate.js';
import { isCrossOriginIsolated, wakePhraseCoopError } from './cross-origin-isolation.js';
import {
  VoskGrammarSpotter,
  voskPhraseMatches,
  wakeSpotterOptions,
} from './vosk-wake-word.js';
import { SileroVadDetector } from './silero-vad.js';
import { TurnSubmitBuffer } from './turn-submit-buffer.js';
import { playVoiceCueNow } from './sound-effects.js';
import { errorSpeechText } from './error-feedback.js';
import {
  resolveBrowserTtsOptions,
  type WebkitTtsDefaults,
} from './browser-tts-settings.js';

export interface VoiceTtsSettings {
  cursorVoiceEnabled: boolean;
  interruptMode: 'pause' | 'deafen' | 'stop';
  interruptDeafenFactor: number;
  errorSoundEnabled: boolean;
  errorSpeakEnabled: boolean;
  webkit: WebkitTtsDefaults;
}

export interface IntelligenceAuthOk {
  sessionKey: string;
  workflow: string;
  wakeWords: WakeWords;
  turnSubmit: TurnSubmit;
  tts?: VoiceTtsSettings;
  model: string;
  audio?: IntelligenceAudioConfig;
}

type SttSession = WebkitSttSession | AmazonSttSession;

export class LlmIntelligenceSession {
  private ws: WebSocket | null = null;
  private stt: SttSession | null = null;
  private closed = false;
  private wakeWords: WakeWords = { start: '', end: 'send' };
  private turnSubmit: TurnSubmit = { silenceMs: 1500, vadEnabled: true };
  private ttsSettings: VoiceTtsSettings = {
    cursorVoiceEnabled: true,
    interruptMode: 'pause',
    interruptDeafenFactor: 0.2,
    errorSoundEnabled: true,
    errorSpeakEnabled: true,
    webkit: { rate: 1.02, pitch: 1, volume: 1, lang: 'en-US' },
  };
  private resolvedWebkitTts = resolveBrowserTtsOptions({
    rate: 1.02,
    pitch: 1,
    volume: 1,
    lang: 'en-US',
  });
  private voiceActivated = false;
  /** True while STT is buffering audio between Vosk wake and VAD speech-end cut. */
  private capturingUtterance = false;
  private orchestratorBusy = false;
  private ttsSpeaking = false;
  private wsConnected = false;
  private audioConfig: IntelligenceAudioConfig = {
    preferWebkit: true,
    ttsProvider: 'browser',
    amazonAvailable: false,
    sttFallback: null,
    ttsFallback: null,
  };
  private sttBackend: SttBackend = 'text_only';
  private ttsBackend: TtsBackend = 'none';
  private readonly ttsPile = new TtsPile((text, ctx) => this.playSpeakUtterance(text, ctx));
  private pendingTtsInterrupt: TtsInterruptSnapshot | null = null;
  private meterMicChain: MicProcessingChain | null = null;
  private startSpotter: VoskGrammarSpotter | null = null;
  private vadDetector: SileroVadDetector | null = null;
  private endSpotter: VoskGrammarSpotter | null = null;
  private cancelSpotter: VoskGrammarSpotter | null = null;
  private turnBuffer: TurnSubmitBuffer | null = null;
  private vadSpeechEndPending = false;
  private endPhrasePending = false;
  private endSubmitTimer = 0;
  /** Ignore speech-end for this long after wake (avoids bleed-through / partial false hits). */
  private readonly minSpeechEndMs = 800;
  private capturePhaseStartedAt = 0;
  /** True only between wake activation and turn submit — VAD must not run before this. */
  private vadListening = false;
  /** True only between wake activation and turn submit — end Vosk must not run before this. */
  private listeningForEndPhrase = false;
  private micMuted = false;
  private lastLoggedSttPartial = '';
  private sharedMicStream: MediaStream | null = null;
  private lastErrorFeedbackMessage = '';
  private lastErrorFeedbackAt = 0;
  private ownsSharedMic = false;
  private readonly micTracks = new Set<MediaStreamTrack>();

  private readonly sttGate: SttGate = {
    isCapturing: () =>
      this.capturingUtterance || this.vadSpeechEndPending || this.endPhrasePending,
    /** Pause STT only while muted or assistant TTS (not during a fresh user capture). */
    isPaused: () => this.micMuted || (this.ttsSpeaking && !this.capturingUtterance),
  };

  constructor(
    private readonly bridgeBase: string,
    private readonly appToken: string,
    private readonly cb: SessionCallbacks,
  ) {
    this.ttsPile.setOnActiveChange((active) => {
      this.ttsSpeaking = active;
      this.cb.onSpeaking(active);
      this.notifySpeakingState(active);
      if (!active) {
        this.ensureWakeListening();
      }
      this.syncCapture();
    });
  }

  getAudioBackends(): { stt: SttBackend; tts: TtsBackend } {
    return { stt: this.sttBackend, tts: this.ttsBackend };
  }

  getAudioConfig(): IntelligenceAudioConfig {
    return this.audioConfig;
  }

  isVoiceActivated(): boolean {
    return this.voiceActivated;
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    for (const t of this.micTracks) t.enabled = !muted;
    if (muted) {
      this.startSpotter?.pause();
      if (this.vadListening) this.vadDetector?.pause();
      if (this.listeningForEndPhrase) this.endSpotter?.pause();
    } else {
      this.startSpotter?.resume();
      if (this.vadListening) this.vadDetector?.resume();
      if (this.listeningForEndPhrase) this.endSpotter?.resume();
    }
    if (this.stt instanceof AmazonSttSession) {
      this.stt.setMicEnabled(!muted);
    }
    this.syncCapture();
  }

  private registerMicStream(stream: MediaStream | null | undefined): void {
    stream?.getAudioTracks().forEach((t) => this.micTracks.add(t));
  }

  async start(): Promise<void> {
    this.cb.onState('connecting');
    await primeTtsPlaybackUnlock();

    const wsUrl = `${this.bridgeBase.replace(/^http/, 'ws')}/ws/intelligence`;
    this.ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: this.appToken }));
      });

      ws.addEventListener('message', (ev) => {
        this.handleMessage(ev.data as string, {
          onAuthOk: () => finish(resolve),
          onError: (message) => finish(() => reject(new Error(message))),
        });
      });

      ws.addEventListener('error', () =>
        finish(() => reject(new Error('Intelligence WebSocket error'))),
      );

      ws.addEventListener('close', (ev) => {
        if (!this.closed && this.wsConnected) {
          this.cb.onClosed?.('Intelligence WebSocket disconnected');
        }
        finish(() =>
          reject(new Error(ev.reason?.trim() || `Intelligence WebSocket closed (${ev.code})`)),
        );
      });
    });

    const resolved = await resolveAudioBackendsAsync(this.audioConfig);
    this.sttBackend = resolved.stt;
    this.ttsBackend = resolved.tts;
    console.info('[audio] STT:', this.sttBackend, 'TTS:', this.ttsBackend, resolved.sttNote ?? '');
    const ttsDetail = resolved.ttsNote ?? resolved.sttNote;
    this.voiceLog(
      'pipeline',
      'info',
      `Audio backends: ${this.sttProviderLabel()} · ${this.ttsProviderLabel()}`,
      ttsDetail,
    );
    this.wsConnected = true;

    // STT hardware is lazy-init in beginUtteranceCapture() — only one backend (WebKit OR Amazon).
    await this.startWakeWordPhase();

    this.cb.onState('connected');
  }

  close(): void {
    this.closed = true;
    this.wsConnected = false;
    this.endUtteranceCapture(true);
    this.stt?.stop();
    this.stt = null;
    this.startSpotter?.dispose();
    this.startSpotter = null;
    void this.stopVadDetector();
    this.endSpotter?.dispose();
    this.endSpotter = null;
    this.cancelSpotter?.dispose();
    this.cancelSpotter = null;
    this.turnBuffer?.dispose();
    this.turnBuffer = null;
    this.vadSpeechEndPending = false;
    this.endPhrasePending = false;
    this.capturingUtterance = false;
    this.vadListening = false;
    this.listeningForEndPhrase = false;
    this.clearEndSubmitTimer();
    this.meterMicChain?.dispose();
    this.meterMicChain = null;
    this.micTracks.clear();
    this.micMuted = false;
    if (this.ownsSharedMic) {
      this.sharedMicStream?.getTracks().forEach((t) => t.stop());
    }
    this.sharedMicStream = null;
    this.ownsSharedMic = false;
    stopAllTts();
    stopAmazonTts();
    this.ttsPile.interrupt();
    this.ws?.close();
    this.ws = null;
  }

  injectNarration(text: string): void {
    this.enqueueSpeak(text);
    this.cb.onAssistantTranscript(text);
  }

  /** Typed message — works even before wake phrase (skips wake gate). */
  sendTextTurn(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.closed || this.orchestratorBusy) return;
    if (!this.wsConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.cb.onSttError?.('Not connected — tap the orb to start a session.');
      return;
    }
    if (!this.voiceActivated) {
      this.voiceActivated = true;
      this.cb.onActivated?.('(typed input)');
    }
    this.cb.onUserTranscript(trimmed);
    this.sendUserTurn(trimmed);
  }

  private async ensureSharedMic(): Promise<MediaStream> {
    if (this.sharedMicStream) return this.sharedMicStream;
    this.sharedMicStream = await captureMicStream();
    this.ownsSharedMic = true;
    this.registerMicStream(this.sharedMicStream);
    return this.sharedMicStream;
  }

  private async attachMicMeter(stream?: MediaStream): Promise<void> {
    try {
      const mic = stream ?? (await this.ensureSharedMic());
      const ctx = getSharedAudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      this.meterMicChain = createMicProcessingChain(mic, { highPassHz: 120 });
      const tap = getVoiceAudioMeter().tapMic(ctx, this.meterMicChain.output);
      connectSilentSink(ctx, tap);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cb.onSttError?.(`Microphone unavailable: ${message}`);
    }
  }

  /** Idle phase — Vosk only; no STT pipeline (no Transcribe cost). */
  private async startWakeWordPhase(): Promise<void> {
    await this.ensureSharedMic();

    if (!isCrossOriginIsolated()) {
      this.cb.onSttError?.(wakePhraseCoopError());
      return;
    }

    await this.armStartSpotter();
  }

  /** Re-arm wake Vosk when idle — safe to call after TTS or turn_complete. */
  private ensureWakeListening(): void {
    if (
      this.closed ||
      this.voiceActivated ||
      this.capturingUtterance ||
      this.vadListening ||
      this.listeningForEndPhrase ||
      this.ttsSpeaking
    ) {
      return;
    }
    if (!isCrossOriginIsolated()) return;
    if (!this.startSpotter) {
      void this.armStartSpotter();
    } else {
      this.startSpotter.resume();
    }
  }

  private async armStartSpotter(): Promise<void> {
    const start = this.wakeWords.start.trim();
    if (!start) {
      this.cb.onSttError?.('No wake phrase configured — set wakeWords.start on the Voice tab.');
      return;
    }
    if (!isCrossOriginIsolated() || this.closed) return;

    this.stopStartSpotter();
    try {
      this.startSpotter = new VoskGrammarSpotter({
        onMatch: (_phrase, heard) => void this.onVoskStartDetected(heard),
        onError: (message) => {
          console.warn('[vosk-start]', message);
          this.cb.onSttError?.(`Wake phrase spotter: ${message}`);
        },
      });
      const mic = this.sharedMicStream ?? (await this.ensureSharedMic());
      await this.startSpotter.start(start, {
        mediaStream: mic,
        ...wakeSpotterOptions(this.wakeWords.sensitivity),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[vosk-start]', message);
      this.startSpotter?.dispose();
      this.startSpotter = null;
      this.cb.onSttError?.(`Wake phrase spotter failed: ${message}`);
    }
  }

  /** After VAD speech-end or turn complete — Vosk wake only, orb back to inactive/red. */
  private async returnToWakeListen(): Promise<void> {
    if (this.closed) return;
    this.voiceActivated = false;
    this.capturingUtterance = false;
    this.vadListening = false;
    this.listeningForEndPhrase = false;
    void this.stopVadDetector();
    this.stopEndSpotter();
    if (this.stt instanceof WebkitSttSession) {
      this.stt.pause();
    }
    this.cb.onDeactivated?.();
    await this.armStartSpotter();
  }

  /** Wake phrase heard while assistant TTS is playing — pause speech; agent keeps running. */
  private bargeInDuringTts(): void {
    if (!this.ttsPile.isActive() && !this.ttsPile.isBargeInPaused()) return;

    const snap = this.ttsPile.pauseForBargeIn();
    const payload = snapshotToPayload(snap);
    if (payload) {
      this.pendingTtsInterrupt = withLastHeardWords(payload);
      this.cb.onTtsBargeIn?.(summarizeTtsInterrupt(this.pendingTtsInterrupt));
    }
    this.voiceLog('tts', 'info', 'TTS paused', 'wake barge-in — cancel resumes, submit sends last-heard context');
    this.notifySpeakingState(false);
  }

  /**
   * During TTS, ignore wake detections that match the line being spoken — that is
   * acoustic echo from the assistant saying the wake phrase, not a user barge-in.
   */
  private isTtsWakeWordEcho(heard: string): boolean {
    const wake = this.wakeWords.start.trim();
    if (!wake || !voskPhraseMatches(heard, wake)) return false;

    const ttsLine = this.ttsPile.getCurrentLine();
    if (!ttsLine) return false;

    return textContainsWakePhrase(ttsLine, wake);
  }

  private async onVoskStartDetected(heard: string): Promise<void> {
    if (this.closed) return;

    if ((this.ttsSpeaking || this.ttsPile.isActive()) && !this.ttsPile.isBargeInPaused()) {
      if (this.isTtsWakeWordEcho(heard)) {
        this.startSpotter?.resetTrigger();
        this.voiceLog('pipeline', 'debug', 'Wake ignored — TTS echo', heard);
        return;
      }
      this.bargeInDuringTts();
    }

    if (
      this.voiceActivated &&
      (this.capturingUtterance ||
        this.vadListening ||
        this.listeningForEndPhrase ||
        this.vadSpeechEndPending ||
        this.endPhrasePending)
    ) {
      return;
    }
    if (this.voiceActivated) {
      this.exitCapturePhase();
      this.voiceActivated = false;
    }
    this.stopStartSpotter();
    this.voiceActivated = true;
    playVoiceCueNow('listening');
    this.cb.onActivated?.(this.wakeWords.start);
    await this.enterCapturePhase();
  }

  private stopStartSpotter(): void {
    this.startSpotter?.dispose();
    this.startSpotter = null;
  }

  private async stopVadDetector(): Promise<void> {
    await this.vadDetector?.dispose();
    this.vadDetector = null;
    this.vadListening = false;
  }

  private stopEndSpotter(): void {
    this.endSpotter?.dispose();
    this.endSpotter = null;
    this.listeningForEndPhrase = false;
  }

  private stopCancelSpotter(): void {
    this.cancelSpotter?.dispose();
    this.cancelSpotter = null;
  }

  /** Vosk cancel phrase heard during capture — abort turn; resume paused TTS if any. */
  private onCancelDetected(): void {
    if (this.closed || !this.voiceActivated) return;
    if (this.ttsPile.isBargeInPaused()) {
      this.ttsPile.resumeAfterBargeInCancel();
      this.pendingTtsInterrupt = null;
      this.notifySpeakingState(this.ttsPile.isActive());
      this.voiceLog('tts', 'info', 'TTS resumed', 'cancel after barge-in');
    }
    playVoiceCueNow('cancel');
    console.debug('[cancel] turn cancelled by user');
    this.cb.onTurnCancelled?.(this.wakeWords.cancel?.trim() || 'cancel');
    this.exitCapturePhase();
    this.voiceActivated = false;
    this.capturingUtterance = false;
    this.vadSpeechEndPending = false;
    this.endPhrasePending = false;
    this.turnBuffer?.dispose();
    this.turnBuffer = null;
    this.cb.onDeactivated?.();
    void this.armStartSpotter();
  }

  private async armCancelSpotter(): Promise<void> {
    const cancel = this.wakeWords.cancel?.trim();
    if (!cancel || !isCrossOriginIsolated()) return;

    this.stopCancelSpotter();
    try {
      this.cancelSpotter = new VoskGrammarSpotter({
        onMatch: () => this.onCancelDetected(),
        onError: (message) => console.warn('[vosk-cancel]', message),
      });
      const mic = this.sharedMicStream ?? (await this.ensureSharedMic());
      await this.cancelSpotter.start(cancel, { mediaStream: mic, matchPartial: false });
    } catch (err) {
      console.warn('[vosk-cancel]', err);
      this.cancelSpotter?.dispose();
      this.cancelSpotter = null;
    }
  }

  private exitCapturePhase(): void {
    this.vadListening = false;
    this.listeningForEndPhrase = false;
    void this.stopVadDetector();
    this.stopEndSpotter();
    this.stopCancelSpotter();
    this.clearEndSubmitTimer();
    this.vadSpeechEndPending = false;
    this.endPhrasePending = false;
    this.endUtteranceCapture(true);
  }

  /** Vosk wake heard — open STT stream, arm VAD or end-phrase spotter. */
  private async enterCapturePhase(): Promise<void> {
    this.capturePhaseStartedAt = Date.now();
    this.resetTurnBuffer();
    await this.attachMicMeter(this.sharedMicStream ?? undefined);
    await this.beginUtteranceCapture();
    if (this.closed || !this.voiceActivated) return;
    if (this.usesVad()) {
      await this.armVadDetector();
    } else if (this.usesEndPhraseSubmit()) {
      await this.armEndPhraseSpotter();
    }
    if (this.closed || !this.voiceActivated) return;
    // Cancel spotter runs throughout the capture phase — lets user say "cancel"
    // to abort the turn silently without sending anything.
    await this.armCancelSpotter();
  }

  private resetTurnBuffer(): void {
    this.turnBuffer?.dispose();
    if (this.usesVad()) {
      this.turnBuffer = new TurnSubmitBuffer({
        silenceMs: 0,
        onSubmit: (text, reason) => this.flushTurn(text, reason),
      });
      return;
    }
    const endPhraseMode = this.usesEndPhraseSubmit();
    this.turnBuffer = new TurnSubmitBuffer({
      silenceMs: endPhraseMode ? 0 : this.turnSubmit.silenceMs,
      endPhrase: this.wakeWords.end,
      onSubmit: (text, reason) => this.flushTurn(text, reason),
    });
  }

  /** Silero VAD handles turn end when enabled. */
  private usesVad(): boolean {
    return this.turnSubmit.vadEnabled !== false;
  }

  /** End phrase via Vosk when VAD is off — silence timer and Amazon VAD must not auto-submit. */
  private usesEndPhraseSubmit(): boolean {
    return (
      !this.usesVad() &&
      Boolean(this.wakeWords.end.trim()) &&
      isCrossOriginIsolated()
    );
  }

  private recoverCaptureError(): void {
    this.vadSpeechEndPending = false;
    this.endPhrasePending = false;
    this.clearEndSubmitTimer();
    this.exitCapturePhase();
    this.turnBuffer?.dispose();
    this.turnBuffer = null;
    void this.returnToWakeListen();
  }

  private async ensureMicMeter(): Promise<void> {
    if (this.meterMicChain) return;
    await this.attachMicMeter(this.sharedMicStream ?? undefined);
  }

  /** Create STT hardware once (mic tap); utterances use beginUtteranceCapture(). */
  private async ensureSttPipeline(): Promise<void> {
    await this.ensureMicMeter();
    if (this.stt) return;

    if (this.sttBackend === 'webkit') {
      this.stt = new WebkitSttSession('en-US', this.sttGate, {
        onInterim: (text) => this.onSttPartial(text),
        onFinal: (text) => this.onUserText(text),
        onError: (message) => {
          console.warn('[webkit-stt]', message);
          this.voiceLog('stt', 'error', 'Browser STT error', message);
          this.cb.onSttError?.(message);
          if (this.vadSpeechEndPending || this.endPhrasePending || this.capturingUtterance) {
            this.recoverCaptureError();
          }
        },
        onEnd: () => {
          if (this.closed || this.sttGate.isPaused() || !this.capturingUtterance) return;
          if (this.stt instanceof WebkitSttSession) {
            window.setTimeout(() => {
              if (this.capturingUtterance && !this.sttGate.isPaused()) {
                this.stt?.start();
              }
            }, 250);
          }
        },
      });
      return;
    }

    if (this.sttBackend === 'amazon_transcribe') {
      const amazon = new AmazonSttSession(this.bridgeBase, this.appToken, this.sttGate, {
        onInterim: (text) => this.onSttPartial(text),
        onFinal: (text) => this.onUserText(text),
        onError: (message) => {
          console.warn('[amazon-stt]', message);
          this.voiceLog('stt', 'error', 'Amazon Transcribe error', message);
          this.cb.onSttError?.(message);
          if (this.vadSpeechEndPending || this.endPhrasePending || this.capturingUtterance) {
            this.recoverCaptureError();
          }
        },
      });
      this.stt = amazon;
    }
  }

  /** Vosk cut-in: start buffering audio for one utterance. */
  private async beginUtteranceCapture(): Promise<void> {
    if (!this.voiceActivated || this.closed) return;
    await this.ensureSttPipeline();
    if (this.stt instanceof AmazonSttSession) {
      await this.stt.start(this.sharedMicStream ?? undefined);
    }
    this.capturingUtterance = true;
    this.lastLoggedSttPartial = '';
    this.voiceLog('stt', 'info', `${this.sttProviderLabel()} listening`);
    const silenceFlush =
      !this.usesVad() && !this.usesEndPhraseSubmit() && this.turnSubmit.silenceMs > 0;
    if (this.stt instanceof AmazonSttSession) {
      this.stt.beginCapture({ silenceFlush });
    } else if (this.stt instanceof WebkitSttSession) {
      this.stt.start();
    }
  }

  /** Vosk cut-out: stop buffering (optionally discard buffered audio). */
  private endUtteranceCapture(discard = false): void {
    this.capturingUtterance = false;
    if (this.stt instanceof AmazonSttSession) {
      if (discard) this.stt.endCapture();
      else this.stt.freezeCapture();
    } else if (this.stt instanceof WebkitSttSession) {
      this.stt.pause();
    }
  }

  private async armVadDetector(): Promise<void> {
    if (!this.voiceActivated) return;

    await this.stopVadDetector();
    this.vadDetector = new SileroVadDetector();

    try {
      const mic = this.sharedMicStream ?? (await this.ensureSharedMic());
      await this.vadDetector.start(mic, {
        redemptionMs: this.turnSubmit.silenceMs,
        onSpeechEnd: () => this.onVadSpeechEnd(),
        onError: (message) => {
          console.warn('[silero-vad]', message);
          this.cb.onSttError?.(`Silero VAD: ${message}`);
        },
      });
      this.vadListening = true;
      this.cb.onVadArmed?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[silero-vad]', err);
      await this.stopVadDetector();
      this.cb.onSttError?.(`Silero VAD failed: ${message}`);
    }
  }

  /** Silero VAD speech-end — freeze mic, transcribe once, return to wake listen immediately. */
  private onVadSpeechEnd(): void {
    if (this.closed || !this.vadListening || !this.voiceActivated) {
      return;
    }
    if (Date.now() - this.capturePhaseStartedAt < this.minSpeechEndMs) {
      console.debug('[silero-vad] ignored — too soon after wake');
      return;
    }
    playVoiceCueNow('sent');
    this.vadSpeechEndPending = true;
    this.vadListening = false;
    void this.stopVadDetector();
    this.cb.onVadDetected?.();
    this.endUtteranceCapture(false);
    if (this.stt instanceof WebkitSttSession) {
      this.flushSttNow();
    }
    void this.returnToWakeListen();
    this.scheduleVadSubmit();
  }

  private async armEndPhraseSpotter(): Promise<void> {
    const end = this.wakeWords.end.trim();
    if (!end) {
      this.cb.onSttError?.(
        'No end phrase configured — set wakeWords.end on the Voice tab or enable VAD.',
      );
      return;
    }
    if (!isCrossOriginIsolated()) {
      this.cb.onSttError?.('End phrase Vosk needs COOP/COEP — enable VAD or use silence submit.');
      return;
    }
    if (!this.voiceActivated) return;

    this.stopEndSpotter();
    this.endSpotter = new VoskGrammarSpotter({
      onMatch: () => this.onEndPhraseHeard(),
      onError: (message) => {
        console.warn('[vosk-end]', message);
        this.cb.onSttError?.(`End phrase spotter: ${message}`);
      },
    });

    try {
      const mic = this.sharedMicStream ?? (await this.ensureSharedMic());
      const voskMic = cloneMicForVosk(mic);
      await this.endSpotter.start(end, {
        mediaStream: voskMic,
        matchPartial: false,
      });
      this.listeningForEndPhrase = true;
      this.cb.onEndPhraseArmed?.(end);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[vosk-end]', err);
      this.stopEndSpotter();
      this.cb.onSttError?.(`End phrase spotter failed: ${message}`);
    }
  }

  /** Vosk end phrase — freeze mic, transcribe once, return to wake listen immediately. */
  private onEndPhraseHeard(): void {
    if (this.closed || !this.listeningForEndPhrase || !this.voiceActivated) {
      return;
    }
    if (Date.now() - this.capturePhaseStartedAt < this.minSpeechEndMs) {
      console.debug('[end-phrase] ignored — too soon after wake');
      return;
    }
    playVoiceCueNow('sent');
    this.endPhrasePending = true;
    this.listeningForEndPhrase = false;
    this.stopEndSpotter();
    this.cb.onEndPhraseDetected?.(this.wakeWords.end);
    this.endUtteranceCapture(false);
    if (this.stt instanceof WebkitSttSession) {
      this.flushSttNow();
    }
    void this.returnToWakeListen();
    this.scheduleTurnSubmit('end_word');
  }

  private flushSttNow(): void {
    if (this.stt instanceof AmazonSttSession) {
      this.stt.flushNow();
    } else if (this.stt instanceof WebkitSttSession) {
      this.stt.flushNow();
    }
  }

  private enqueueSpeech(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.turnBuffer) return;
    this.cb.onUserTranscript(trimmed);
    this.turnBuffer.append(trimmed);
    if (this.vadSpeechEndPending && this.turnBuffer.submitNow('vad')) {
      this.vadSpeechEndPending = false;
      this.clearEndSubmitTimer();
    }
    if (this.endPhrasePending && this.turnBuffer.submitNow('end_word')) {
      this.endPhrasePending = false;
      this.clearEndSubmitTimer();
    }
  }

  private scheduleTurnSubmit(reason: 'vad' | 'end_word'): void {
    this.clearEndSubmitTimer();
    if (this.stt instanceof AmazonSttSession) {
      void this.submitAmazonTurn(reason);
      return;
    }
    this.endSubmitTimer = window.setTimeout(() => this.pollTurnSubmit(reason, 0), 50);
  }

  /** Await Amazon Transcribe — single flush path (WebKit uses pollTurnSubmit instead). */
  private async submitAmazonTurn(reason: 'vad' | 'end_word'): Promise<void> {
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    if (this.closed || !(this.stt instanceof AmazonSttSession)) return;

    try {
      await this.stt.flushNowAsync();
    } catch {
      return;
    }

    if (reason === 'vad' ? !this.vadSpeechEndPending : !this.endPhrasePending) {
      return;
    }

    if (this.turnBuffer?.submitNow(reason)) {
      if (reason === 'vad') this.vadSpeechEndPending = false;
      if (reason === 'end_word') this.endPhrasePending = false;
      return;
    }

    this.failTurnSubmit(reason, this.turnBuffer?.text() ?? '');
  }

  private pollTurnSubmit(reason: 'vad' | 'end_word', attempt: number): void {
    if (this.closed) return;
    if (this.turnBuffer?.submitNow(reason)) {
      if (reason === 'vad') this.vadSpeechEndPending = false;
      if (reason === 'end_word') this.endPhrasePending = false;
      return;
    }
    const buffered = this.turnBuffer?.text() ?? '';
    const maxAttempts = 75;
    const retryMs = 400;
    if (attempt < maxAttempts) {
      this.endSubmitTimer = window.setTimeout(() => this.pollTurnSubmit(reason, attempt + 1), retryMs);
      return;
    }
    this.failTurnSubmit(reason, buffered);
  }

  private failTurnSubmit(reason: 'vad' | 'end_word', buffered: string): void {
    if (reason === 'vad') this.vadSpeechEndPending = false;
    if (reason === 'end_word') this.endPhrasePending = false;
    if (this.stt instanceof AmazonSttSession) this.stt.endCapture();
    if (buffered) {
      const hint =
        reason === 'end_word'
          ? `Say your request after "${this.wakeWords.start}", then "${this.wakeWords.end}".`
          : `Say your request after "${this.wakeWords.start}".`;
      this.cb.onSttError?.(
        `Could not send — transcript was only "${buffered.slice(0, 40)}". ${hint}`,
      );
    } else {
      this.cb.onSttError?.(
        reason === 'end_word'
          ? 'End phrase heard but transcription failed — check Amazon Transcribe config and speak clearly after the wake phrase.'
          : 'Speech ended but transcription failed — check Amazon Transcribe config and speak clearly after the wake phrase.',
      );
    }
    this.recoverCaptureError();
  }

  private scheduleVadSubmit(): void {
    this.scheduleTurnSubmit('vad');
  }

  private clearEndSubmitTimer(): void {
    if (this.endSubmitTimer) {
      window.clearTimeout(this.endSubmitTimer);
      this.endSubmitTimer = 0;
    }
  }

  private flushTurn(text: string, reason: 'silence' | 'vad' | 'end_word'): void {
    if (this.closed) return;
    if (!this.capturingUtterance && !this.vadSpeechEndPending && !this.endPhrasePending) {
      return;
    }
    if (reason === 'silence') {
      playVoiceCueNow('sent');
    }
    this.exitCapturePhase();
    this.vadSpeechEndPending = false;
    this.endPhrasePending = false;
    this.clearEndSubmitTimer();
    if (this.stt instanceof AmazonSttSession) this.stt.endCapture();
    this.sendUserTurn(text);
    this.cb.onTurnSubmitted?.(reason);
    console.debug('[turn-submit]', reason, text.slice(0, 80));
    void this.returnToWakeListen();
  }

  /** STT transcript for the current utterance only (Vosk wake + VAD/end phrase gate boundaries). */
  private onUserText(text: string): void {
    if (this.closed) return;
    if (!this.capturingUtterance && !this.vadSpeechEndPending && !this.endPhrasePending) {
      return;
    }
    const trimmed = text.trim();
    if (trimmed) {
      this.voiceLog('stt', 'info', `${this.sttProviderLabel()} final`, trimmed.slice(0, 120));
    }
    if (this.stt instanceof AmazonSttSession && this.capturingUtterance) {
      this.endUtteranceCapture(false);
    }
    this.enqueueSpeech(text);
  }

  private onSttPartial(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || trimmed === this.lastLoggedSttPartial) return;
    this.lastLoggedSttPartial = trimmed;
    this.voiceLog('stt', 'info', `${this.sttProviderLabel()} partial`, trimmed.slice(0, 120));
  }

  private sendUserTurn(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.ttsPile.isBargeInPaused()) {
      const snap = this.ttsPile.finalizeBargeInOnSubmit();
      const payload = snapshotToPayload(snap);
      if (payload) {
        this.pendingTtsInterrupt = withLastHeardWords(payload);
      }
      this.notifySpeakingState(false);
    }

    const payload: Record<string, unknown> = { type: 'user_turn', text };
    if (this.pendingTtsInterrupt) {
      payload['tts_interrupt'] = this.pendingTtsInterrupt;
      this.pendingTtsInterrupt = null;
    } else if (isInterruptPhrase(text)) {
      payload['is_interrupt'] = true;
    }
    this.ws.send(JSON.stringify(payload));
  }

  private syncCapture(): void {
    if (this.sttGate.isPaused()) {
      if (this.stt instanceof WebkitSttSession) this.stt.pause();
      if (this.vadListening) this.vadDetector?.pause();
      if (this.listeningForEndPhrase) this.endSpotter?.pause();
    } else {
      if (this.capturingUtterance && this.stt instanceof WebkitSttSession) {
        this.stt.resume();
      }
      if (this.vadListening) this.vadDetector?.resume();
      if (this.listeningForEndPhrase) this.endSpotter?.resume();
    }
  }

  private handleMessage(
    raw: string,
    hooks: { onAuthOk: () => void; onError: (message: string) => void },
  ): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg['type']) {
      case 'auth_ok': {
        const wake = msg['wakeWords'] as WakeWords | undefined;
        this.wakeWords = wake ?? { start: '', end: 'send' };
        const submit = msg['turnSubmit'] as TurnSubmit | undefined;
        this.turnSubmit = submit ?? { silenceMs: 1500, vadEnabled: true };
        if (msg['tts'] && typeof msg['tts'] === 'object') {
          this.ttsSettings = msg['tts'] as VoiceTtsSettings;
          this.resolvedWebkitTts = resolveBrowserTtsOptions(this.ttsSettings.webkit);
          this.ttsPile.setBaseVolume(this.resolvedWebkitTts.volume);
        }
        if (msg['audio'] && typeof msg['audio'] === 'object') {
          this.audioConfig = msg['audio'] as IntelligenceAudioConfig;
        }
        hooks.onAuthOk();
        break;
      }

      case 'speak': {
        const text = typeof msg['text'] === 'string' ? msg['text'] : '';
        if (text && this.ttsSettings.cursorVoiceEnabled) {
          cancelTtsFallback();
          if (!this.ttsPile.isActive()) {
            this.ttsPile.resetHeard();
          }
          this.enqueueSpeak(text);
        } else if (text) {
          this.cb.onAssistantTranscript(text);
        }
        break;
      }

      case 'narration': {
        const text = typeof msg['text'] === 'string' ? msg['text'] : '';
        if (text && this.ttsSettings.cursorVoiceEnabled) {
          this.enqueueSpeak(text);
          this.cb.onAssistantTranscript(text);
        } else if (text) {
          this.cb.onAssistantTranscript(text);
        }
        break;
      }

      case 'assistant_transcript': {
        const text = typeof msg['text'] === 'string' ? msg['text'] : '';
        if (text) this.cb.onAssistantTranscript(text);
        break;
      }

      case 'thinking':
        this.orchestratorBusy = Boolean(msg['value']);
        this.cb.onWorking(this.orchestratorBusy);
        this.syncCapture();
        break;

      case 'tool_activity': {
        const tool = String(msg['tool'] ?? '');
        const phase = msg['phase'] as 'start' | 'done' | 'error' | undefined;
        const label = String(msg['label'] ?? tool);
        if (phase && tool) {
          this.cb.onToolActivity?.({
            tool,
            phase,
            label,
            detail: typeof msg['detail'] === 'string' ? msg['detail'] : undefined,
          });
        }
        break;
      }

      case 'session_log': {
        const subcategory = msg['subcategory'] as VoiceLogSubcategory | undefined;
        const level = (msg['level'] as VoiceLogLevel | undefined) ?? 'info';
        const summary = typeof msg['summary'] === 'string' ? msg['summary'] : '';
        if (subcategory && summary) {
          this.cb.onVoiceLog?.({
            subcategory,
            level,
            summary,
            detail: typeof msg['detail'] === 'string' ? msg['detail'] : undefined,
          });
        }
        break;
      }

      case 'voice_agent_status': {
        const runId = typeof msg['run_id'] === 'string' ? msg['run_id'] : '';
        const pid = typeof msg['pid'] === 'number' ? msg['pid'] : 0;
        const sessionId =
          typeof msg['session_id'] === 'string' ? msg['session_id'] : null;
        const mcpSessionId =
          typeof msg['mcp_session_id'] === 'string' ? msg['mcp_session_id'] : null;
        const state = msg['state'] as VoiceAgentStatusEvent['state'] | undefined;
        const project = typeof msg['project'] === 'string' ? msg['project'] : '';
        if (runId && state && project) {
          this.cb.onVoiceAgentStatus?.({
            runId,
            pid,
            sessionId,
            mcpSessionId,
            state,
            project,
          });
        }
        break;
      }

      case 'turn_complete':
        this.orchestratorBusy = false;
        this.vadSpeechEndPending = false;
        this.endPhrasePending = false;
        this.turnBuffer?.dispose();
        this.turnBuffer = null;
        this.ttsPile.resetHeard();
        this.pendingTtsInterrupt = null;
        this.cb.onWorking(false);
        this.cb.onTurnComplete?.();
        void this.returnToWakeListen();
        break;

      case 'error': {
        const message = String(msg['message'] ?? 'Intelligence session error');
        if (this.wsConnected) {
          this.orchestratorBusy = false;
          this.cb.onWorking(false);
          this.syncCapture();
          this.cb.onTurnError?.(message);
          break;
        }
        hooks.onError(message);
        break;
      }

      default:
        break;
    }
  }

  /** Queue speak lines from MCP — piles and plays sequentially. */
  private enqueueSpeak(text: string): void {
    if (!this.ttsSettings.cursorVoiceEnabled) return;
    this.ttsPile.enqueue(text);
  }

  /** Refresh per-browser TTS options (call after Config tab saves local profile). */
  refreshBrowserTtsOptions(): void {
    this.resolvedWebkitTts = resolveBrowserTtsOptions(this.ttsSettings.webkit);
    this.ttsPile.setBaseVolume(this.resolvedWebkitTts.volume);
  }

  /** Error earcon + optional spoken alert (independent of cursorVoiceEnabled). */
  notifyError(message: string): void {
    const trimmed = message.trim();
    if (!trimmed) return;

    const now = Date.now();
    if (trimmed === this.lastErrorFeedbackMessage && now - this.lastErrorFeedbackAt < 2000) {
      return;
    }
    this.lastErrorFeedbackMessage = trimmed;
    this.lastErrorFeedbackAt = now;

    if (this.ttsSettings.errorSoundEnabled) {
      playVoiceCueNow('error', { force: true });
    }
    if (this.ttsSettings.errorSpeakEnabled) {
      this.ttsPile.enqueue(errorSpeechText(trimmed));
    }
  }

  private async playSpeakUtterance(text: string, ctx: TtsPlayContext): Promise<void> {
    const provider = this.ttsProviderLabel();
    this.voiceLog('tts', 'info', `${provider} start`, text.slice(0, 80));
    const webkitOpts = {
      rate: this.resolvedWebkitTts.rate,
      pitch: this.resolvedWebkitTts.pitch,
      lang: this.resolvedWebkitTts.lang,
      voiceURI: this.resolvedWebkitTts.voiceURI,
    };
    let playbackStarted = false;
    const wrappedCtx: TtsPlayContext = {
      signal: ctx.signal,
      baseVolume: ctx.baseVolume,
      volume: ctx.volume,
      onStart: () => {
        playbackStarted = true;
        this.voiceLog('tts', 'info', `${provider} playing`, text.slice(0, 80));
        ctx.onStart();
      },
    };

    try {
      if (this.ttsBackend === 'webkit') {
        await this.playWebkit(text, wrappedCtx, webkitOpts);
      } else if (this.ttsBackend === 'amazon_polly') {
        await speakAmazonPolly(text, this.bridgeBase, this.appToken, wrappedCtx);
      } else if (canUseWebkitTts()) {
        await this.playWebkit(text, wrappedCtx, webkitOpts);
      } else if (this.audioConfig.amazonAvailable) {
        await speakAmazonPolly(text, this.bridgeBase, this.appToken, wrappedCtx);
      } else {
        console.warn('[tts] no TTS backend — text only:', text.slice(0, 80));
        wrappedCtx.onStart();
      }
      if (!ctx.signal.aborted) {
        this.voiceLog('tts', 'info', `${provider} done`, text.slice(0, 80));
      }
    } catch (err) {
      if (ctx.signal.aborted) {
        this.voiceLog('tts', 'info', `${provider} cancelled`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.voiceLog('tts', 'error', `${provider} error`, message.slice(0, 120));
      console.warn('[tts]', err);
      if (this.ttsBackend === 'webkit' && this.audioConfig.amazonAvailable) {
        try {
          await speakAmazonPolly(text, this.bridgeBase, this.appToken, wrappedCtx);
          if (!ctx.signal.aborted) {
            this.voiceLog('tts', 'info', 'Amazon Polly done (fallback)', text.slice(0, 80));
          }
        } catch (pollyErr) {
          const pollyMsg = pollyErr instanceof Error ? pollyErr.message : String(pollyErr);
          this.voiceLog('tts', 'error', 'Amazon Polly fallback error', pollyMsg.slice(0, 120));
          console.warn('[tts polly fallback]', pollyErr);
        }
      } else if (canUseWebkitTts()) {
        try {
          await this.playWebkit(text, wrappedCtx, webkitOpts);
          if (!ctx.signal.aborted) {
            this.voiceLog('tts', 'info', 'Browser TTS done (fallback)', text.slice(0, 80));
          }
        } catch (webkitErr) {
          const webkitMsg = webkitErr instanceof Error ? webkitErr.message : String(webkitErr);
          this.voiceLog('tts', 'error', 'Browser TTS fallback error', webkitMsg.slice(0, 120));
          console.warn('[tts webkit fallback]', webkitErr);
        }
      }
    }

    const hadTtsBackend =
      this.ttsBackend !== 'none' || canUseWebkitTts() || this.audioConfig.amazonAvailable;
    if (!playbackStarted && hadTtsBackend && !ctx.signal.aborted) {
      this.notifyError('Speech playback failed.');
    }
  }

  private playWebkit(
    text: string,
    ctx: TtsPlayContext,
    opts?: { rate?: number; pitch?: number; lang?: string; voiceURI?: string },
  ): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        resolve();
        return;
      }
      if (ctx.signal.aborted) {
        resolve();
        return;
      }

      window.speechSynthesis.getVoices();
      prepareSpeechSynthesisForPlayback();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = opts?.rate ?? 1.02;
      utter.pitch = opts?.pitch ?? 1;
      utter.lang = opts?.lang ?? 'en-US';
      if (opts?.voiceURI) {
        const voice = window.speechSynthesis
          .getVoices()
          .find((v) => v.voiceURI === opts.voiceURI);
        if (voice) utter.voice = voice;
      }
      utter.volume = ctx.baseVolume;

      const finish = () => {
        ctx.signal.removeEventListener('abort', onAbort);
        resolve();
      };

      const onAbort = () => {
        window.speechSynthesis.cancel();
        finish();
      };

      ctx.signal.addEventListener('abort', onAbort, { once: true });

      const applyVolume = (multiplier: number) => {
        utter.volume = Math.max(0, Math.min(1, ctx.baseVolume * multiplier));
      };
      const origSetVolume = ctx.volume.setVolume.bind(ctx.volume);
      ctx.volume.setVolume = (multiplier: number) => {
        origSetVolume(multiplier);
        applyVolume(multiplier);
      };

      utter.onstart = () => ctx.onStart();
      utter.onend = () => {
        // Cancel after onend to prevent Chrome's ghost-restart loop.
        window.speechSynthesis.cancel();
        finish();
      };
      utter.onerror = (ev) => {
        console.warn('[tts webkit]', ev.error ?? 'error');
        finish();
      };
      // Cancel any lingering synthesis before queuing the next utterance.
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utter);
    });
  }

  private notifySpeakingState(speaking: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'speaking', value: speaking }));
  }

  private voiceLog(
    subcategory: VoiceLogSubcategory,
    level: VoiceLogLevel,
    summary: string,
    detail?: string,
  ): void {
    this.cb.onVoiceLog?.({ subcategory, level, summary, detail });
  }

  private sttProviderLabel(): string {
    if (this.sttBackend === 'webkit') return 'Browser STT';
    if (this.sttBackend === 'amazon_transcribe') return 'Amazon Transcribe';
    return 'STT';
  }

  private ttsProviderLabel(): string {
    if (this.ttsBackend === 'webkit') return 'Browser TTS';
    if (this.ttsBackend === 'amazon_polly') return 'Amazon Polly';
    if (canUseWebkitTts()) return 'Browser TTS';
    if (this.audioConfig.amazonAvailable) return 'Amazon Polly';
    return 'TTS';
  }
}

/** Separate mic tap for Vosk so STT ScriptProcessors do not starve the spotter. */
function cloneMicForVosk(mic: MediaStream): MediaStream {
  const track = mic.getAudioTracks()[0];
  if (track && typeof track.clone === 'function') {
    return new MediaStream([track.clone()]);
  }
  return mic;
}

const INTERRUPT_PHRASES = [/\bstop\b/i, /\bcancel\b/i, /\babort\b/i, /\bquit\b/i];

function isInterruptPhrase(text: string): boolean {
  return INTERRUPT_PHRASES.some((re) => re.test(text));
}
