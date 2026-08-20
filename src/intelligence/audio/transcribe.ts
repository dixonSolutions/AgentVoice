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

async function* pcmAudioStream(pcm: Buffer): AsyncGenerator<{ AudioEvent: { AudioChunk: Uint8Array } }> {
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    yield { AudioEvent: { AudioChunk: pcm.subarray(offset, offset + CHUNK_BYTES) } };
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
  if (pcm.length < 3200) {
    throw new Error('Audio too short — speak for at least half a second');
  }

  const client = createTranscribeStreamingClient();
  try {
    return await runTranscribeStream(client, pcm, opts);
  } finally {
    client.destroy();
  }
}

async function runTranscribeStream(
  client: TranscribeStreamingClient,
  pcm: Buffer,
  opts: TranscribeStreamOptions,
): Promise<string> {
  const { stabilize, stability } = opts;

  const base = {
    MediaEncoding: MediaEncoding.PCM,
    MediaSampleRateHertz: 16000,
    AudioStream: pcmAudioStream(pcm),
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
      pcmBytes: pcm.length,
    },
    'transcribe SFM stream start',
  );

  const response = await client.send(command);
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
    log.debug({ pcmBytes: pcm.length }, 'transcribe returned empty');
  }
  return transcript;
}
