/**
 * When speech on a call becomes a request — the web app's voice session rules
 * (web/src/llm-intelligence-session.ts), driven by the same server settings
 * (`settings.voice`, the Voice tab) and applied to what the call transcribed.
 *
 *   inputMode `stream`  every segment is a request; wake words do not apply
 *                       (the phone's direct stream ignores them too).
 *   inputMode `turns`   wakeWordsEnabled:
 *                         the start phrase opens a capture; anything else is
 *                         room talk and is not sent. "hey squeaker, run the
 *                         tests" is a request; "hey squeaker" alone opens the
 *                         capture for what is said next.
 *                       wake words off: every utterance is a request (the
 *                         phone waits for a tap on Speak; a call has no screen).
 *                       The request ends —
 *                         VAD on (turnSubmit.vadEnabled): at the pause that
 *                           ended the segment (turnSubmit.silenceMs of quiet);
 *                         VAD off: at the end phrase ("send"), or with no end
 *                           phrase, after turnSubmit.silenceMs with nothing new.
 *                       The cancel phrase drops the capture (wake words on).
 *
 * The phone spots phrases with Vosk on the raw audio; a call has a server
 * transcript, so phrases are matched in the text with the same normalisation.
 */

import { normalizeForWakeMatch } from '../realtime/wakeWordMatch.js';

export interface CallTurnSettings {
  inputMode: 'turns' | 'stream';
  wakeWordsEnabled: boolean;
  wakeWords: { start: string; end?: string; cancel?: string };
  turnSubmit: { silenceMs: number; vadEnabled?: boolean };
}

export type TurnVerdict =
  | { action: 'deliver'; text: string }
  /** The start phrase opened a capture; nothing to send yet. */
  | { action: 'armed' }
  /** Held in the capture until the end phrase or the silence timer. */
  | { action: 'buffered'; text: string }
  | { action: 'cancel' }
  /** Not addressed to the agent (wake words on, no start phrase). */
  | { action: 'ignore' };

/** A start phrase with nothing after it waits this long for the request. */
export const ARMED_MS = 10_000;

const words = (s: string) => normalizeForWakeMatch(s).split(' ').filter(Boolean);

/** Where `phrase` occurs in `original` (word indices), compared normalised. */
function find(original: string[], phrase: string[]): { start: number; end: number } | null {
  if (!phrase.length) return null;
  const norm = original.map((w) => normalizeForWakeMatch(w));
  for (let i = 0; i + phrase.length <= norm.length; i++) {
    if (phrase.every((p, j) => norm[i + j] === p)) return { start: i, end: i + phrase.length };
  }
  return null;
}

const tidy = (ws: string[]) => ws.join(' ').replace(/^[\s,.:;!?-]+|[\s,.:;!?-]+$/g, '');

/** How to talk to a call with these settings, in one spoken sentence (empty when anything goes). */
export function howToTalk(t: CallTurnSettings): string {
  if (t.inputMode === 'stream') return '';
  const wake = t.wakeWordsEnabled && t.wakeWords.start.trim();
  const end = t.turnSubmit.vadEnabled === false && wake ? (t.wakeWords.end ?? '').trim() : '';
  if (!wake) return '';
  return `Say ${t.wakeWords.start.trim()} before each request${end ? `, and ${end} when you are done` : ''}.`;
}

export class CallTurns {
  private openedAt: number | null = null;
  private readonly held: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly settings: CallTurnSettings,
    /** A capture the silence timer ended (VAD off, no end phrase). */
    private readonly onTimedSubmit: (text: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get wakeWords(): boolean {
    return this.settings.inputMode === 'turns' && this.settings.wakeWordsEnabled && words(this.settings.wakeWords.start).length > 0;
  }

  get vad(): boolean {
    return this.settings.turnSubmit.vadEnabled !== false;
  }

  /** The end phrase submits only with VAD off and wake words on — as on the phone. */
  private get endPhrase(): string[] {
    return !this.vad && this.wakeWords ? words(this.settings.wakeWords.end ?? '') : [];
  }

  private get capturing(): boolean {
    if (!this.wakeWords) return true;
    if (this.openedAt === null) return false;
    // An opened capture with nothing in it lapses; one that holds words waits for its end.
    if (!this.held.length && this.now() - this.openedAt > ARMED_MS) this.openedAt = null;
    return this.openedAt !== null;
  }

  feed(text: string): TurnVerdict {
    if (this.settings.inputMode === 'stream') return text.trim() ? { action: 'deliver', text: text.trim() } : { action: 'ignore' };
    let ws = text.split(/\s+/).filter(Boolean);

    if (this.wakeWords) {
      const start = find(ws, words(this.settings.wakeWords.start));
      if (start) {
        this.reset();
        this.openedAt = this.now();
        ws = ws.slice(start.end);
      } else if (!this.capturing) {
        return { action: 'ignore' };
      }
      const cancel = words(this.settings.wakeWords.cancel ?? '');
      if (cancel.length && find(ws, cancel)) {
        this.reset();
        return { action: 'cancel' };
      }
    }

    const end = this.endPhrase;
    if (end.length) {
      const hit = find(ws, end);
      if (hit) return this.submit(tidy(ws.slice(0, hit.start)));
      return this.hold(ws, false);
    }
    if (this.vad) return this.submit(tidy(ws));
    return this.hold(ws, true);
  }

  dispose(): void {
    this.reset();
  }

  private hold(ws: string[], timed: boolean): TurnVerdict {
    const piece = tidy(ws);
    if (piece) this.held.push(piece);
    if (timed && this.held.length) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const out = this.held.join(' ');
        this.reset();
        if (out) this.onTimedSubmit(out);
      }, this.settings.turnSubmit.silenceMs);
    }
    if (!this.held.length) return { action: 'armed' };
    return { action: 'buffered', text: this.held.join(' ') };
  }

  private submit(last: string): TurnVerdict {
    const out = [...this.held, last].filter(Boolean).join(' ');
    const wasOpen = this.openedAt !== null;
    this.reset();
    if (out) return { action: 'deliver', text: out };
    // The start phrase alone: keep the capture open for what comes next.
    if (this.wakeWords && wasOpen) {
      this.openedAt = this.now();
      return { action: 'armed' };
    }
    return { action: 'ignore' };
  }

  private reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.held.length = 0;
    this.openedAt = null;
  }
}
