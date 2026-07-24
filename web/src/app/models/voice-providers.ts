/** Voice settings types — mirrors GET /api/voice/providers (no secrets). */

export type WakeSensitivity = 'high' | 'balanced' | 'strict';

export interface WakeWords {
  start: string;
  end: string;
  cancel?: string;
  sensitivity: WakeSensitivity;
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
  interruptMode: 'pause' | 'deafen' | 'stop';
  interruptDeafenFactor: number;
  errorSoundEnabled: boolean;
  errorSpeakEnabled: boolean;
  webkit: WebkitTtsDefaults;
}

export interface VoiceSettingsResponse {
  wakeWords: WakeWords;
  turnSubmit: TurnSubmit;
  tts: VoiceTtsSettings;
  userName?: string;
}
