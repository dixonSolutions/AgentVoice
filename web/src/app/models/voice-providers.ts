/** Voice settings types — mirrors GET /api/voice/providers (no secrets). */

export type TouchControlsMode = 'off' | 'when_muted' | 'always';

export interface WakeWords {
  start: string;
  end: string;
  cancel?: string;
  wakeConfidenceThreshold: number;
}

export interface TurnSubmit {
  silenceMs: number;
  vadEnabled?: boolean;
}

export interface WebkitTtsDefaults {
  rate: number;
  pitch: number;
  volume: number;
  lang: string;
}

export interface VoiceTtsSettings {
  cursorVoiceEnabled: boolean;
  errorSoundEnabled: boolean;
  errorSpeakEnabled: boolean;
  webkit: WebkitTtsDefaults;
}

export interface VoiceSettingsResponse {
  wakeWords: WakeWords;
  turnSubmit: TurnSubmit;
  tts: VoiceTtsSettings;
  /** On-screen Speak / Cancel visibility (Cancel-processing always shows during submit). */
  touchControls: TouchControlsMode;
  /** When false, Vosk wake/end/cancel spotters are off — use on-screen Speak. */
  wakeWordsEnabled: boolean;
  /** Mute mic when a session starts. */
  defaultMicMuted: boolean;
  /** next_voice_turn timeout while narrating workers (ms). */
  workerPollTimeoutMs: number;
  userName?: string;
}
