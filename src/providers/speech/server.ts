/**
 * The self-hosted speech server — config accessors and health probe.
 *
 * One OpenAI-compatible server handles both directions: `local_whisper` posts
 * to `{api}/audio/transcriptions`, `local_speech` to `{api}/audio/speech`.
 * Keeping the URL/health logic here means the two providers, the container
 * lifecycle, and the status route all agree on where the server is.
 *
 * Default image is speaches (faster-whisper for input, Kokoro/Piper for
 * output). Any server exposing the same two routes works — Ollama does not,
 * it has no speech endpoints at all.
 */

import { getConfig, type SpeechServerSettings } from '../../config.js';
import { speechFetch } from './http.js';

export function speechServerSettings(): SpeechServerSettings {
  return getConfig().settings.workflow.llmIntelligence.audio.speechServer;
}

/** Server root, without a trailing slash. */
export function speechServerRoot(settings = speechServerSettings()): string {
  const explicit = settings.baseUrl?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return `http://127.0.0.1:${settings.port}`;
}

/** OpenAI-compatible API base (server root + apiPath). */
export function speechServerApiBase(settings = speechServerSettings()): string {
  const path = settings.apiPath.startsWith('/') ? settings.apiPath : `/${settings.apiPath}`;
  return `${speechServerRoot(settings)}${path.replace(/\/+$/, '')}`;
}

/**
 * Is the server answering? Tries `/health` first (speaches, whisper.cpp) and
 * falls back to the OpenAI model list, so any compatible server passes.
 */
export async function probeSpeechServer(
  settings = speechServerSettings(),
): Promise<{ reachable: boolean; detail?: string }> {
  const candidates = [`${speechServerRoot(settings)}/health`, `${speechServerApiBase(settings)}/models`];
  let lastDetail = 'no response';

  for (const url of candidates) {
    try {
      const res = await speechFetch(url, { method: 'GET' }, { timeoutMs: 4_000 });
      if (res.ok) return { reachable: true };
      lastDetail = `${url} → ${res.status} ${res.statusText}`.trim();
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
    }
  }

  return { reachable: false, detail: lastDetail };
}

/** True when the server is configured well enough to be worth trying. */
export function isSpeechServerConfigured(settings = speechServerSettings()): boolean {
  // `container` derives a loopback URL from the port; `external` needs one given.
  return settings.manage === 'container' || Boolean(settings.baseUrl?.trim());
}

export function speechServerUnavailableDetail(settings = speechServerSettings()): string {
  return settings.manage === 'container'
    ? `Speech container is not answering on ${speechServerRoot(settings)} — run Setup`
    : `No server at ${speechServerRoot(settings)}`;
}
