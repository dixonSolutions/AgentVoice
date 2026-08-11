/**
 * Web Push (VAPID) sender for PWA clients.
 */

import webpush from 'web-push';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';
import type { WebPushSubscription } from '../state/pushStore.js';

const log = childLogger('web-push');

let configured = false;

export function getVapidPublicKey(): string | null {
  const { env } = getConfig();
  return env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() || null;
}

function ensureConfigured(): boolean {
  if (configured) return true;
  const { env } = getConfig();
  const pub = env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
  const priv = env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim();
  const subject = env.WEB_PUSH_VAPID_SUBJECT?.trim() || 'mailto:agentvoice@localhost';
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  return true;
}

export async function sendWebPush(
  sub: WebPushSubscription,
  payload: object,
): Promise<boolean> {
  if (!ensureConfigured()) return false;
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      },
      JSON.stringify(payload),
      { TTL: 86400, urgency: 'high' },
    );
    return true;
  } catch (err) {
    log.warn({ err, endpoint: sub.endpoint.slice(0, 48) }, 'web push failed');
    return false;
  }
}
