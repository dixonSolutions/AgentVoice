/** Client-side mirror of src/voice/ttsInterrupt.ts */

export interface TtsInterruptSnapshot {
  heard_complete: string[];
  /** Full line playing when paused — user heard an unknown prefix. */
  heard_partial: string | null;
  not_spoken: string[];
  /** Estimated words heard from the partial line (time-based). */
  partial_words_estimate?: string | null;
  /** Last N words the user actually heard (for Cursor context). */
  last_heard_words?: string;
}

export interface TtsPlayContext {
  onStart: () => void;
  signal: AbortSignal;
  /** Base volume from browser TTS settings (0–1). */
  baseVolume: number;
}

export type TtsPlayFn = (text: string, ctx: TtsPlayContext) => Promise<void>;

export function snapshotToPayload(
  snap: TtsInterruptSnapshot,
): TtsInterruptSnapshot | undefined {
  if (!snap.heard_complete.length && !snap.heard_partial && !snap.not_spoken.length) {
    return undefined;
  }
  return snap;
}

export function summarizeTtsInterrupt(snap: TtsInterruptSnapshot): string {
  const parts: string[] = [];
  if (snap.last_heard_words) {
    parts.push(`last heard: "${snap.last_heard_words}"`);
  }
  if (snap.heard_complete.length) {
    const tail = snap.heard_complete[snap.heard_complete.length - 1] ?? '';
    parts.push(
      snap.heard_complete.length === 1
        ? `last full line: "${tail.slice(0, 80)}${tail.length > 80 ? '…' : ''}"`
        : `${snap.heard_complete.length} full lines`,
    );
  }
  if (snap.heard_partial) {
    parts.push(`cut off: "${snap.heard_partial.slice(0, 60)}${snap.heard_partial.length > 60 ? '…' : ''}"`);
  }
  if (snap.not_spoken.length) {
    parts.push(`${snap.not_spoken.length} line(s) not played`);
  }
  return parts.join(' · ') || 'assistant speech stopped';
}

/** ~150 wpm — used to estimate how much of a cut-off line was heard. */
const MS_PER_WORD_ESTIMATE = 400;

/**
 * Last N words the user heard before barge-in.
 * Uses completed lines plus a time-based estimate for a partial line.
 */
export function extractLastHeardWords(
  snap: Pick<TtsInterruptSnapshot, 'heard_complete' | 'partial_words_estimate'>,
  maxWords = 10,
): string {
  const chunks = [...snap.heard_complete];
  if (snap.partial_words_estimate?.trim()) {
    chunks.push(snap.partial_words_estimate.trim());
  }
  const words = chunks.join(' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  return words.slice(-maxWords).join(' ');
}

export function withLastHeardWords(
  snap: TtsInterruptSnapshot,
  maxWords = 10,
): TtsInterruptSnapshot {
  const last_heard_words = extractLastHeardWords(snap, maxWords);
  return last_heard_words ? { ...snap, last_heard_words } : snap;
}
