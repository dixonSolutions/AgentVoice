/**
 * Unified phone notification — WebSocket (instant UI) + push (background / app closed).
 */

import { pushToPhone, isControlSocketOpen } from '../state/controlSocket.js';
import { listPushSubscriptions } from '../state/pushStore.js';
import { sendWebPush } from './webPush.js';
import { sendApnsPush } from './apns.js';
import { childLogger } from '../log.js';

const log = childLogger('notify-phone');

export interface NotifyResult {
  ws: boolean;
  webPush: number;
  apns: number;
}

function pushPayloadForType(msg: Record<string, unknown>): {
  title: string;
  body: string;
  tag: string;
  url: string;
  voip: boolean;
} | null {
  const type = msg['type'] as string | undefined;
  switch (type) {
    case 'user_input_request': {
      const q = String(msg['question'] ?? 'Cursor needs your answer');
      return {
        title: 'AgentVoice',
        body: q.slice(0, 180),
        tag: `approval-${msg['request_id'] ?? 'input'}`,
        url: '/?tab=voice',
        voip: true,
      };
    }
    case 'plan_approval_request': {
      const title = String(msg['title'] ?? 'Plan ready for review');
      return {
        title: 'AgentVoice — Plan',
        body: title.slice(0, 180),
        tag: `plan-${msg['request_id'] ?? 'plan'}`,
        url: '/?tab=voice',
        voip: true,
      };
    }
    case 'narration': {
      const kind = msg['kind'] as string | undefined;
      if (kind !== 'job_done' && kind !== 'job_error') return null;
      const text = String(msg['text'] ?? (kind === 'job_done' ? 'Job finished' : 'Job failed'));
      return {
        title: kind === 'job_done' ? 'AgentVoice — Done' : 'AgentVoice — Error',
        body: text.slice(0, 180),
        tag: `narration-${kind}`,
        url: '/?tab=voice',
        voip: false,
      };
    }
    case 'show_images': {
      const caption = msg['caption'] as string | undefined;
      return {
        title: 'AgentVoice',
        body: caption?.slice(0, 180) ?? 'New screenshots from Cursor',
        tag: `images-${msg['batch_id'] ?? 'batch'}`,
        url: '/?tab=voice',
        voip: false,
      };
    }
    case 'auth_required': {
      const displayName = String(msg['displayName'] ?? 'Your agent');
      return {
        title: 'AgentVoice — Sign-in needed',
        body: `${displayName} needs you to sign in before it can keep working.`,
        tag: 'auth-required',
        url: '/?tab=voice',
        voip: true,
      };
    }
    default:
      return null;
  }
}

function shouldSendPush(msg: Record<string, unknown>): boolean {
  return pushPayloadForType(msg) !== null;
}

/**
 * Deliver to connected PWA (WebSocket) and push subscriptions when appropriate.
 * Critical events (approvals, job done, images) always attempt push even if WS is open.
 */
export async function notifyPhone(payload: object): Promise<NotifyResult> {
  const msg = payload as Record<string, unknown>;
  const ws = pushToPhone(payload);
  const result: NotifyResult = { ws, webPush: 0, apns: 0 };

  if (!shouldSendPush(msg)) {
    return result;
  }

  const pushMeta = pushPayloadForType(msg)!;
  const pushBody = {
    ...msg,
    title: pushMeta.title,
    body: pushMeta.body,
    tag: pushMeta.tag,
    url: pushMeta.url,
  };

  const type = msg['type'] as string | undefined;
  const alwaysPush =
    type === 'user_input_request' || type === 'plan_approval_request' || type === 'auth_required';

  // Approvals always push (user may be on another app). Skip others if WS live.
  if (ws && isControlSocketOpen() && !alwaysPush) {
    log.debug({ type }, 'notifyPhone: WS delivered, skipping push');
    return result;
  }

  const subs = listPushSubscriptions();
  for (const sub of subs) {
    if (sub.platform === 'web' && sub.p256dh && sub.auth) {
      const ok = await sendWebPush(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        pushBody,
      );
      if (ok) result.webPush++;
    } else if (sub.platform === 'ios_voip' && sub.token) {
      const ok = await sendApnsPush(sub.token, pushBody, 'voip');
      if (ok) result.apns++;
    } else if (sub.platform === 'ios' && sub.token) {
      const ok = await sendApnsPush(sub.token, pushBody, 'alert');
      if (ok) result.apns++;
    }
  }

  if (result.webPush + result.apns > 0) {
    log.info(
      { type: msg['type'], webPush: result.webPush, apns: result.apns },
      'push notifications sent',
    );
  }

  return result;
}
