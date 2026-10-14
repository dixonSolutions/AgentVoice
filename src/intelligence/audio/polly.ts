/**
 * Amazon Polly — SynthesizeSpeech and DescribeVoices.
 *
 * Option-driven rather than config-reading: the speech-output provider
 * (src/providers/speech/output/polly.ts) resolves voice and engine from its
 * scopes and passes them in, so settings are interpreted in exactly one place.
 */

import {
  DescribeVoicesCommand,
  OutputFormat,
  SynthesizeSpeechCommand,
  type Engine,
  type VoiceId,
} from '@aws-sdk/client-polly';
import { childLogger } from '../../log.js';
import { createPollyClient } from './awsClient.js';

const log = childLogger('intelligence:polly');

const MAX_POLLY_CHARS = 3000;

export interface PollySynthResult {
  audio: Buffer;
  contentType: 'audio/mpeg';
}

export interface PollyVoiceInfo {
  id: string;
  name: string;
  languageCode: string;
  languageName: string;
  gender: string;
  supportedEngines: string[];
}

export type PollyEngine = 'standard' | 'neural' | 'generative';

/** List Polly voices for the given engine (DescribeVoices). */
export async function listPollyVoices(engine: PollyEngine = 'neural'): Promise<PollyVoiceInfo[]> {
  const selectedEngine = engine;
  const client = createPollyClient();

  try {
    const voices: PollyVoiceInfo[] = [];
    let nextToken: string | undefined;
    do {
      const response = await client.send(
        new DescribeVoicesCommand({
          Engine: selectedEngine as Engine,
          NextToken: nextToken,
        }),
      );
      for (const v of response.Voices ?? []) {
        if (!v.Id || !v.Name) continue;
        voices.push({
          id: v.Id,
          name: v.Name,
          languageCode: v.LanguageCode ?? '',
          languageName: v.LanguageName ?? '',
          gender: v.Gender ?? '',
          supportedEngines: (v.SupportedEngines ?? []).map(String),
        });
      }
      nextToken = response.NextToken;
    } while (nextToken);

    voices.sort((a, b) => {
      const lang = a.languageCode.localeCompare(b.languageCode);
      if (lang !== 0) return lang;
      return a.name.localeCompare(b.name);
    });
    return voices;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message, engine: selectedEngine }, 'DescribeVoices failed');
    throw new Error(`Could not list Polly voices: ${message}`);
  } finally {
    client.destroy();
  }
}

export async function synthesizePollyMp3(
  text: string,
  opts: { voiceId?: string; engine?: PollyEngine } = {},
): Promise<PollySynthResult> {
  const clean = text.trim().slice(0, MAX_POLLY_CHARS);
  if (!clean) {
    throw new Error('Polly text is empty');
  }

  const voiceId = opts.voiceId?.trim() || 'Joanna';
  const engine = opts.engine ?? 'neural';
  const client = createPollyClient();

  try {
    const response = await client.send(
      new SynthesizeSpeechCommand({
        Text: clean,
        OutputFormat: OutputFormat.MP3,
        VoiceId: voiceId as VoiceId,
        Engine: engine as Engine,
      }),
    );

    const bytes = await response.AudioStream?.transformToByteArray();
    if (!bytes?.length) {
      throw new Error('Polly returned empty audio');
    }

    return { audio: Buffer.from(bytes), contentType: 'audio/mpeg' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'polly synthesis failed');
    throw new Error(`Polly TTS failed: ${message}`);
  } finally {
    client.destroy();
  }
}

/** Polly's `pcm` output: signed 16-bit little-endian mono, 8 or 16 kHz. */
export const POLLY_PCM_RATE = 16_000;

/**
 * The same synthesis as `synthesizePollyMp3`, as headerless PCM handed on
 * chunk by chunk — `AudioStream` is already a stream; this stops collecting it.
 * The client lives until the stream is drained or abandoned.
 */
export async function streamPollyPcm(
  text: string,
  opts: { voiceId?: string; engine?: PollyEngine; signal?: AbortSignal } = {},
): Promise<{ sampleRate: number; chunks: AsyncIterable<Buffer> }> {
  const clean = text.trim().slice(0, MAX_POLLY_CHARS);
  if (!clean) {
    throw new Error('Polly text is empty');
  }

  const client = createPollyClient();
  let audio: AsyncIterable<Uint8Array>;
  try {
    const response = await client.send(
      new SynthesizeSpeechCommand({
        Text: clean,
        OutputFormat: OutputFormat.PCM,
        SampleRate: String(POLLY_PCM_RATE),
        VoiceId: (opts.voiceId?.trim() || 'Joanna') as VoiceId,
        Engine: (opts.engine ?? 'neural') as Engine,
      }),
      opts.signal ? { abortSignal: opts.signal } : {},
    );
    const stream = response.AudioStream as unknown as AsyncIterable<Uint8Array> | undefined;
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new Error('Polly returned no audio stream');
    }
    audio = stream;
  } catch (err) {
    client.destroy();
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'polly streaming synthesis failed');
    throw new Error(`Polly TTS failed: ${message}`);
  }

  async function* chunks(): AsyncGenerator<Buffer> {
    try {
      for await (const chunk of audio) {
        if (opts.signal?.aborted) return;
        if (chunk.byteLength) yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
    } finally {
      client.destroy();
    }
  }
  return { sampleRate: POLLY_PCM_RATE, chunks: chunks() };
}

export async function pingPolly(): Promise<void> {
  await synthesizePollyMp3('OK');
}
