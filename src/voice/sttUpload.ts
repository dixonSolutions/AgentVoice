/**
 * One utterance uploaded while it is spoken (`/ws/stt`, routes/sttSocket.ts).
 *
 * The phone sends its mic audio in the chunks it captures, as it captures
 * them, instead of one upload after the speaker stops. Each chunk goes
 * straight on to a live engine session when the engine takes one (Amazon
 * Transcribe); for every other engine it is collected here, so when the
 * utterance ends the whole of it is already on the bridge and the engine call
 * starts at once. If the live session fails, the collected audio goes through
 * the normal fallback chain instead — nothing said is lost.
 *
 * Transport-free: the route feeds it bytes; tests feed it fakes.
 */

import type { LiveTranscription } from '../providers/speech/input/types.js';

export interface UtteranceTranscript {
  text: string;
  provider: string | null;
  model: string | null;
  /** Transcribed by a live session as it was spoken. */
  live: boolean;
  /** From the end of speech to the transcript. */
  latencyMs: number;
  bytes: number;
}

export interface UtteranceDeps {
  /** A live session on the primary engine, or null for the whole-utterance path. */
  openLive(): { provider: string; session: LiveTranscription } | null;
  /** The configured chain over the finished utterance. */
  transcribe(pcm: Buffer, signal: AbortSignal): Promise<{ text: string; provider?: string; model?: string }>;
  onLiveFailed?(err: Error, provider: string): void;
  /** Refuse more audio past this (the HTTP upload's limit). */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export class UtteranceTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Utterance over ${Math.round(maxBytes / 1024 / 1024)} MB — say send sooner, or keep the request shorter.`);
    this.name = 'UtteranceTooLargeError';
  }
}

export class Utterance {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private live: { provider: string; session: LiveTranscription } | null;
  private readonly abort = new AbortController();
  private state: 'open' | 'ending' | 'closed' = 'open';

  constructor(private readonly deps: UtteranceDeps) {
    this.live = deps.openLive();
  }

  get isLive(): boolean {
    return this.live !== null;
  }

  get receivedBytes(): number {
    return this.bytes;
  }

  get isCancelled(): boolean {
    return this.abort.signal.aborted;
  }

  push(chunk: Buffer): void {
    if (this.state !== 'open' || chunk.length === 0) return;
    const max = this.deps.maxBytes ?? DEFAULT_MAX_BYTES;
    if (this.bytes + chunk.length > max) throw new UtteranceTooLargeError(max);
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    if (this.live) {
      try {
        this.live.session.push(chunk);
      } catch (err) {
        this.dropLive(err);
      }
    }
  }

  /** The speaker stopped. Resolves with the transcript; rejects if every engine failed. */
  async end(): Promise<UtteranceTranscript> {
    if (this.state !== 'open') throw new Error('Utterance already ended');
    this.state = 'ending';
    const endedAt = Date.now();
    const done = (r: { text: string; provider?: string | null; model?: string | null }, live: boolean) => ({
      text: r.text.trim(),
      provider: r.provider ?? null,
      model: r.model ?? null,
      live,
      latencyMs: Date.now() - endedAt,
      bytes: this.bytes,
    });
    try {
      if (this.live) {
        const { provider, session } = this.live;
        try {
          return done({ ...(await session.finish()), provider }, true);
        } catch (err) {
          if (this.abort.signal.aborted) throw err;
          this.deps.onLiveFailed?.(err instanceof Error ? err : new Error(String(err)), provider);
          this.live = null;
        }
      }
      return done(await this.deps.transcribe(Buffer.concat(this.chunks), this.abort.signal), false);
    } finally {
      this.state = 'closed';
    }
  }

  /** Throw the utterance away (cancelled turn, socket gone) — mid-transcription too. */
  cancel(): void {
    if (this.abort.signal.aborted) return;
    this.state = 'closed';
    this.abort.abort();
    this.live?.session.abort();
    this.live = null;
    this.chunks.length = 0;
  }

  private dropLive(err: unknown): void {
    const live = this.live;
    if (!live) return;
    this.live = null;
    live.session.abort();
    this.deps.onLiveFailed?.(err instanceof Error ? err : new Error(String(err)), live.provider);
  }
}
