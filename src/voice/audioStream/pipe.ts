/**
 * One audio stream → segments → transcripts, in order.
 *
 * Segments are transcribed one at a time so transcripts reach the agent in the
 * order they were spoken, whatever each request's latency. If the speech
 * engine falls behind (a slow provider, a burst of short segments), the
 * waiting segments are merged into one request instead of queueing without
 * bound — fewer round trips, and the agent gets the backlog as one turn.
 *
 * Transport-free on purpose: the WebSocket route feeds it bytes and decides
 * what a transcript means; tests feed it synthetic PCM and a fake transcriber.
 */

import { PcmSegmenter, type AudioSegment, type SegmenterOptions } from './segmenter.js';

export interface TranscribeFn {
  (pcm: Buffer, signal: AbortSignal): Promise<{ text: string; provider?: string; model?: string }>;
}

export interface PipeTranscript {
  /** 1-based, in speaking order. */
  index: number;
  text: string;
  provider?: string;
  model?: string;
  audioMs: number;
  speechMs: number;
  latencyMs: number;
  /** Segments merged into this request because the engine fell behind. */
  merged: number;
  reason: AudioSegment['reason'];
}

export interface AudioStreamPipeOptions {
  segmenter: SegmenterOptions;
  transcribe: TranscribeFn;
  onTranscript: (t: PipeTranscript) => void;
  /** A segment transcribed to nothing (breath, background speech too faint…). */
  onEmpty?: (info: { index: number; audioMs: number }) => void;
  onError?: (err: Error, info: { index: number; audioMs: number }) => void;
  /** Merge waiting segments once more than this many are queued. Default 2. */
  maxBacklog?: number;
}

export interface AudioStreamPipeStats {
  bytesIn: number;
  receivedMs: number;
  segments: number;
  transcripts: number;
  empty: number;
  errors: number;
  merged: number;
}

export class AudioStreamPipe {
  private readonly segmenter: PcmSegmenter;
  private readonly pending: AudioSegment[] = [];
  private worker: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private closed = false;
  private nextIndex = 1;
  private readonly stats: AudioStreamPipeStats = {
    bytesIn: 0,
    receivedMs: 0,
    segments: 0,
    transcripts: 0,
    empty: 0,
    errors: 0,
    merged: 0,
  };

  constructor(private readonly opts: AudioStreamPipeOptions) {
    this.segmenter = new PcmSegmenter(opts.segmenter);
  }

  getStats(): AudioStreamPipeStats {
    return { ...this.stats, receivedMs: this.segmenter.receivedMs };
  }

  /** True while a segment is being collected (the user is mid-utterance). */
  get hearingSpeech(): boolean {
    return this.segmenter.inSegment;
  }

  push(chunk: Buffer): void {
    if (this.closed) return;
    this.stats.bytesIn += chunk.length;
    for (const seg of this.segmenter.push(chunk)) this.enqueue(seg);
  }

  /** Cut the current segment now instead of waiting for a pause. */
  flush(): void {
    if (this.closed) return;
    const seg = this.segmenter.flush();
    if (seg) this.enqueue(seg);
  }

  /** Flush, then resolve once every queued segment has been transcribed. */
  async drain(): Promise<void> {
    this.flush();
    while (this.worker) await this.worker;
  }

  /** Stop: abort any in-flight transcription and drop queued audio. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    this.abort.abort();
  }

  private enqueue(seg: AudioSegment): void {
    this.stats.segments += 1;
    this.pending.push(seg);
    this.kick();
  }

  private kick(): void {
    if (this.worker || this.closed) return;
    this.worker = this.run().finally(() => {
      this.worker = null;
      // A segment queued by a callback while the loop was winding down.
      if (this.pending.length > 0) this.kick();
    });
  }

  private takeBatch(): { seg: AudioSegment; merged: number } {
    const max = Math.max(1, this.opts.maxBacklog ?? 2);
    if (this.pending.length <= max) return { seg: this.pending.shift()!, merged: 1 };
    const batch = this.pending.splice(0, this.pending.length);
    const first = batch[0]!;
    const last = batch[batch.length - 1]!;
    this.stats.merged += batch.length - 1;
    return {
      seg: {
        pcm: Buffer.concat(batch.map((s) => s.pcm)),
        startMs: first.startMs,
        durationMs: batch.reduce((n, s) => n + s.durationMs, 0),
        speechMs: batch.reduce((n, s) => n + s.speechMs, 0),
        reason: last.reason,
      },
      merged: batch.length,
    };
  }

  private async run(): Promise<void> {
    while (this.pending.length > 0 && !this.closed) {
      const { seg, merged } = this.takeBatch();
      const index = this.nextIndex++;
      const startedAt = Date.now();
      try {
        const result = await this.opts.transcribe(seg.pcm, this.abort.signal);
        if (this.closed) return;
        const text = result.text.trim();
        if (!text) {
          this.stats.empty += 1;
          this.opts.onEmpty?.({ index, audioMs: seg.durationMs });
          continue;
        }
        this.stats.transcripts += 1;
        this.opts.onTranscript({
          index,
          text,
          ...(result.provider ? { provider: result.provider } : {}),
          ...(result.model ? { model: result.model } : {}),
          audioMs: seg.durationMs,
          speechMs: seg.speechMs,
          latencyMs: Date.now() - startedAt,
          merged,
          reason: seg.reason,
        });
      } catch (err) {
        if (this.closed) return;
        this.stats.errors += 1;
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)), {
          index,
          audioMs: seg.durationMs,
        });
      }
    }
  }
}
