/**
 * Apple Push Notification service (HTTP/2) — alert and VoIP pushes for native iOS app.
 *
 * Requires APNS_* env vars (see docs/20-native-callkit-shell.md).
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';

const log = childLogger('apns');

export type ApnsPushType = 'alert' | 'voip' | 'background';

interface ApnsConfig {
  keyId: string;
  teamId: string;
  key: string;
  bundleId: string;
  production: boolean;
}

let cachedJwt: { token: string; issuedAt: number } | null = null;

function loadApnsConfig(): ApnsConfig | null {
  const { env } = getConfig();
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const bundleId = env.APNS_BUNDLE_ID?.trim();
  if (!keyId || !teamId || !bundleId) return null;

  let key = env.APNS_KEY?.trim();
  if (!key && env.APNS_KEY_PATH?.trim()) {
    try {
      key = readFileSync(env.APNS_KEY_PATH.trim(), 'utf8');
    } catch (err) {
      log.warn({ err }, 'could not read APNS_KEY_PATH');
      return null;
    }
  }
  if (!key) return null;

  return {
    keyId,
    teamId,
    key,
    bundleId,
    production: env.APNS_PRODUCTION === 'true',
  };
}

function apnsJwt(cfg: ApnsConfig): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.issuedAt < 3000) return cachedJwt.token;

  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: cfg.keyId })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify({ iss: cfg.teamId, iat: now })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const sign = createSign('SHA256');
  sign.update(unsigned);
  const sig = sign.sign({ key: cfg.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const token = `${unsigned}.${sig}`;
  cachedJwt = { token, issuedAt: now };
  return token;
}

export function isApnsConfigured(): boolean {
  return loadApnsConfig() !== null;
}

export async function sendApnsPush(
  deviceToken: string,
  body: object,
  pushType: ApnsPushType = 'alert',
): Promise<boolean> {
  const cfg = loadApnsConfig();
  if (!cfg) return false;

  const host = cfg.production ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  const jwt = apnsJwt(cfg);

  const apsPayload =
    pushType === 'voip'
      ? body
      : {
          aps: {
            alert: {
              title: (body as Record<string, unknown>)['title'] ?? 'AgentVoice',
              body: (body as Record<string, unknown>)['body'] ?? 'New update',
            },
            sound: 'default',
            'mutable-content': 1,
          },
          ...body,
        };

  return new Promise((resolve) => {
    const client = http2.connect(`https://${host}`);
    client.on('error', (err) => {
      log.warn({ err }, 'APNs connection error');
      client.close();
      resolve(false);
    });

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': pushType === 'voip' ? `${cfg.bundleId}.voip` : cfg.bundleId,
      'apns-push-type': pushType,
      'apns-priority': pushType === 'voip' ? '10' : '10',
      'content-type': 'application/json',
    });

    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      client.close();
      if (data) {
        log.warn({ response: data, pushType }, 'APNs error response');
        resolve(false);
      } else {
        resolve(true);
      }
    });
    req.on('error', (err) => {
      log.warn({ err }, 'APNs request error');
      client.close();
      resolve(false);
    });

    req.write(JSON.stringify(apsPayload));
    req.end();
  });
}
