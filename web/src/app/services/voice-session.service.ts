import { Injectable, inject, signal } from '@angular/core';
import { LlmIntelligenceSession } from '../../llm-intelligence-session.js';
import type { SessionCallbacks } from '../../voice-session-types.js';
import {
  disposeVoiceAudioMeter,
  getVoiceAudioMeter,
  type AudioSpectrum,
} from '../../voice-audio-meter.js';
import { AppStateService } from './app-state.service';
import { BridgeService } from './bridge.service';
import { LogService } from './log.service';
import { ToastService } from './toast.service';
import { VoiceProvidersService } from './voice-providers.service';
import { PushService } from './push.service';
import { cancelTtsFallback, clearTranscriptTts, configureTranscriptTts, scheduleTtsFallback, stopAllTts } from '../../tts-fallback.js';
import { primeTtsPlaybackUnlock } from '../../audio.js';
import { CallSession, isNativeShell } from '../../native/call-session.js';
import { SessionKeepAlive } from '../../session-keepalive.js';
import { preloadVoiceCues, playVoiceCueNow } from '../../sound-effects.js';
import type { SttBackend, TtsBackend } from '../../intelligence-audio.js';

export interface TranscriptEntry {
  id: number;
  text: string;
  role: 'user' | 'assistant';
}

export interface ToolActivityState {
  tool: string;
  phase: 'start' | 'done' | 'error';
  label: string;
  detail?: string;
  at: number;
}

export interface VoiceAgentStatusState {
  runId: string;
  pid: number;
  sessionId: string | null;
  mcpSessionId: string | null;
  state: 'starting' | 'running' | 'done' | 'error' | 'stopped';
  project: string;
  at: number;
}

const MAX_ENTRIES = 50;
let _nextId = 0;

type ActiveSession = LlmIntelligenceSession;

@Injectable({ providedIn: 'root' })
export class VoiceSessionService {
  private readonly bridge = inject(BridgeService);
  private readonly appState = inject(AppStateService);
  private readonly toast = inject(ToastService);
  private readonly voiceProviders = inject(VoiceProvidersService);
  private readonly push = inject(PushService);
  private readonly logs = inject(LogService);

  private _session: ActiveSession | null = null;
  private prepareAbort: AbortController | null = null;
  private readonly keepalive = new SessionKeepAlive();
  private keepaliveWired = false;
  /** Reconnect intelligence session after OS background suspend (not user hang-up). */
  private resumeOnVisible = false;
  private readonly _voiceActivated = signal(false);
  private readonly _speaking = signal(false);
  private readonly _jobRunning = signal(false);
  private readonly _micMuted = signal(false);

  readonly transcript = signal<TranscriptEntry[]>([]);
  readonly toolActivity = signal<ToolActivityState | null>(null);
  readonly agentStatus = signal<VoiceAgentStatusState | null>(null);
  readonly conversationActive = signal(false);
  readonly sessionConnecting = signal(false);
  /** True while MCP install / version check runs before mic opens. */
  readonly sessionPrepActive = signal(false);
  readonly speaking = this._speaking.asReadonly();
  readonly voiceActivated = this._voiceActivated.asReadonly();
  readonly micMuted = this._micMuted.asReadonly();
  /** Silero VAD active — listening for speech end to submit. */
  readonly vadListening = signal(false);
  /** Vosk end-phrase spotter active (say end word to submit). */
  readonly endPhraseArmed = signal(false);
  /** Speech-end detected — flushing STT and submitting. */
  readonly submittingTurn = signal(false);

  private readonly _audioSpectrum = signal<AudioSpectrum>({
    bins: new Array(32).fill(0),
    mic: 0,
    out: 0,
    active: 0,
  });
  readonly audioSpectrum = this._audioSpectrum.asReadonly();

  private readonly _audioBackends = signal<{ stt: SttBackend; tts: TtsBackend } | null>(null);
  readonly audioBackends = this._audioBackends.asReadonly();

  /** @deprecated use audioSpectrum */
  readonly audioLevels = this.audioSpectrum;

  private meterRaf = 0;

  isVoiceActivated(): boolean {
    return this._voiceActivated();
  }

  toggleMicMute(): void {
    const next = !this._micMuted();
    this._micMuted.set(next);
    if (this._session instanceof LlmIntelligenceSession) {
      this._session.setMicMuted(next);
    }
  }

  /** Apply updated per-browser TTS profile to an active session. */
  refreshBrowserTtsOptions(): void {
    if (this._session instanceof LlmIntelligenceSession) {
      this._session.refreshBrowserTtsOptions();
    }
  }

  notifyJobRunning(running: boolean): void {
    this._jobRunning.set(running);
    this.syncAppState();
  }

  async startSession(): Promise<void> {
    if (this._session || this.sessionConnecting()) return;

    this.ensureKeepAliveWiring();
    this.resumeOnVisible = false;

    if (isNativeShell()) {
      try {
        await CallSession.startCall();
      } catch {
        this.toast.warn('Call session', 'Could not start native call — voice may drop when screen locks.');
      }
    }

    const project = this.bridge.activeProject();
    if (!project) {
      this.toast.error('Select a project', 'Choose a project in the dropdown before tapping the orb.');
      return;
    }

    this.sessionConnecting.set(true);
    this.sessionPrepActive.set(true);
    this._voiceActivated.set(false);
    this._jobRunning.set(false);
    this._micMuted.set(false);

    // iOS Safari: unlock TTS in the user-gesture stack before any long await.
    await primeTtsPlaybackUnlock();
    void preloadVoiceCues();

    try {
      await this.bridge.setActiveProject(project);
      this.prepareAbort = new AbortController();
      const prepareSignal = this.prepareAbort.signal;
      await this.bridge.prepareVoiceSession(
        project,
        (event) => {
          this.logs.append(
            event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'info',
            'voice',
            event.message,
          );
        },
        prepareSignal,
      );
      await this.bridge.ensureCursorSessionReady(project);
      if (!this.bridge.settings()) {
        await this.bridge.loadSettings();
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      this.toast.error('Could not prepare voice session', detail);
      this.notifyVoiceError(detail);
      this.sessionConnecting.set(false);
      this.sessionPrepActive.set(false);
      return;
    } finally {
      this.prepareAbort = null;
      this.sessionPrepActive.set(false);
    }

    const callbacks = this.buildCallbacks();
    const workflow = this.bridge.settings()?.workflow.default ?? 'cursor_native';

    const intelSession = new LlmIntelligenceSession(
      this.bridge.bridgeBase,
      this.bridge.appToken,
      callbacks,
    );
    this._session = intelSession;

    try {
      await intelSession.start();
      this._audioBackends.set(intelSession.getAudioBackends());
      configureTranscriptTts({
        bridgeBase: this.bridge.bridgeBase,
        appToken: this.bridge.appToken,
        audio: intelSession.getAudioConfig(),
      });
      const startMsg =
        workflow === 'cursor_native'
          ? 'Cursor voice session started — run the voice agent in Cursor IDE, then say the wake phrase'
          : 'Intelligence session started — say wake phrase to activate';
      this.logs.append('info', 'voice', startMsg);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logs.append('error', 'voice', 'Could not start intelligence session', detail);
      this.toast.error('Could not start voice', detail);
      this.notifyVoiceError(detail);
      this.stopSession();
    } finally {
      this.sessionConnecting.set(false);
    }
  }

  stopSession(options?: { userInitiated?: boolean; keepKeepalive?: boolean }): void {
    const userInitiated = options?.userInitiated !== false;
    this.prepareAbort?.abort();
    this.prepareAbort = null;
    if (userInitiated) {
      this.resumeOnVisible = false;
    }
    if (userInitiated || !options?.keepKeepalive) {
      this.keepalive.stop();
    }
    if (userInitiated && isNativeShell()) {
      void CallSession.endCall().catch(() => {});
    }

    this._session?.close();
    this._session = null;
    this.sessionConnecting.set(false);
    this.sessionPrepActive.set(false);
    this._voiceActivated.set(false);
    this._speaking.set(false);
    this._jobRunning.set(false);
    this._micMuted.set(false);
    this.bridge.sendSpeakingState(false);
    this.stopMeterPoll();
    this.conversationActive.set(false);
    this.transcript.set([]);
    this.toolActivity.set(null);
    this.agentStatus.set(null);
    this.vadListening.set(false);
    this.endPhraseArmed.set(false);
    this.submittingTurn.set(false);
    this._audioBackends.set(null);
    clearTranscriptTts();
    cancelTtsFallback();
    stopAllTts();
    this.appState.transitionTo('idle');
  }

  injectNarration(text: string): void {
    if (!this.conversationActive()) return;
    this._session?.injectNarration(text);
  }

  /** Typed message for cascade workflows — same turn path as voice (queued while agent runs). */
  async sendTextMessage(text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed) return false;

    if (!this._session && !this.sessionConnecting()) {
      await this.startSession();
    }
    const session = this._session;
    if (session instanceof LlmIntelligenceSession) {
      return session.sendTextTurn(trimmed);
    }
    this.toast.warn('Not connected', 'Tap the orb to start a voice session first.');
    return false;
  }

  addEntry(text: string, role: TranscriptEntry['role']): void {
    this.logs.transcript(role, text);
    this.transcript.update((entries) => {
      const next = [...entries, { id: _nextId++, text, role }];
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  }

  private ensureKeepAliveWiring(): void {
    if (this.keepaliveWired) return;
    this.keepaliveWired = true;
    this.keepalive.onVisible(() => {
      void this.tryResumeAfterBackground();
    });
    if (isNativeShell()) {
      void CallSession.addListener('callEnded', () => {
        if (this.conversationActive()) {
          this.stopSession();
        }
      });
      void CallSession.addListener('incomingCallAnswered', () => {
        void this.push.syncPendingApprovals();
      });
    }
  }

  private async tryResumeAfterBackground(): Promise<void> {
    if (!this.resumeOnVisible) return;
    if (this._session || this.sessionConnecting()) return;
    this.resumeOnVisible = false;
    await this.startSession();
  }

  private syncAppState(): void {
    if (this._jobRunning()) {
      this.appState.transitionTo('working');
      return;
    }
    if (this._voiceActivated()) {
      this.appState.transitionTo('listening');
    } else if (this.conversationActive()) {
      this.appState.transitionTo('inactive');
    } else {
      this.appState.transitionTo('idle');
    }
  }

  private buildCallbacks(): SessionCallbacks {
    return {
      onState: (s) => {
        if (s === 'connected') {
          this.conversationActive.set(true);
          this._voiceActivated.set(false);
          this.startMeterPoll();
          this.syncAppState();
          void this.keepalive.start({
            title: 'Cursor Voice',
            artist: 'Voice session active',
          });
        }
        if (s === 'error') {
          const message = 'Voice connection failed — check bridge connection and AWS keys.';
          this.toast.error('Voice connection failed', message);
          this.notifyVoiceError(message);
          this.stopSession();
        }
      },
      onUserTranscript: (text) => this.addEntry(text, 'user'),
      onAssistantTranscript: (text) => {
        this.addEntry(text, 'assistant');
        // MCP speak() already drives TTS via the `speak` WS event. Scheduling fallback
        // here replays the same line after playback when assistant_transcript follows speak().
        const cursorVoiceTts =
          this.voiceProviders.data()?.tts.cursorVoiceEnabled ?? true;
        if (!cursorVoiceTts) {
          scheduleTtsFallback(text, () => this._speaking());
        }
      },
      onSpeaking: (speaking) => {
        if (speaking) cancelTtsFallback();
        this._speaking.set(speaking);
        this.bridge.sendSpeakingState(speaking);
      },
      onWorking: (working) => {
        this._jobRunning.set(working);
        if (working) {
          this.appState.transitionTo('working');
        } else {
          this.syncAppState();
        }
      },
      onToolActivity: (event) => {
        this.toolActivity.set({ ...event, at: Date.now() });
        const workflow = this.bridge.settings()?.workflow.default ?? 'cursor_native';
        if (workflow === 'llm_intelligence') {
          this.logs.voiceLog(
            'tool',
            event.phase === 'error' ? 'error' : 'info',
            event.label,
            event.detail,
          );
        }
        if (event.phase === 'start') {
          this._jobRunning.set(true);
          this.appState.transitionTo('working');
        } else if (event.phase === 'done' || event.phase === 'error') {
          this._jobRunning.set(false);
          this.syncAppState();
        }
      },
      onVoiceAgentStatus: (event) => {
        this.agentStatus.set({ ...event, at: Date.now() });
        const sid = event.sessionId ? `${event.sessionId.slice(0, 8)}…` : 'pending';
        const label =
          event.state === 'starting'
            ? `Cursor agent starting — pid ${event.pid}, run ${event.runId.slice(0, 8)}…`
            : event.state === 'running'
              ? `Cursor agent running — pid ${event.pid}, session ${sid}`
              : event.state === 'done'
                ? `Cursor agent finished — session ${sid}`
                : `Cursor agent ${event.state} — pid ${event.pid}`;
        this.logs.append('info', 'voice', label);
      },
      onClosed: (reason) => {
        const backgrounded =
          typeof document !== 'undefined' && document.hidden;
        if (backgrounded) {
          this.resumeOnVisible = true;
          this.stopSession({ userInitiated: false, keepKeepalive: true });
          return;
        }
        if (reason) {
          this.toast.warn('Voice disconnected', reason);
          this.notifyVoiceError(reason);
        }
        this.stopSession();
      },
      onActivated: (phrase) => {
        this.logs.append('info', 'voice', `Wake phrase heard — "${phrase}"`);
        this._voiceActivated.set(true);
        this.vadListening.set(false);
        this.endPhraseArmed.set(false);
        this.syncAppState();
        if (phrase !== '(typed input)') {
          this.toast.success('Listening', 'Activation phrase heard — speak your request.', false);
        }
      },
      onDeactivated: () => {
        this._voiceActivated.set(false);
        this.vadListening.set(false);
        this.endPhraseArmed.set(false);
        this.syncAppState();
      },
      onWakeRejected: (heard, expectedWake) => {
        this.logs.append('info', 'voice', `Wake rejected — heard "${heard}"`);
        this.toast.warn(
          `Say "${expectedWake}" first`,
          `Heard: "${heard.slice(0, 80)}". Other speech is ignored until you activate.`,
        );
      },
      onSttError: (message) => {
        this.logs.append('error', 'voice', 'STT error', message);
        this.toast.error('Speech input error', message);
        this.notifyVoiceError(message);
      },
      onTurnError: (message) => {
        this.logs.append('error', 'voice', 'Request failed', message);
        this.toast.error('Request failed', message);
        this.notifyVoiceError(message);
      },
      onTurnComplete: () => {
        this.toolActivity.set(null);
        this.submittingTurn.set(false);
      },
      onTtsBargeIn: (summary) => {
        this.logs.append('info', 'voice', 'Speech interrupted — listening', summary);
      },
      onVadArmed: () => {
        this.vadListening.set(true);
        this.endPhraseArmed.set(false);
        this.submittingTurn.set(false);
        this.logs.append('info', 'voice', 'Silero VAD armed — pause when finished speaking');
      },
      onVadDetected: () => {
        this.vadListening.set(false);
        this.endPhraseArmed.set(false);
        this.submittingTurn.set(true);
        this.logs.append('info', 'voice', 'Speech ended (VAD) — stopping mic, submitting');
      },
      onEndPhraseArmed: (phrase) => {
        this.endPhraseArmed.set(true);
        this.vadListening.set(false);
        this.submittingTurn.set(false);
        this.logs.append('info', 'voice', `End phrase armed — say "${phrase}" when finished`);
      },
      onEndPhraseDetected: (phrase) => {
        this.endPhraseArmed.set(false);
        this.vadListening.set(false);
        this.submittingTurn.set(true);
        this.logs.append('info', 'voice', `End phrase heard — "${phrase}" (stopping mic, submitting)`);
      },
      onTurnSubmitted: (reason) => {
        this.submittingTurn.set(false);
        this.vadListening.set(false);
        this.endPhraseArmed.set(false);
        this.logs.append(
          'info',
          'voice',
          reason === 'vad'
            ? 'Turn sent (Silero VAD)'
            : reason === 'end_word'
              ? 'Turn sent (end phrase)'
              : 'Turn sent (silence)',
          undefined,
          'pipeline',
        );
      },
      onTurnCancelled: (phrase) => {
        this.submittingTurn.set(false);
        this.vadListening.set(false);
        this.endPhraseArmed.set(false);
        this._voiceActivated.set(false);
        this.syncAppState();
        this.logs.append('info', 'voice', `Turn cancelled — "${phrase}"`);
        this.toast.info('Cancelled', 'Turn discarded — back to wake listen.');
      },
      onVoiceLog: (event) => {
        this.logs.voiceLog(event.subcategory, event.level, event.summary, event.detail);
      },
      relayToolCall: async (callId, name, args) => {
        this.onToolActivityLocal(name, 'start', args);
        try {
          const result = await this.bridge.relayToolCall(callId, name, args);
          this.onToolActivityLocal(name, 'done', result);
          return result;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          this.onToolActivityLocal(name, 'error', { error: detail });
          throw err;
        }
      },
    };
  }

  private onToolActivityLocal(
    tool: string,
    phase: 'start' | 'done' | 'error',
    payload: unknown,
  ): void {
    const label = this.formatToolLabel(tool, phase, payload);
    const detail =
      phase === 'error' && payload && typeof payload === 'object'
        ? String((payload as Record<string, unknown>)['error'] ?? '')
        : undefined;
    this.toolActivity.set({ tool, phase, label, detail, at: Date.now() });
    this.logs.voiceLog(
      'tool',
      phase === 'error' ? 'error' : 'info',
      label,
      detail,
    );
    if (phase === 'start') {
      this._jobRunning.set(true);
      this.appState.transitionTo('working');
    } else {
      this._jobRunning.set(false);
      this.syncAppState();
    }
  }

  private formatToolLabel(
    tool: string,
    phase: 'start' | 'done' | 'error',
    payload: unknown,
  ): string {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (phase === 'error') {
      return `${tool.replace(/_/g, ' ')} — failed`;
    }
    if (phase === 'done') {
      if (tool === 'cursor_status' && typeof p['activity'] === 'string') {
        const pid = typeof p['cli_pid'] === 'number' ? ` [pid ${p['cli_pid']}]` : '';
        return `Progress${pid} → ${p['activity']}`;
      }
      if (tool === 'cursor_ask') return 'Cursor answered';
      if (tool === 'cursor_submit') return 'Job started';
      return `${tool.replace(/_/g, ' ')} — done`;
    }
    switch (tool) {
      case 'cursor_set_project':
        return `Setting project → ${String(p['project'] ?? '')}`;
      case 'cursor_ask':
        return `Asking Cursor (CLI) → ${String(p['question'] ?? '').slice(0, 60)}`;
      case 'cursor_submit':
        return `Sending to Cursor → ${String(p['prompt'] ?? '').slice(0, 72)}`;
      case 'cursor_status':
        return 'Checking Cursor progress';
      default:
        return tool.replace(/_/g, ' ');
    }
  }

  private startMeterPoll(): void {
    this.stopMeterPoll();
    const tick = (): void => {
      this._audioSpectrum.set(getVoiceAudioMeter().sample());
      this.meterRaf = requestAnimationFrame(tick);
    };
    this.meterRaf = requestAnimationFrame(tick);
  }

  private stopMeterPoll(): void {
    if (this.meterRaf) cancelAnimationFrame(this.meterRaf);
    this.meterRaf = 0;
    disposeVoiceAudioMeter();
    this._audioSpectrum.set({
      bins: new Array(32).fill(0),
      mic: 0,
      out: 0,
      active: 0,
    });
  }

  /** Error earcon + optional spoken alert per voice TTS settings. */
  private notifyVoiceError(message: string): void {
    const trimmed = message.trim();
    if (!trimmed) return;

    const session = this._session;
    if (session instanceof LlmIntelligenceSession) {
      session.notifyError(trimmed);
      return;
    }

    const tts = this.voiceProviders.data()?.tts;
    if (tts?.errorSoundEnabled ?? true) {
      playVoiceCueNow('error', { force: true });
    }
  }
}
