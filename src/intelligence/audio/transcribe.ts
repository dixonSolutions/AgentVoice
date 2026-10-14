/**
 * Amazon Transcribe streaming STT — Speech Foundation Model (SFM).
 *
 * Uses StartStreamTranscription (HTTP/2). AWS’s premier multi-billion-parameter
 * ASR powers this API; there is no separate ModelId — SFM is the standard engine.
 *
 * Accepts 16-bit PCM mono at 16 kHz.
 */

import {
  MediaEncoding,
  PartialResultsStability,
  StartStreamTranscriptionCommand,
  type LanguageCode,
  type TranscribeStreamingClient,
} from '@aws-sdk/client-transcribe-streaming';
import { childLogger } from '../../log.js';
import { createTranscribeStreamingClient } from './awsClient.js';

const log = childLogger('intelligence:transcribe');

const CHUNK_BYTES = 6400; // 200 ms @ 16 kHz 16-bit mono


function asLanguageCode(code: string): LanguageCode {
  return code as LanguageCode;
}

/** Keep at most one locale per ISO language (Transcribe identify requirement). */
export function sanitizeLanguageOptions(raw: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const code = part.trim();
    if (!code || !/^[a-z]{2}-[A-Z]{2}$/.test(code)) continue;
    const lang = code.slice(0, 2).toLowerCase();
    if (seen.has(lang)) continue;
    seen.add(lang);
    out.push(code);
  }
  return out.join(',') || 'en-US';
}

/** Smallest utterance Transcribe is worth asking about. */
const MIN_PCM_BYTES = 3200;

type AudioEvents = AsyncIterable<{ AudioEvent: { AudioChunk: Uint8Array } }>;

async function* pcmAudioStream(pcm: Buffer): AsyncGenerator<{ AudioEvent: { AudioChunk: Uint8Array } }> {
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    yield { AudioEvent: { AudioChunk: pcm.subarray(offset, offset + CHUNK_BYTES) } };
  }
}

/**
 * Audio that is still being spoken, as Transcribe's input stream: chunks are
 * forwarded the moment they are pushed (split to CHUNK_BYTES), and the stream
 * ends when the speaker does.
 */
export class LivePcmQueue implements AudioEvents {
  private readonly queued: Buffer[] = [];
  private ended = false;
  private wake: (() => void) | null = null;

  push(pcm: Buffer): void {
    if (this.ended || pcm.length === 0) return;
    for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
      this.queued.push(pcm.subarray(offset, offset + CHUNK_BYTES));
    }
    this.notify();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<{ AudioEvent: { AudioChunk: Uint8Array } }> {
    for (;;) {
      const next = this.queued.shift();
      if (next) {
        yield { AudioEvent: { AudioChunk: next } };
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/**
 * Streaming parameters, supplied by the Amazon speech-input provider from its
 * scope values — this module no longer reads config, so the provider layer
 * stays the single place that knows how settings map to a request.
 */
export interface TranscribeStreamOptions {
  /** BCP-47 locale for `fixed` mode, and the preferred hint for `identify`. */
  languageCode: string;
  languageMode: 'fixed' | 'identify';
  /** Comma-separated locales for `identify` — at most one locale per language. */
  languageOptions: string;
  stabilize: boolean;
  stability: 'low' | 'medium' | 'high';
}

export async function transcribePcm16(
  pcm: Buffer,
  opts: TranscribeStreamOptions,
): Promise<string> {
  if (pcm.length < MIN_PCM_BYTES) {
    throw new Error('Audio too short — speak for at least half a second');
  }

  const client = createTranscribeStreamingClient();
  try {
    return await runTranscribeStream(client, pcmAudioStream(pcm), opts);
  } finally {
    client.destroy();
  }
}

/**
 * Transcribe an utterance while it is spoken: the stream opens now, every
 * `push` goes straight to Amazon, and `finish()` — when the speaker stops —
 * only waits for the last results instead of uploading the whole utterance.
 */
export function startLiveTranscription(opts: TranscribeStreamOptions): {
  push(pcm: Buffer): void;
  finish(): Promise<string>;
  abort(): void;
} {
  const queue = new LivePcmQueue();
  const abort = new AbortController();
  const client = createTranscribeStreamingClient();
  let bytes = 0;
  const result = runTranscribeStream(client, queue, opts, abort.signal).finally(() => client.destroy());
  // Surfaced through finish(); an aborted utterance's rejection goes nowhere.
  result.catch(() => undefined);

  return {
    push(pcm) {
      bytes += pcm.length;
      queue.push(pcm);
    },
    async finish() {
      queue.end();
      if (bytes < MIN_PCM_BYTES) {
        abort.abort();
        throw new Error('Audio too short — speak for at least half a second');
      }
      return result;
    },
    abort() {
      queue.end();
      abort.abort();
    },
  };
}

async function runTranscribeStream(
  client: TranscribeStreamingClient,
  audio: AudioEvents,
  opts: TranscribeStreamOptions,
  signal?: AbortSignal,
): Promise<string> {
  const { stabilize, stability } = opts;

  const base = {
    MediaEncoding: MediaEncoding.PCM,
    MediaSampleRateHertz: 16000,
    AudioStream: audio,
    ...(stabilize
      ? {
          EnablePartialResultsStabilization: true,
          PartialResultsStability:
            stability === 'low'
              ? PartialResultsStability.LOW
              : stability === 'medium'
                ? PartialResultsStability.MEDIUM
                : PartialResultsStability.HIGH,
        }
      : {}),
  };

  const command =
    opts.languageMode === 'identify'
      ? new StartStreamTranscriptionCommand({
          ...base,
          IdentifyLanguage: true,
          LanguageOptions: sanitizeLanguageOptions(opts.languageOptions),
          PreferredLanguage: asLanguageCode(opts.languageCode),
        })
      : new StartStreamTranscriptionCommand({
          ...base,
          LanguageCode: asLanguageCode(opts.languageCode),
        });

  log.debug(
    {
      languageMode: opts.languageMode,
      languageCode: opts.languageCode,
      stabilize,
      stability,
      live: audio instanceof LivePcmQueue,
    },
    'transcribe SFM stream start',
  );

  const response = await client.send(command, signal ? { abortSignal: signal } : {});
  const parts: string[] = [];

  for await (const event of response.TranscriptResultStream ?? []) {
    const results = event.TranscriptEvent?.Transcript?.Results;
    if (!results) continue;
    for (const result of results) {
      if (result.IsPartial) continue;
      const text = result.Alternatives?.[0]?.Transcript?.trim();
      if (text) parts.push(text);
    }
  }

  const transcript = parts.join(' ').trim();
  if (!transcript) {
    log.debug('transcribe returned empty');
  }
  return transcript;
}
