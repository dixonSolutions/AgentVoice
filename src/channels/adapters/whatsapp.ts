/**
 * WhatsApp — the official Cloud API: Meta POSTs messages to the bridge's
 * webhook (`/hooks/whatsapp`, signed with the app secret), replies go out
 * through the Graph API. That needs the bridge reachable over public HTTPS
 * (a tunnel or Funnel, docs/25).
 *
 * Every chat is a DM with the business number, so every message from an
 * allowlisted number is a command; voice messages are transcribed as turns
 * and answered with a voice message.
 *
 * Calls are not implemented: the Cloud API Calling API answers calls over
 * WebRTC (SDP offer/answer through the Graph API, then ICE/DTLS/SRTP media),
 * and is only open to numbers with a messaging limit of 2,000+ recipients a
 * day. Unofficial WhatsApp Web libraries (Baileys) were ruled out — they
 * break WhatsApp's terms and cannot carry call audio either. See docs/44.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { childLogger } from '../../log.js';
import { chunkText, toWhatsApp } from '../format.js';
import type { ChannelHub, ChannelOutbound } from '../hub.js';
import type { ChannelAdapter, ChannelCapabilities, ChannelStatus } from '../types.js';

const log = childLogger('channels:whatsapp');

const MAX_TEXT = 4000;
export const WHATSAPP_WEBHOOK_PATH = '/hooks/whatsapp';

export const WHATSAPP_CAPABILITIES: ChannelCapabilities = {
  mentions: { supported: false, note: 'The Cloud API only carries one-to-one chats with the business number.' },
  directMessages: { supported: true, note: 'Every message to the bot number from an allowlisted phone is a command.' },
  voiceCalls: {
    supported: false,
    note: 'WhatsApp calls need the Cloud API Calling API (WebRTC media, 2,000+ daily-recipient tier) — not implemented yet. Send a voice message instead.',
  },
  voiceNotes: { supported: true, note: 'Voice messages become turns; the agent answers with a voice message.' },
  liveStatus: { supported: false, note: 'The Cloud API cannot edit a sent message.' },
};

interface WaMessage {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  audio?: { id: string; mime_type?: string; voice?: boolean };
}
interface WaWebhook {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
        messages?: WaMessage[];
      };
    }>;
  }>;
}

/** Check Meta's `X-Hub-Signature-256: sha256=<hex>` over the raw body. */
export function verifyMetaSignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(raw).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly id = 'whatsapp' as const;
  readonly displayName = 'WhatsApp';
  readonly capabilities = WHATSAPP_CAPABILITIES;
  readonly tokenEnvVars = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET'] as const;

  private state: ChannelStatus['state'] = 'off';
  private detail: string | undefined;
  private running = false;

  constructor(
    private readonly hub: ChannelHub,
    private readonly creds: { accessToken: string; phoneNumberId: string; verifyToken: string; appSecret: string },
    private readonly apiBase = 'https://graph.facebook.com/v23.0',
  ) {}

  status() {
    return { state: this.state, ...(this.detail ? { detail: this.detail } : {}), calls: 0 };
  }

  async start(): Promise<void> {
    this.running = true;
    this.state = 'connected';
    this.detail = `webhook ${WHATSAPP_WEBHOOK_PATH} · number ${this.creds.phoneNumberId}`;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.state = 'off';
  }

  /** The webhook. Registered once at startup; answers 404 while the channel is off. */
  register(app: FastifyInstance, current: () => WhatsAppAdapter | null): void {
    app.register(async (scope) => {
      // Signatures are over the exact bytes Meta sent — keep them.
      scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
      scope.get<{ Querystring: Record<string, string> }>(WHATSAPP_WEBHOOK_PATH, async (req, reply) => {
        const self = current();
        if (!self?.running) return reply.code(404).send();
        const q = req.query;
        if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === self.creds.verifyToken) {
          return reply.type('text/plain').send(q['hub.challenge'] ?? '');
        }
        return reply.code(403).send();
      });
      scope.post(WHATSAPP_WEBHOOK_PATH, async (req, reply) => {
        const self = current();
        if (!self?.running) return reply.code(404).send();
        const raw = req.body as Buffer;
        if (!Buffer.isBuffer(raw) || !verifyMetaSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, self.creds.appSecret)) {
          log.warn({ ip: req.ip }, 'whatsapp webhook with a bad signature');
          return reply.code(401).send();
        }
        let body: WaWebhook;
        try {
          body = JSON.parse(raw.toString('utf-8')) as WaWebhook;
        } catch {
          return reply.code(400).send();
        }
        // Answer Meta at once; work happens after.
        void self.onWebhook(body).catch((err: unknown) => log.warn({ err }, 'whatsapp message handling failed'));
        return reply.code(200).send();
      });
    });
  }

  private async graph(path: string, init: RequestInit): Promise<unknown> {
    const res = await fetch(`${this.apiBase}/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.creds.accessToken}`, ...(init.headers as Record<string, string> | undefined) },
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new Error(`WhatsApp ${path}: ${json.error?.message ?? `HTTP ${res.status}`}`);
    return json;
  }

  /** Post into a conversation by id — the message channel, for session logs. */
  outboundFor(conversationId: string): ChannelOutbound | null {
    return this.outbound(conversationId);
  }

  private outbound(to: string): ChannelOutbound {
    const send = async (payload: Record<string, unknown>) =>
      (await this.graph(`${this.creds.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, ...payload }),
      })) as { messages?: Array<{ id: string }> };
    return {
      send: async (text) => {
        let id: string | null = null;
        for (const part of chunkText(text, MAX_TEXT)) {
          const res = await send({ type: 'text', text: { body: toWhatsApp(part), preview_url: false } });
          id = res.messages?.[0]?.id ?? null;
        }
        return id;
      },
      sendVoice: async (ogg) => {
        const form = new FormData();
        form.set('messaging_product', 'whatsapp');
        form.set('type', 'audio/ogg');
        form.set('file', new Blob([new Uint8Array(ogg)], { type: 'audio/ogg' }), 'reply.ogg');
        const media = (await this.graph(`${this.creds.phoneNumberId}/media`, { method: 'POST', body: form })) as { id: string };
        await send({ type: 'audio', audio: { id: media.id } });
      },
    };
  }

  private async download(mediaId: string): Promise<Buffer> {
    const meta = (await this.graph(mediaId, { method: 'GET' })) as { url?: string };
    if (!meta.url) throw new Error('WhatsApp returned no media URL');
    const res = await fetch(meta.url, { headers: { authorization: `Bearer ${this.creds.accessToken}` } });
    if (!res.ok) throw new Error(`Downloading the voice message failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async onWebhook(body: WaWebhook): Promise<void> {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        for (const msg of value?.messages ?? []) {
          const name = value?.contacts?.find((c) => c.wa_id === msg.from)?.profile?.name ?? msg.from;
          await this.onMessage(msg, name);
        }
      }
    }
  }

  private async onMessage(msg: WaMessage, name: string): Promise<void> {
    const out = this.outbound(msg.from);
    if (!this.hub.isAllowed('whatsapp', msg.from)) {
      const notice = this.hub.strangerNotice('whatsapp', msg.from);
      if (notice) await out.send(notice);
      return;
    }
    const user = { id: msg.from, name };
    const conversation = { id: msg.from, label: `WhatsApp with ${name}`, isDirect: true };
    if (msg.type === 'audio' && msg.audio) {
      if ((this.hub.channelSettings('whatsapp') as { voiceNotes?: boolean }).voiceNotes === false) {
        await out.send('Voice messages are turned off for WhatsApp (`channels.whatsapp.voiceNotes`).');
        return;
      }
      const ogg = await this.download(msg.audio.id);
      await this.hub.voiceNote({ channel: 'whatsapp', user, conversation }, ogg, out);
      return;
    }
    const text = msg.text?.body ?? '';
    const command = this.hub.addressed('whatsapp', text, { isDirect: true, mentioned: false });
    if (!command) return;
    await this.hub.handle({ channel: 'whatsapp', user, conversation, text: command.text }, out, this.capabilities, { explicit: command.explicit });
  }
}
