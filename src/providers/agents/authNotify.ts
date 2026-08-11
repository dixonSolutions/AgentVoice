/**
 * Shared "the active CLI just failed because it isn't authenticated" handler.
 * Called from both jobManager (worker jobs) and voiceAgent (conversational
 * loop) close paths — one place decides how that gets surfaced to the phone.
 */

import { childLogger } from '../../log.js';
import { notifyPhone } from '../../push/notifyPhone.js';
import { getActiveProvider } from './registry.js';

const log = childLogger('auth-notify');

/** Debounce identical pushes — a burst of failed spawns shouldn't spam the phone. */
let lastNotifiedAt = 0;
const DEBOUNCE_MS = 30_000;

export async function notifyAuthRequired(context: string): Promise<void> {
  const now = Date.now();
  if (now - lastNotifiedAt < DEBOUNCE_MS) {
    log.debug({ context }, 'auth_required push debounced');
    return;
  }
  lastNotifiedAt = now;

  const provider = getActiveProvider();
  const flows = provider.authFlows();

  log.warn({ provider: provider.id, context }, 'agent exited with an authentication error — notifying phone');

  await notifyPhone({
    type: 'auth_required',
    provider: provider.id,
    displayName: provider.displayName,
    flows,
    context,
  });
}
