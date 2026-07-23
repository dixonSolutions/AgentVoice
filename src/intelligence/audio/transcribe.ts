/**
 * Amazon Transcribe streaming STT — Speech Foundation Model (SFM).
 *
 * Uses StartStreamTranscription (HTTP/2). AWS’s premier multi-billion-parameter
 * ASR powers this API; there is no separate ModelId — SFM is the standard engine.
 *
 * Accepts 16-bit PCM mono at 16 kHz.
 */

import {
  LanguageCode,
  MediaEncoding,
  PartialResultsStability,
  StartStreamTranscriptionCommand,
  type TranscribeStreamingClient,
} from '@aws-sdk/client-transcribe-streaming';
import { getConfig } from '../../config.js';
import { childLogger } from '../../log.js';
import { createTranscribeStreamingClient } from './awsClient.js';

const log = childLogger('intelligence:transcribe');

const CHUNK_BYTES = 6400; // 200 ms @ 16 kHz 16-bit mono

export const TRANSCRIBE_MODELS = [
  {
    id: 'speech_foundation_model' as const,
    label: 'Speech Foundation Model (SFM)',
    description:
      'Amazon Transcribe’s premier multi-billion-parameter ASR — 100+ languages, word timestamps, streaming. Fastest real-time option with IAM keys.',
    recommended: true,
  },
] as const;

export type TranscribeModelId = (typeof TRANSCRIBE_MODELS)[number]['id'];

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

export async function transcribePcm16(pcm: Buffer): Promise<string> {
  if (pcm.length < 3200) {
    throw new Error('Audio too short — speak for at least half a second');
  }

  const client = createTranscribeStreamingClient();
  try {
    return await runTranscribeStream(client, pcm);
  } finally {
    client.destroy();
  }
}

async function runTranscribeStream(client: TranscribeStreamingClient, pcm: Buffer): Promise<string> {
  const audio = getConfig().settings.workflow.llmIntelligence.audio;
  const stabilize = audio.transcribePartialResultsStabilization !== false;
  const stability = audio.transcribePartialResultsStability ?? 'high';

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
    audio.transcribeLanguageMode === 'identify'
      ? new StartStreamTranscriptionCommand({
          ...base,
          IdentifyLanguage: true,
          LanguageOptions: sanitizeLanguageOptions(audio.transcribeLanguageOptions),
          PreferredLanguage: asLanguageCode(
            audio.transcribePreferredLanguage?.trim() || audio.transcribeLanguageCode,
          ),
        })
      : new StartStreamTranscriptionCommand({
          ...base,
          LanguageCode: asLanguageCode(audio.transcribeLanguageCode),
        });

  log.debug(
    {
      model: audio.transcribeModel,
      languageMode: audio.transcribeLanguageMode,
      languageCode: audio.transcribeLanguageCode,
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
