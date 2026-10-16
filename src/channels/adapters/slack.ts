/**
 * Slack — Socket Mode over a WebSocket the bridge opens itself (no public
 * URL), the Web API over plain HTTPS. No SDK.
 *
 * Commands: `@Squeakr …` in a channel, anything in a DM with the app, or
 * the `/av` slash command. Slack has no API for an app to join a huddle or
 * hear its audio (only a user account driving the web client could), so there
 * are no calls here; `watch` keeps a status message updated. See docs/44.
 */

import { WebSocket } from 'ws';
import { childLogger } from '../../log.js';
import { chunkText, toSlackMrkdwn } from '../format.js';
import { cleanCommandText } from '../text.js';
import type { ChannelHub, ChannelOutbound } from '../hub.js';
import type { ChannelAdapter, ChannelCapabilities, ChannelStatus } from '../types.js';

const log = childLogger('channels:slack');

const MAX_TEXT = 3500;

export const SLACK_CAPABILITIES: ChannelCapabilities = {
  mentions: { supported: true, note: '`@Squeakr status` in a channel the app is in, or the `/av` slash command.' },
  directMessages: { supported: true, note: 'Anything in the app\'s DM is a command.' },
  voiceCalls: {
    supported: false,
    note: 'Slack has no API for an app to join a huddle or hear its audio — only a signed-in user client could, which Slack does not sanction.',
  },
  voiceNotes: {
    supported: false,
    note: 'Slack audio clips are AAC/WebM, which the bridge cannot decode without ffmpeg — not read yet.',
  },
  liveStatus: { supported: true, note: '`watch` keeps updating one message (chat.update).' },
};

interface SlackEvent {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
}

export class SlackAdapter implements ChannelAdapter {
  readonly id = 'slack' as const;
  readonly displayName = 'Slack';
  readonly capabilities = SLACK_CAPABILITIES;
  readonly tokenEnvVars = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const;

  private ws: WebSocket | null = null;
  private state: ChannelStatus['state'] = 'off';
  private detail: string | undefined;
  private botUserId = '';
  private stopped = false;
  private readonly names = new Map<string, string>();

  constructor(
    private readonly hub: ChannelHub,
    private readonly botToken: string,
    private readonly appToken: string,
    private readonly apiBase = 'https://slack.com/api',
  ) {}

  status() {
    return { state: this.state, ...(this.detail ? { detail: this.detail } : {}), calls: 0 };
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.state = 'connecting';
    const auth = (await this.api('auth.test', {}, this.botToken)) as { user_id: string; team?: string; user?: string };
    this.botUserId = auth.user_id;
    this.detail = `${auth.user ?? 'bot'} in ${auth.team ?? 'workspace'}`;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    this.state = 'off';
  }

  private async api(method: string, body: Record<string, unknown>, token = this.botToken): Promise<unknown> {
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!json.ok) throw new Error(`Slack ${method}: ${json.error ?? `HTTP ${res.status}`}`);
    return json;
  }

  private async connect(): Promise<void> {
    const open = (await this.api('apps.connections.open', {}, this.appToken)) as { url: string };
    const ws = new WebSocket(open.url);
    this.ws = ws;
    ws.on('message', (raw) => {
      let msg: { type?: string; envelope_id?: string; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return;
      }
      if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
      if (msg.type === 'hello') {
        this.state = 'connected';
        log.info({ bot: this.detail }, 'slack connected');
      } else if (msg.type === 'disconnect') {
        ws.close();
      } else if (msg.type === 'events_api') {
        const event = (msg.payload as { event?: SlackEvent } | undefined)?.event;
        if (event) void this.onEvent(event).catch((err: unknown) => log.warn({ err }, 'slack event failed'));
      } else if (msg.type === 'slash_commands') {
        const p = msg.payload as { text?: string; user_id?: string; user_name?: string; channel_id?: string; channel_name?: string };
        void this.onCommand(p.user_id ?? '', p.user_name ?? '', p.channel_id ?? '', p.channel_name === 'directmessage', p.text?.trim() || 'help').catch(
          (err: unknown) => log.warn({ err }, 'slack slash command failed'),
        );
      }
    });
    ws.on('close', () => {
      if (this.ws !== ws || this.stopped) return;
      this.state = 'connecting';
      // Slack rotates Socket Mode connections; open a fresh one.
      setTimeout(() => void this.connect().catch((err: unknown) => this.fail(err)), 1000);
    });
    ws.on('error', (err) => log.warn({ err }, 'slack socket error'));
  }

  private fail(err: unknown): void {
    this.state = 'error';
    this.detail = err instanceof Error ? err.message : String(err);
    log.warn({ err: this.detail }, 'slack reconnect failed — retrying');
    if (!this.stopped) setTimeout(() => void this.connect().catch((e: unknown) => this.fail(e)), 10_000);
  }

  /** Post into a conversation by id — the message channel, for session logs. */
  outboundFor(conversationId: string): ChannelOutbound | null {
    return this.outbound(conversationId);
  }

  private outbound(channel: string): ChannelOutbound {
    return {
      send: async (text) => {
        let ts: string | null = null;
        for (const part of chunkText(text, MAX_TEXT)) {
          const res = (await this.api('chat.postMessage', { channel, text: toSlackMrkdwn(part), mrkdwn: true })) as { ts: string };
          ts = res.ts;
        }
        return ts;
      },
      edit: async (ts, text) => {
        await this.api('chat.update', { channel, ts, text: toSlackMrkdwn(text.slice(0, MAX_TEXT)) });
      },
    };
  }

  private async onEvent(event: SlackEvent): Promise<void> {
    if (event.bot_id || event.subtype || !event.user || !event.channel) return;
    const isDirect = event.channel_type === 'im';
    // Channel messages arrive as app_mention — except in the message channel, where every message counts.
    if (event.type === 'message' && !isDirect && !this.hub.isMessageChannel('slack', event.channel)) return;
    if (event.type !== 'message' && event.type !== 'app_mention') return;
    const mention = `<@${this.botUserId}>`;
    const mentioned = event.type === 'app_mention' || (event.text ?? '').includes(mention);
    const text = cleanCommandText(event.text ?? '', [mention]);
    const command = this.hub.addressed('slack', text, { isDirect, mentioned, conversationId: event.channel });
    if (command === null) return;
    await this.onCommand(event.user, '', event.channel, isDirect, command.text, false, command.explicit);
  }

  /** `slash`: the /av command — always a command; a message may be text for the agent. */
  private async onCommand(
    userId: string,
    userName: string,
    channel: string,
    isDirect: boolean,
    text: string,
    slash = true,
    explicit = true,
  ): Promise<void> {
    const out = this.outbound(channel);
    if (!this.hub.isAllowed('slack', userId)) {
      const notice = this.hub.strangerNotice('slack', userId);
      if (notice) await out.send(notice);
      return;
    }
    const name = userName || (await this.nameOf(userId));
    await this.hub[slash ? 'command' : 'handle'](
      {
        channel: 'slack',
        user: { id: userId, name },
        conversation: { id: channel, label: isDirect ? `DM with ${name}` : channel, isDirect },
        text: cleanCommandText(text),
      },
      out,
      this.capabilities,
      { howToAddress: 'tag me (`@Squeakr sessions`), use `/av sessions`, or DM me.', explicit },
    );
  }

  private async nameOf(userId: string): Promise<string> {
    const known = this.names.get(userId);
    if (known) return known;
    try {
      const info = (await this.api('users.info', { user: userId })) as { user?: { real_name?: string; name?: string } };
      const name = info.user?.real_name || info.user?.name || userId;
      this.names.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }
}
