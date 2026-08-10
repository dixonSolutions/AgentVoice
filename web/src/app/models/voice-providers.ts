/** Voice settings types — mirrors GET /api/voice/providers (no secrets). */

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
  /** next_voice_turn timeout while narrating workers (ms). */
  workerPollTimeoutMs: number;
  userName?: string;
}
