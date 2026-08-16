/** Shared callback types for agent_native and llm_intelligence voice sessions. */

export type VoiceLogSubcategory = 'stt' | 'tts' | 'tool' | 'pipeline';
export type VoiceLogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface VoiceSessionLogEvent {
  subcategory: VoiceLogSubcategory;
  level: VoiceLogLevel;
  summary: string;
  detail?: string;
}

export interface VoiceAgentStatusEvent {
  runId: string;
  pid: number;
  sessionId: string | null;
  mcpSessionId: string | null;
  state: 'starting' | 'running' | 'done' | 'error' | 'stopped';
  project: string;
  /** Active agent client id (cursor / codex / claude-code), from the bridge. */
  provider: string | null;
  /** Human name of the coding agent behind this run — never hardcode it here. */
  providerName: string | null;
}

export interface SessionCallbacks {
  onState(state: 'connecting' | 'connected' | 'error'): void;
  onUserTranscript(text: string): void;
  onAssistantTranscript(text: string): void;
  onSpeaking(speaking: boolean): void;
  onWorking(active: boolean): void;
  onClosed(reason?: string): void;
  onActivated?(phrase: string): void;
  onDeactivated?(): void;
  onWakeRejected?(heard: string, expectedWake: string): void;
  onSttError?(message: string): void;
  onTurnError?(message: string): void;
  onTurnComplete?(): void;
  onTtsBargeIn?(summary: string): void;
  onVadArmed?(): void;
  onVadDetected?(): void;
  onEndPhraseArmed?(phrase: string): void;
  onEndPhraseDetected?(phrase: string): void;
  onTurnSubmitted?(reason: 'silence' | 'vad' | 'end_word'): void;
  /** User spoke the cancel phrase — turn discarded, mic returns to wake listen. */
  onTurnCancelled?(phrase: string): void;
  onVoiceLog?(event: VoiceSessionLogEvent): void;
  relayToolCall(callId: string, name: string, args: unknown): Promise<unknown>;
  onToolActivity?(event: {
    tool: string;
    phase: 'start' | 'done' | 'error';
    label: string;
    detail?: string;
  }): void;
  onVoiceAgentStatus?(event: VoiceAgentStatusEvent): void;
}
