/** Client-side wake phrase matching — phrase from config via token mint only. */

/** Legacy wake sensitivity presets — migrated to wakeConfidenceThreshold on read. */
export const LEGACY_WAKE_SENSITIVITY_THRESHOLD = {
  high: 0.45,
  balanced: 0.65,
  strict: 0.8,
} as const;

export type LegacyWakeSensitivity = keyof typeof LEGACY_WAKE_SENSITIVITY_THRESHOLD;

export interface WakeWords {
  start: string;
  end: string;
  /** Spoken during capture to abort the turn silently — default "cancel". */
  cancel?: string;
  /** @deprecated — use wakeConfidenceThreshold. */
  sensitivity?: LegacyWakeSensitivity;
  /** Minimum mean Vosk word confidence (0–1) for wake phrase detection. */
  wakeConfidenceThreshold?: number;
}

/** Resolve wake confidence threshold from config (handles legacy sensitivity). */
export function resolveWakeConfidenceThreshold(wakeWords: WakeWords | undefined): number {
  if (wakeWords?.wakeConfidenceThreshold !== undefined) {
    return wakeWords.wakeConfidenceThreshold;
  }
  const legacy = wakeWords?.sensitivity;
  if (legacy) return LEGACY_WAKE_SENSITIVITY_THRESHOLD[legacy];
  return 0.45;
}

export interface TurnSubmit {
  silenceMs: number;
  vadEnabled?: boolean;
}

export function normalizeForWakeMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isStartPhrase(text: string, start: string): boolean {
  const normText = normalizeForWakeMatch(text);
  const normPhrase = normalizeForWakeMatch(start);
  if (!normPhrase) return false;
  if (normText === normPhrase) return true;
  return normText.startsWith(`${normPhrase} `);
}

/**
 * True when TTS text contains the wake phrase as consecutive words.
 * During playback Vosk may reduce an inflected word ("starting") to the
 * configured wake word ("start"), so long wake tokens also match prefixes.
 */
export function textContainsWakePhrase(text: string, wake: string): boolean {
  const normText = normalizeForWakeMatch(text);
  const normWake = normalizeForWakeMatch(wake);
  if (!normWake || !normText) return false;
  if (normText === normWake) return true;

  const wakeWords = normWake.split(' ');
  const textWords = normText.split(' ');
  if (textWords.length < wakeWords.length) return false;

  for (let i = 0; i <= textWords.length - wakeWords.length; i++) {
    if (
      wakeWords.every((word, j) => {
        const textWord = textWords[i + j] ?? '';
        return textWord === word || (word.length >= 4 && textWord.startsWith(word));
      })
    ) {
      return true;
    }
  }
  return false;
}

/** Remove the wake prefix from an utterance that already matched isStartPhrase. */
export function stripStartPhrase(text: string, start: string): string {
  const normText = normalizeForWakeMatch(text);
  const normPhrase = normalizeForWakeMatch(start);
  if (!normPhrase || normText === normPhrase) return '';
  if (!normText.startsWith(`${normPhrase} `)) return text.trim();

  const words = start.trim().split(/\s+/);
  const pattern = new RegExp(
    `^\\s*${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}\\s*`,
    'iu',
  );
  return text.replace(pattern, '').trim();
}

/** True when the utterance ends with the submit phrase ("… send"). */
export function isEndPhrase(text: string, end: string): boolean {
  const normText = normalizeForWakeMatch(text);
  const normPhrase = normalizeForWakeMatch(end);
  if (!normPhrase) return false;
  if (normText === normPhrase) return true;
  return normText.endsWith(` ${normPhrase}`);
}

/** Start (wake) and end (submit) phrases must differ — same word breaks phased detection. */
export function phrasesConflict(start: string, end: string): boolean {
  const a = normalizeForWakeMatch(start);
  const b = normalizeForWakeMatch(end);
  if (!a || !b) return false;
  return a === b;
}

/** Remove a trailing submit phrase from an utterance. */
export function stripEndPhrase(text: string, end: string): string {
  const normText = normalizeForWakeMatch(text);
  const normPhrase = normalizeForWakeMatch(end);
  if (!normPhrase) return text.trim();
  if (normText === normPhrase) return '';
  if (!normText.endsWith(normPhrase)) return text.trim();

  const words = end.trim().split(/\s+/);
  const pattern = new RegExp(
    `\\s*${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}\\s*$`,
    'iu',
  );
  return text.replace(pattern, '').trim();
}
