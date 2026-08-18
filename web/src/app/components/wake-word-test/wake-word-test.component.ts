import { NgClass } from '@angular/common';
import type { OnDestroy, OnInit } from '@angular/core';
import { Component, computed, inject, signal } from '@angular/core';

import { Button } from '@openng/optimus-ui/button';
import { Card } from '@openng/optimus-ui/card';
import { Message } from '@openng/optimus-ui/message';
import { Tag } from '@openng/optimus-ui/tag';

import { captureMicStream, unlockAudioContext } from '../../../audio.js';
import { playVoiceCueNow } from '../../../sound-effects.js';
import { isCrossOriginIsolated } from '../../../cross-origin-isolation.js';
import { DEFAULT_REDEMPTION_MS, SileroVadDetector } from '../../../silero-vad.js';
import {
  VoskGrammarSpotter,
  wakeSpotterOptions,
} from '../../../vosk-wake-word.js';
import { phrasesConflict, resolveWakeConfidenceThreshold } from '../../../wake-words.js';
import { VoiceProvidersService } from '../../services/voice-providers.service';

/**
 * Phased test mirroring live voice:
 *   1. awaiting_wake — Vosk listens for start phrase ONLY (red)
 *   2. stt_listening — wake done, STT armed, VAD or end phrase (green)
 */
type TestPhase = 'idle' | 'loading' | 'awaiting_wake' | 'stt_listening' | 'error';

@Component({
  selector: 'cv-wake-word-test',
  standalone: true,
  imports: [Button, Card, Message, NgClass, Tag],
  templateUrl: './wake-word-test.component.html',
  styles: [
    `
      .cv-wake-test {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1.25rem;
        text-align: center;
      }

      .cv-wake-test-orb {
        width: 7rem;
        height: 7rem;
        border-radius: 50%;
        background: radial-gradient(circle at 35% 30%, #fca5a5 0%, #dc2626 55%, #7f1d1d 100%);
        box-shadow:
          0 0 0 0 rgba(239, 68, 68, 0.45),
          0 0 2.5rem rgba(220, 38, 38, 0.35);
        transition:
          background 0.25s ease,
          box-shadow 0.25s ease,
          transform 0.2s ease;
      }

      .cv-wake-test-orb--waiting {
        animation: cv-wake-pulse-red 1.6s ease-in-out infinite;
      }

      .cv-wake-test-orb--active {
        background: radial-gradient(circle at 35% 30%, #bbf7d0 0%, #22c55e 55%, #14532d 100%);
        box-shadow:
          0 0 0 0 rgba(34, 197, 94, 0.55),
          0 0 2.75rem rgba(34, 197, 94, 0.45);
        transform: scale(1.06);
      }

      @keyframes cv-wake-pulse-red {
        0%,
        100% {
          box-shadow:
            0 0 0 0 rgba(239, 68, 68, 0.45),
            0 0 2.5rem rgba(220, 38, 38, 0.35);
        }
        50% {
          box-shadow:
            0 0 0 0.75rem rgba(239, 68, 68, 0),
            0 0 3rem rgba(220, 38, 38, 0.5);
        }
      }

      .cv-wake-test-meta {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 0.5rem;
      }

      .cv-wake-test-status {
        margin: 0;
        opacity: 0.85;
        font-size: 0.9375rem;
        max-width: 26rem;
      }

      .cv-wake-test-partial {
        margin: 0;
        font-family: ui-monospace, monospace;
        font-size: 0.8125rem;
        opacity: 0.65;
        min-height: 1.25rem;
      }
    `,
  ],
})
export class WakeWordTestComponent implements OnInit, OnDestroy {
  private readonly voiceProviders = inject(VoiceProvidersService);

  protected readonly phase = signal<TestPhase>('idle');
  protected readonly statusText = signal('Tap Start to load the Vosk model and open the mic.');
  protected readonly partialText = signal('');
  protected readonly isolated = isCrossOriginIsolated();

  protected readonly startPhrase = computed(
    () => this.voiceProviders.data()?.wakeWords.start?.trim() || '—',
  );

  protected readonly endPhrase = computed(() => {
    const end = this.voiceProviders.data()?.wakeWords.end?.trim();
    return end || null;
  });

  protected readonly vadEnabled = computed(
    () => this.voiceProviders.data()?.turnSubmit.vadEnabled !== false,
  );

  protected readonly silenceMs = computed(
    () => this.voiceProviders.data()?.turnSubmit.silenceMs ?? DEFAULT_REDEMPTION_MS,
  );

  protected readonly phraseConflict = computed(() => {
    const start = this.voiceProviders.data()?.wakeWords.start ?? '';
    const end = this.voiceProviders.data()?.wakeWords.end ?? '';
    return !this.vadEnabled() && phrasesConflict(start, end);
  });

  protected readonly submitModeLabel = computed(() => {
    if (this.vadEnabled()) return 'VAD (Silero)';
    const end = this.endPhrase();
    return end ? `End phrase: "${end}"` : `Silence: ${(this.silenceMs() / 1000).toFixed(1)}s`;
  });

  private micStream: MediaStream | null = null;
  private ownsMic = false;
  private startSpotter: VoskGrammarSpotter | null = null;
  private endSpotter: VoskGrammarSpotter | null = null;
  private sileroVad: SileroVadDetector | null = null;
  private sessionRunning = false;
  private vadListening = false;
  private listeningForEndPhrase = false;
  private capturePhaseStartedAt = 0;
  private readonly minSpeechEndMs = 800;

  ngOnInit(): void {
    void this.voiceProviders.refresh();
  }

  ngOnDestroy(): void {
    this.stop();
  }

  protected orbClass(): Record<string, boolean> {
    const phase = this.phase();
    return {
      'cv-wake-test-orb--waiting': phase === 'loading' || phase === 'awaiting_wake',
      'cv-wake-test-orb--active': phase === 'stt_listening',
    };
  }

  protected phaseLabel(): string {
    switch (this.phase()) {
      case 'loading':
        return 'Loading model';
      case 'awaiting_wake':
        return 'Phase 1 — wake only';
      case 'stt_listening':
        return this.vadEnabled() ? 'Phase 2 — STT + VAD' : 'Phase 2 — STT + end phrase';
      case 'error':
        return 'Error';
      default:
        return 'Idle';
    }
  }

  protected phaseSeverity(): 'success' | 'warn' | 'danger' | 'secondary' | 'info' {
    switch (this.phase()) {
      case 'stt_listening':
        return 'success';
      case 'awaiting_wake':
        return 'info';
      case 'loading':
        return 'warn';
      case 'error':
        return 'danger';
      default:
        return 'secondary';
    }
  }

  protected isRunning(): boolean {
    const phase = this.phase();
    return phase === 'loading' || phase === 'awaiting_wake' || phase === 'stt_listening';
  }

  protected async start(): Promise<void> {
    if (this.isRunning()) return;

    const start = this.startPhrase();
    if (!start || start === '—') {
      this.phase.set('error');
      this.statusText.set('No wake phrase in config — set wakeWords.start on the Voice tab.');
      return;
    }

    if (this.phraseConflict()) {
      this.phase.set('error');
      this.statusText.set('Wake and end phrases must be different words.');
      return;
    }

    this.sessionRunning = true;
    this.partialText.set('');
    this.phase.set('loading');
    this.statusText.set('Loading Vosk model…');

    try {
      await unlockAudioContext();
      if (!this.micStream) {
        this.micStream = await captureMicStream();
        this.ownsMic = true;
      }
      await this.listenForWake();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.phase.set('error');
      this.statusText.set(message);
      this.sessionRunning = false;
    }
  }

  protected stop(): void {
    this.sessionRunning = false;
    this.vadListening = false;
    this.listeningForEndPhrase = false;
    this.teardownSpotters();
    if (this.ownsMic) {
      this.micStream?.getTracks().forEach((t) => t.stop());
    }
    this.micStream = null;
    this.ownsMic = false;
    this.phase.set('idle');
    this.partialText.set('');
    this.statusText.set('Tap Start to load the Vosk model and open the mic.');
  }

  private async listenForWake(): Promise<void> {
    if (!this.sessionRunning || !this.micStream) return;

    this.teardownSpotters();
    this.vadListening = false;
    this.listeningForEndPhrase = false;
    this.phase.set('loading');

    const start = this.startPhrase();
    const end = this.endPhrase();
    this.startSpotter = new VoskGrammarSpotter({
      onStatus: (status) => this.statusText.set(status),
      onReady: () => {
        this.phase.set('awaiting_wake');
        this.statusText.set(
          end && !this.vadEnabled()
            ? `Red — wake phrase only. Say "${start}" (the end phrase "${end}" is ignored here).`
            : `Red — say "${start}" to turn green.`,
        );
      },
      onPartial: (text) => {
        if (this.phase() === 'awaiting_wake') {
          this.partialText.set(text.trim());
        }
      },
      onMatch: () => void this.onWakeDetected(),
      onError: (message) => {
        this.phase.set('error');
        this.statusText.set(message);
        this.sessionRunning = false;
      },
    });

    await this.startSpotter.start(start, {
      mediaStream: this.micStream,
      ...wakeSpotterOptions(
        resolveWakeConfidenceThreshold(this.voiceProviders.data()?.wakeWords),
      ),
    });
  }

  private async onWakeDetected(): Promise<void> {
    if (!this.sessionRunning || !this.micStream) return;

    this.stopStartSpotter();
    this.partialText.set('');

    const silence = this.silenceMs();
    const start = this.startPhrase();
    const end = this.endPhrase();
    this.capturePhaseStartedAt = Date.now();

    this.phase.set('stt_listening');
    void playVoiceCueNow('listening');
    if (this.vadEnabled()) {
      this.statusText.set(
        `Wake phrase "${start}" OK — STT would be recording. Speak your message, then pause (${(silence / 1000).toFixed(1)}s) for VAD to finish.`,
      );
      await this.armSileroVad(silence);
    } else if (end) {
      this.statusText.set(
        `Wake phrase "${start}" OK — STT would be recording. Speak your message, then say "${end}" to finish.`,
      );
      await this.armEndPhraseSpotter(end);
    } else {
      this.statusText.set(
        `Wake phrase "${start}" OK — STT would be recording. Pause ${(silence / 1000).toFixed(1)}s of silence to finish.`,
      );
    }
  }

  private async armSileroVad(redemptionMs: number): Promise<void> {
    if (!this.sessionRunning || !this.micStream) return;

    await this.stopSileroVad();
    this.sileroVad = new SileroVadDetector();

    try {
      await this.sileroVad.start(this.micStream, {
        redemptionMs,
        onSpeechEnd: () => void this.onSubmitDetected('vad'),
        onError: (message) => console.warn('[wake-test vad]', message),
      });
      this.vadListening = true;
    } catch (err) {
      console.warn('[wake-test vad]', err);
      this.statusText.set(
        `Silero VAD failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async armEndPhraseSpotter(end: string): Promise<void> {
    if (!this.sessionRunning || !this.micStream) return;

    this.stopEndSpotter();
    this.endSpotter = new VoskGrammarSpotter({
      onPartial: (text) => {
        if (this.listeningForEndPhrase) {
          this.partialText.set(text.trim());
        }
      },
      onMatch: () => void this.onSubmitDetected('end'),
      onError: (message) => console.warn('[wake-test end]', message),
    });

    try {
      await this.endSpotter.start(end, {
        mediaStream: this.micStream,
        matchPartial: false,
      });
      this.listeningForEndPhrase = true;
    } catch (err) {
      console.warn('[wake-test end]', err);
      this.statusText.set(
        `End phrase spotter failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async onSubmitDetected(reason: 'vad' | 'end'): Promise<void> {
    if (!this.sessionRunning) return;
    if (reason === 'vad' && !this.vadListening) return;
    if (reason === 'end' && !this.listeningForEndPhrase) return;
    if (Date.now() - this.capturePhaseStartedAt < this.minSpeechEndMs) {
      console.debug('[wake-test] ignored — too soon after wake');
      return;
    }
    playVoiceCueNow('sent');
    await this.returnToAwaitingWake(reason);
  }

  private async returnToAwaitingWake(reason: 'vad' | 'end'): Promise<void> {
    if (!this.sessionRunning) return;

    this.vadListening = false;
    this.listeningForEndPhrase = false;
    await this.stopSileroVad();
    this.stopEndSpotter();
    this.partialText.set('');

    const start = this.startPhrase();
    const end = this.endPhrase();
    if (reason === 'vad') {
      this.statusText.set(`Speech ended (VAD) — back to wake. Say "${start}" again.`);
    } else if (end) {
      this.statusText.set(`End phrase "${end}" heard — back to wake. Say "${start}" again.`);
    }

    await this.listenForWake();
  }

  private stopStartSpotter(): void {
    this.startSpotter?.dispose();
    this.startSpotter = null;
  }

  private stopEndSpotter(): void {
    this.endSpotter?.dispose();
    this.endSpotter = null;
    this.listeningForEndPhrase = false;
  }

  private async stopSileroVad(): Promise<void> {
    await this.sileroVad?.dispose();
    this.sileroVad = null;
    this.vadListening = false;
  }

  private teardownSpotters(): void {
    this.stopStartSpotter();
    this.stopEndSpotter();
    void this.stopSileroVad();
  }
}
