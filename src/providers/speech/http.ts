/**
 * Speech-specific HTTP helpers.
 *
 * Generic transport, error classification and the Specializer factory live in
 * src/orchestration/http.ts; this file only holds the shapes several speech
 * vendors happen to share.
 */

export {
  ProviderHttpError as SpeechHttpError,
  expectOk,
  httpFetch as speechFetch,
  readErrorDetail,
  type HttpCall,
  type HttpConverter,
} from '../../orchestration/http.js';

import { expectOk, httpFetch, type HttpCall } from '../../orchestration/http.js';

/**
 * Build a multipart call for an OpenAI-compatible
 * `/audio/transcriptions` endpoint. Shared by OpenAI, Groq, and any
 * self-hosted Whisper server that speaks the same shape.
 */
export function openAiTranscriptionCall(args: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  wav: Buffer;
  language?: string;
  /** Extra multipart fields (prompt, temperature, vad_filter, …). */
  extraFields?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): HttpCall {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(args.wav)], { type: 'audio/wav' }), 'turn.wav');
  form.append('model', args.model);
  form.append('response_format', 'json');
  if (args.language && args.language !== 'auto') form.append('language', args.language);
  for (const [key, value] of Object.entries(args.extraFields ?? {})) form.append(key, value);

  return {
    url: `${args.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`,
    method: 'POST',
    ...(args.apiKey ? { headers: { Authorization: `Bearer ${args.apiKey}` } } : {}),
    body: form,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  };
}

/** `{ text }` — the response every OpenAI-compatible transcription returns. */
export async function decodeOpenAiTranscription(res: Response): Promise<string> {
  const body = (await res.json()) as { text?: string };
  return (body.text ?? '').trim();
}

/**
 * POST a WAV to an OpenAI-compatible endpoint directly, outside the
 * orchestrator. Used by setup warm-up, which needs one specific server rather
 * than whatever the chain would pick.
 */
export async function postOpenAiTranscription(args: {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  wav: Buffer;
  language?: string;
  extraFields?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const { provider, ...rest } = args;
  const call = openAiTranscriptionCall(rest);
  const res = await httpFetch(
    call.url,
    {
      method: call.method ?? 'POST',
      ...(call.headers ? { headers: call.headers } : {}),
      ...(call.body !== undefined ? { body: call.body } : {}),
    },
    {
      ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}),
      ...(call.signal ? { signal: call.signal } : {}),
    },
  );
  await expectOk(res, provider);
  return decodeOpenAiTranscription(res);
}

/** Strip the wrapping quotes/fences an LLM sometimes adds around a transcript. */
export function cleanLlmTranscript(text: string): string {
  return text
    .trim()
    .replace(/^```(?:\w+)?\s*|\s*```$/g, '')
    .replace(/^["'“”](.*)["'“”]$/s, '$1')
    .trim();
}
