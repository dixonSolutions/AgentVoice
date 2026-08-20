/**
 * Map SDK / HTTP / network errors to short, actionable speech messages.
 *
 * Both directions share a provider chain, so a message has to name the engine
 * that actually failed — "check AWS credentials" is worse than useless when the
 * active provider is Groq — and point at the screen that fixes it.
 */

import { SpeechHttpError } from './http.js';

export type SpeechDirection = 'input' | 'output';

export function friendlySpeechError(
  err: unknown,
  providerLabel: string,
  direction: SpeechDirection = 'input',
): string {
  const settingsHint =
    direction === 'input' ? 'Config → Speech → Speech in' : 'Config → Speech → Speech out';

  if (err instanceof SpeechHttpError) {
    if (err.isAuthError) {
      return `${providerLabel} rejected the API key — update it in ${settingsHint}.`;
    }
    if (err.status === 429) {
      return `${providerLabel} is rate limiting — wait a moment and try again.`;
    }
    if (err.status === 404) {
      return `${providerLabel} does not recognize the selected model or voice — pick another in ${settingsHint}.`;
    }
    if (err.status >= 500) {
      return `${providerLabel} is having trouble (${err.status}) — try again shortly.`;
    }
    return `${providerLabel}: ${err.detail}`;
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes('http/2 stream') || lower.includes('abnormally aborted')) {
    return `${providerLabel} failed — the bridge could not reach AWS. Check container DNS and try again.`;
  }
  if (lower.includes('econnrefused')) {
    return `${providerLabel} refused the connection — is the speech server running?`;
  }
  if (lower.includes('enotfound') || lower.includes('eai_again') || lower.includes('network')) {
    return `${providerLabel} failed — network error reaching the speech service.`;
  }
  if (lower.includes('timed out') || lower.includes('etimedout')) {
    return `${providerLabel} timed out — a large local model can take a while on the first turn.`;
  }
  if (lower.includes('too short') || lower.includes('no ') || lower.includes('not configured')) {
    return message;
  }
  if (
    lower.includes('credentials') ||
    lower.includes('unrecognizedclient') ||
    lower.includes('access denied')
  ) {
    return `${providerLabel} failed — check the credentials on the bridge.`;
  }

  return message.length > 200 ? `${message.slice(0, 197)}…` : message;
}
