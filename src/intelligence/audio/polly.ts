/**
 * Amazon Polly TTS for llm_intelligence fallback when WebKit speechSynthesis is unavailable.
 */

import {
  DescribeVoicesCommand,
  Engine,
  OutputFormat,
  SynthesizeSpeechCommand,
  type VoiceId,
} from '@aws-sdk/client-polly';
import { getConfig } from '../../config.js';
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

/** List Polly voices for the given engine (DescribeVoices). */
export async function listPollyVoices(
  engine?: 'standard' | 'neural' | 'generative',
): Promise<PollyVoiceInfo[]> {
  const { pollyEngine } = getConfig().settings.workflow.llmIntelligence.audio;
  const selectedEngine = engine ?? pollyEngine;
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
  overrides?: { voiceId?: string; engine?: 'standard' | 'neural' | 'generative' },
): Promise<PollySynthResult> {
  const clean = text.trim().slice(0, MAX_POLLY_CHARS);
  if (!clean) {
    throw new Error('Polly text is empty');
  }

  const { pollyVoiceId, pollyEngine } = getConfig().settings.workflow.llmIntelligence.audio;
  const voiceId = overrides?.voiceId?.trim() || pollyVoiceId;
  const engine = overrides?.engine ?? pollyEngine;
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

export async function pingPolly(): Promise<void> {
  await synthesizePollyMp3('OK');
}
