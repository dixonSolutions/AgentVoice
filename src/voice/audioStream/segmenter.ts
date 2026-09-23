/**
 * Cut a continuous PCM16LE mono stream into speech segments.
 *
 * The audio pipe has no wake phrase and no VAD model on the sending side — it
 * is just a stream of samples. This finds the speech in it with a plain energy
 * gate over 20 ms frames:
 *
 *   silence …… [pre-roll][speech speech (pause) speech][pause ≥ segmentSilenceMs] → segment
 *
 *   - a segment starts at the first loud frame, keeping `preRollMs` of the audio
 *     before it so the first syllable is not clipped
 *   - it ends after `segmentSilenceMs` of quiet, or at `maxSegmentMs` so
 *     somebody talking without pause still reaches the agent
 *   - segments with less than `minSpeechMs` of loud frames are noise and dropped
 *
 * Everything is driven by sample counts, never wall-clock time, so a file
 * pushed at full speed segments exactly like the same audio spoken live — and
 * the behaviour is deterministic enough to unit test.
 */

export interface SegmenterOptions {
  sampleRate: number;
  segmentSilenceMs: number;
  maxSegmentMs: number;
  minSpeechMs: number;
  /** RMS level, 0–1 of full scale, at or above which a frame counts as speech. */
  speechThreshold: number;
  preRollMs: number;
  /** Analysis frame length. Default 20 ms. */
  frameMs?: number;
}

export type SegmentEndReason = 'pause' | 'max_length' | 'flush';

export interface AudioSegment {
  pcm: Buffer;
  /** Stream position of the first sample in this segment. */
  startMs: number;
  durationMs: number;
  /** Frames above the speech threshold, in ms. */
  speechMs: number;
  reason: SegmentEndReason;
}

/** Trailing quiet kept on a segment that ended on a pause (the rest is trimmed). */
const TRAILING_SILENCE_KEEP_MS = 200;

/** RMS of a PCM16LE frame, normalised to 0–1. */
export function frameRms(frame: Buffer): number {
  const samples = Math.floor(frame.length / 2);
  if (samples === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const s = frame.readInt16LE(i * 2) / 32768;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples);
}

export class PcmSegmenter {
  private readonly frameMs: number;
  private readonly frameBytes: number;
  private readonly preRollFrames: number;

  private carry: Buffer = Buffer.alloc(0);
  private preRoll: Buffer[] = [];
  private frames: Buffer[] = [];
  private active = false;
  private speechFrames = 0;
  private silenceFrames = 0;
  private segmentStartFrame = 0;
  /** Frames consumed since the stream began. */
  private position = 0;

  constructor(private readonly opts: SegmenterOptions) {
    this.frameMs = opts.frameMs ?? 20;
    const samplesPerFrame = Math.round((opts.sampleRate * this.frameMs) / 1000);
    if (samplesPerFrame <= 0) throw new Error('sampleRate too low for the frame size');
    this.frameBytes = samplesPerFrame * 2;
    this.preRollFrames = Math.floor(opts.preRollMs / this.frameMs);
  }

  /** Total audio received, in ms. */
  get receivedMs(): number {
    return this.position * this.frameMs;
  }

  /** True while a segment is being collected. */
  get inSegment(): boolean {
    return this.active;
  }

  /** Feed raw bytes (any length, even odd). Returns segments completed by this chunk. */
  push(chunk: Buffer): AudioSegment[] {
    const out: AudioSegment[] = [];
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    let offset = 0;
    while (data.length - offset >= this.frameBytes) {
      // Copy: the caller may reuse its buffer, and segments outlive this call.
      const frame = Buffer.from(data.subarray(offset, offset + this.frameBytes));
      offset += this.frameBytes;
      const seg = this.consumeFrame(frame);
      if (seg) out.push(seg);
    }
    this.carry = Buffer.from(data.subarray(offset));
    return out;
  }

  /**
   * End the current segment now (push-to-talk release, end of input).
   * Returns it if it held enough speech, else null.
   */
  flush(): AudioSegment | null {
    if (!this.active) return null;
    return this.finish('flush');
  }

  private consumeFrame(frame: Buffer): AudioSegment | null {
    const index = this.position;
    this.position += 1;
    const speech = frameRms(frame) >= this.opts.speechThreshold;

    if (!this.active) {
      if (!speech) {
        if (this.preRollFrames > 0) {
          this.preRoll.push(frame);
          if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
        }
        return null;
      }
      this.active = true;
      this.frames = [...this.preRoll, frame];
      this.segmentStartFrame = index - this.preRoll.length;
      this.preRoll = [];
      this.speechFrames = 1;
      this.silenceFrames = 0;
      return this.checkMaxLength();
    }

    this.frames.push(frame);
    if (speech) {
      this.speechFrames += 1;
      this.silenceFrames = 0;
    } else {
      this.silenceFrames += 1;
      if (this.silenceFrames * this.frameMs >= this.opts.segmentSilenceMs) {
        return this.finish('pause');
      }
    }
    return this.checkMaxLength();
  }

  private checkMaxLength(): AudioSegment | null {
    if (this.frames.length * this.frameMs >= this.opts.maxSegmentMs) {
      return this.finish('max_length');
    }
    return null;
  }

  private finish(reason: SegmentEndReason): AudioSegment | null {
    let frames = this.frames;
    if (reason === 'pause') {
      const keep = Math.floor(TRAILING_SILENCE_KEEP_MS / this.frameMs);
      const trim = Math.max(0, this.silenceFrames - keep);
      if (trim > 0) frames = frames.slice(0, frames.length - trim);
    }
    const speechMs = this.speechFrames * this.frameMs;
    const startMs = this.segmentStartFrame * this.frameMs;

    this.active = false;
    this.frames = [];
    this.speechFrames = 0;
    this.silenceFrames = 0;

    if (speechMs < this.opts.minSpeechMs) return null;
    return {
      pcm: Buffer.concat(frames),
      startMs,
      durationMs: frames.length * this.frameMs,
      speechMs,
      reason,
    };
  }
}
