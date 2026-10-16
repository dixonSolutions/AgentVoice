/**
 * Push registration — Web Push (PWA) and native APNs tokens (Capacitor).
 */

import { PushNotifications } from '@capacitor/push-notifications';
import { CallSession, isNativeShell } from './call-session.js';

export async function registerPushNotifications(
  bridgeBase: string,
  appToken: string,
): Promise<void> {
  if (isNativeShell()) {
    await registerNativePush(bridgeBase, appToken);
    return;
  }
  await registerWebPush(bridgeBase, appToken);
}

async function registerWebPush(bridgeBase: string, appToken: string): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  const configRes = await fetch(`${bridgeBase}/api/push/config`, {
    headers: { Authorization: `Bearer ${appToken}` },
  });
  if (!configRes.ok) return;
  const config = (await configRes.json()) as { vapidPublicKey?: string | null };
  if (!config.vapidPublicKey) return;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
    });
  }

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.['p256dh'] || !json.keys?.['auth']) return;

  await fetch(`${bridgeBase}/api/push/subscribe-web`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys['p256dh'], auth: json.keys['auth'] },
    }),
  });
}

async function registerNativePush(bridgeBase: string, appToken: string): Promise<void> {
  const perm = await PushNotifications.requestPermissions();
  if (perm.receive !== 'granted') return;

  await PushNotifications.register();

  PushNotifications.addListener('registration', (token) => {
    const platform = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : 'android';
    void postNativeToken(bridgeBase, appToken, platform, token.value);
  });

  void CallSession.addListener('voipToken', (data) => {
    const voip = data['token'];
    if (typeof voip === 'string' && voip) {
      void postNativeToken(bridgeBase, appToken, 'ios_voip', voip);
    }
  });
}

async function postNativeToken(
  bridgeBase: string,
  appToken: string,
  platform: 'ios' | 'android' | 'ios_voip',
  token: string,
): Promise<void> {
  await fetch(`${bridgeBase}/api/push/register-native`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      platform,
      token,
      bundle_id: 'com.squeakr.app',
    }),
  });
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
