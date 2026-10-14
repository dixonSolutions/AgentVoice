/**
 * Streamed speech output — a vendor's response body turned into PCM16LE mono
 * chunks the moment they arrive (`PcmStream`, types.ts).
 *
 * Three shapes cover every streaming vendor:
 *   - raw PCM at a rate the request fixed (OpenAI, ElevenLabs, Deepgram, Polly)
 *   - a WAV written as it is encoded (speaches, Groq): the header is parsed for
 *     the real rate and channel count, the size fields are ignored because a
 *     streaming writer cannot know them
 *   - server-sent events carrying base64 PCM (Gemini)
 *
 * Whatever the shape, the first chunk is read before the stream is handed
 * back, so a vendor that fails at its header still fails inside the fallback
 * chain — once audio has gone to the phone there is nothing to fall back to.
 */

import type { PcmStream } from './types.js';

/** Give up on a body that stops sending for this long. */
const BODY_IDLE_MS = 30_000;
/** A WAV header that has not reached its `data` chunk by now is not one we can play. */
const MAX_WAV_HEADER_BYTES = 64 * 1024;

/**
 * A fetch body as Buffers. The fetch itself has already resolved, so its
 * timeout and abort no longer apply — this re-arms both for the body: the
 * caller's signal cancels the upstream read, and so does a long silence.
 */
export async function* bodyChunks(
  res: Response,
  opts: { signal?: AbortSignal; idleMs?: number } = {},
): AsyncGenerator<Buffer> {
  if (!res.body) throw new Error('The response has no body to stream');
  const reader = res.body.getReader();
  const idleMs = opts.idleMs ?? BODY_IDLE_MS;
  const onAbort = () => void reader.cancel().catch(() => undefined);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (opts.signal?.aborted) return;
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`No audio for ${idleMs / 1000}s`)), idleMs);
      });
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (next.done) return;
      if (next.value.byteLength) yield Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    // Stops the upstream download when the consumer leaves early (barge-in).
    void reader.cancel().catch(() => undefined);
  }
}

/** Pull the first chunk now (so a dead stream fails here), then replay it. */
async function primed(chunks: AsyncIterable<Buffer>): Promise<AsyncIterable<Buffer>> {
  const it = chunks[Symbol.asyncIterator]();
  const first = await it.next();
  async function* replay(): AsyncGenerator<Buffer> {
    try {
      if (first.done) return;
      yield first.value;
      for (;;) {
        const next = await it.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await it.return?.();
    }
  }
  if (first.done) throw new Error('The speech engine returned no audio');
  return replay();
}

/** Headerless PCM16LE mono at a rate the request asked for. */
export async function rawPcmStream(chunks: AsyncIterable<Buffer>, sampleRate: number): Promise<PcmStream> {
  return { sampleRate, chunks: await primed(chunks) };
}

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/**
 * Parse a RIFF/WAVE header from the start of a stream. Returns null until
 * `buf` reaches the `data` chunk; throws on anything that is not 16-bit PCM.
 * Chunks before `data` other than `fmt ` (ffmpeg writes a LIST) are skipped.
 */
export function parseWavHeader(buf: Buffer): { format: WavFormat; dataOffset: number } | null {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The speech engine did not return a WAV stream');
  }
  let offset = 12;
  let format: WavFormat | null = null;
  for (;;) {
    if (offset + 8 > buf.length) break;
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') {
      if (!format) throw new Error('WAV stream has no fmt chunk before its audio');
      return { format, dataOffset: offset + 8 };
    }
    if (offset + 8 + size > buf.length) break;
    if (id === 'fmt ') {
      const audioFormat = buf.readUInt16LE(offset + 8);
      format = {
        channels: buf.readUInt16LE(offset + 10),
        sampleRate: buf.readUInt32LE(offset + 12),
        bitsPerSample: buf.readUInt16LE(offset + 22),
      };
      // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE (still integer PCM at 16 bits).
      if ((audioFormat !== 1 && audioFormat !== 0xfffe) || format.bitsPerSample !== 16 || format.channels < 1) {
        throw new Error(
          `Cannot stream this WAV (format ${audioFormat}, ${format.bitsPerSample}-bit, ${format.channels} ch) — 16-bit PCM only`,
        );
      }
    }
    offset += 8 + size + (size & 1);
  }
  if (buf.length > MAX_WAV_HEADER_BYTES) throw new Error('WAV header never reached its audio');
  return null;
}

/** Average interleaved PCM16 frames down to one channel, carrying split frames across chunks. */
export async function* downmixPcm16(chunks: AsyncIterable<Buffer>, channels: number): AsyncGenerator<Buffer> {
  const frameBytes = channels * 2;
  let carry: Buffer = Buffer.alloc(0);
  for await (const chunk of chunks) {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const frames = Math.floor(buf.length / frameBytes);
    carry = Buffer.from(buf.subarray(frames * frameBytes));
    if (!frames) continue;
    const out = Buffer.alloc(frames * 2);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += buf.readInt16LE(f * frameBytes + c * 2);
      out.writeInt16LE(Math.round(sum / channels), f * 2);
    }
    yield out;
  }
}

/** A WAV written while it is encoded → its PCM, mono, as it arrives. */
export async function wavPcmStream(chunks: AsyncIterable<Buffer>): Promise<PcmStream> {
  const it = chunks[Symbol.asyncIterator]();
  let head: Buffer = Buffer.alloc(0);
  let parsed: ReturnType<typeof parseWavHeader> = null;
  try {
    while (!parsed) {
      const next = await it.next();
      if (next.done) throw new Error('The audio ended before its WAV header did');
      head = head.length ? Buffer.concat([head, next.value]) : next.value;
      parsed = parseWavHeader(head);
    }
  } catch (err) {
    await it.return?.();
    throw err;
  }
  const first = head.subarray(parsed.dataOffset);
  async function* data(): AsyncGenerator<Buffer> {
    try {
      if (first.length) yield first;
      for (;;) {
        const next = await it.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await it.return?.();
    }
  }
  const { channels, sampleRate } = parsed.format;
  return { sampleRate, chunks: channels === 1 ? data() : downmixPcm16(data(), channels) };
}

/** The `data:` payload of each server-sent event, as text. */
export async function* sseData(chunks: AsyncIterable<Buffer>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = '';
  const flush = function* (block: string): Generator<string> {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) yield data;
  };
  for await (const chunk of chunks) {
    pending += decoder.decode(chunk, { stream: true });
    let cut: RegExpExecArray | null;
    while ((cut = /\r?\n\r?\n/.exec(pending))) {
      yield* flush(pending.slice(0, cut.index));
      pending = pending.slice(cut.index + cut[0].length);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) yield* flush(pending);
}
