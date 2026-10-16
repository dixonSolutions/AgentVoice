/**
 * Telegram — the Bot API over plain HTTPS, long polling (no public URL, no SDK).
 *
 * Commands: `/status`, `/sessions` … (the bot's command menu), `@bot …` in a
 * group, anything in a DM, or the `!av` prefix. Voice messages in a DM (or a
 * reply to the bot in a group) are transcribed as turns and answered with a
 * voice message. Calls are not possible: Bot API bots cannot join or take
 * voice calls — that needs an MTProto *user* account (NTgCalls / pytgcalls),
 * whose Node bindings were dropped. See docs/44-channels.md.
 */

import { childLogger } from '../../log.js';
import { chunkText, toTelegramHtml } from '../format.js';
import { cleanCommandText } from '../text.js';
import type { ChannelHub, ChannelOutbound } from '../hub.js';
import type { ChannelAdapter, ChannelCapabilities, ChannelCommandInput, ChannelStatus } from '../types.js';

const log = childLogger('channels:telegram');

const MAX_TEXT = 4096;
const POLL_TIMEOUT_S = 50;

interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; first_name?: string };
  text?: string;
  caption?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  reply_to_message?: { from?: TgUser };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  mentions: { supported: true, note: '`@yourbot status`, or the command menu (`/status@yourbot`) in groups.' },
  directMessages: { supported: true, note: 'Anything you send the bot in a DM is a command.' },
  voiceCalls: {
    supported: false,
    note: 'Telegram bots cannot join or take calls — only user accounts over MTProto can (NTgCalls), and its Node bindings were dropped. Send a voice message instead.',
  },
  voiceNotes: { supported: true, note: 'Voice messages become turns; the agent answers with a voice message.' },
  liveStatus: { supported: true, note: '`watch` keeps editing one status message.' },
};

const BOT_COMMANDS = [
  ['status', 'Agent, project and who is listening'],
  ['sessions', 'Running and recent agent sessions'],
  ['use', 'Continue a session: /use 2'],
  ['default', 'Pin the session this chat talks to'],
  ['new', 'Start a fresh session'],
  ['project', 'Show or switch the active project'],
  ['say', 'Send a turn as text'],
  ['stop', 'Stop the voice agent'],
  ['config', 'Show or change a setting'],
  ['watch', 'Keep a live status message here'],
  ['whoami', 'Your Telegram id'],
  ['help', 'All commands'],
] as const;

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram' as const;
  readonly displayName = 'Telegram';
  readonly capabilities = TELEGRAM_CAPABILITIES;
  readonly tokenEnvVars = ['TELEGRAM_BOT_TOKEN'] as const;

  private state: ChannelStatus['state'] = 'off';
  private detail: string | undefined;
  private username = '';
  private botId = 0;
  private offset = 0;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly hub: ChannelHub,
    private readonly token: string,
    private readonly apiBase = 'https://api.telegram.org',
  ) {}

  status() {
    return { state: this.state, ...(this.detail ? { detail: this.detail } : {}), calls: 0 };
  }

  async start(): Promise<void> {
    this.state = 'connecting';
    this.abort = new AbortController();
    try {
      const me = (await this.api('getMe', {})) as TgUser;
      this.username = me.username ?? '';
      this.botId = me.id;
      await this.api('setMyCommands', { commands: BOT_COMMANDS.map(([command, description]) => ({ command, description })) }).catch(
        (err: unknown) => log.warn({ err }, 'setMyCommands failed'),
      );
      this.state = 'connected';
      this.detail = `@${this.username}`;
      log.info({ bot: this.username }, 'telegram connected');
    } catch (err) {
      this.state = 'error';
      this.detail = err instanceof Error ? err.message : String(err);
      throw err;
    }
    this.loop = this.poll();
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.loop?.catch(() => undefined);
    this.state = 'off';
  }

  private async api(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<unknown> {
    const isForm = body instanceof FormData;
    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: 'POST',
      ...(isForm ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? `HTTP ${res.status}`}`);
    return json.result;
  }

  private async poll(): Promise<void> {
    const signal = this.abort!.signal;
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const updates = (await this.api(
          'getUpdates',
          { offset: this.offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] },
          signal,
        )) as TgUpdate[];
        backoff = 1000;
        this.state = 'connected';
        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (update.message) {
            void this.onMessage(update.message).catch((err: unknown) => log.warn({ err }, 'telegram message handling failed'));
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        this.state = 'error';
        this.detail = err instanceof Error ? err.message : String(err);
        log.warn({ err: this.detail }, 'telegram poll failed — retrying');
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  /** Post into a conversation by id — the message channel, for session logs. */
  outboundFor(conversationId: string): ChannelOutbound | null {
    return this.outbound(Number(conversationId));
  }

  private outbound(chatId: number): ChannelOutbound {
    return {
      send: async (text) => {
        let last: string | null = null;
        for (const part of chunkText(text, MAX_TEXT - 200)) {
          const sent = (await this.api('sendMessage', {
            chat_id: chatId,
            text: toTelegramHtml(part),
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          })) as { message_id: number };
          last = String(sent.message_id);
        }
        return last;
      },
      edit: async (messageId, text) => {
        await this.api('editMessageText', {
          chat_id: chatId,
          message_id: Number(messageId),
          text: toTelegramHtml(text.slice(0, MAX_TEXT - 200)),
          parse_mode: 'HTML',
        });
      },
      sendVoice: async (ogg, seconds) => {
        const form = new FormData();
        form.set('chat_id', String(chatId));
        form.set('duration', String(Math.max(1, Math.round(seconds))));
        form.set('voice', new Blob([new Uint8Array(ogg)], { type: 'audio/ogg' }), 'reply.ogg');
        await this.api('sendVoice', form);
      },
    };
  }

  private async onMessage(msg: TgMessage): Promise<void> {
    if (!msg.from || msg.from.is_bot) return;
    const isDirect = msg.chat.type === 'private';
    const user = {
      id: String(msg.from.id),
      name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || String(msg.from.id),
    };
    const conversation = {
      id: String(msg.chat.id),
      label: isDirect ? `DM with ${user.name}` : (msg.chat.title ?? String(msg.chat.id)),
      isDirect,
    };
    const out = this.outbound(msg.chat.id);
    const repliedToBot = msg.reply_to_message?.from?.id === this.botId;

    if (msg.voice) {
      if (!isDirect && !repliedToBot && this.hub.channelSettings('telegram').requireMention) return;
      if (!this.hub.isAllowed('telegram', user.id)) {
        const notice = this.hub.strangerNotice('telegram', user.id);
        if (notice) await out.send(notice);
        return;
      }
      const settings = this.hub.channelSettings('telegram') as { voiceNotes?: boolean };
      if (settings.voiceNotes === false) {
        await out.send('Voice messages are turned off for Telegram (`channels.telegram.voiceNotes`).');
        return;
      }
      const ogg = await this.download(msg.voice.file_id);
      await this.hub.voiceNote({ channel: 'telegram', user, conversation }, ogg, out);
      return;
    }

    const raw = msg.text ?? '';
    if (!raw.trim()) return;
    const { text, mentioned } = this.normalize(raw, msg.entities ?? []);
    const command = this.hub.addressed('telegram', text, { isDirect, mentioned: mentioned || repliedToBot, conversationId: conversation.id });
    if (command === null) return;
    if (!this.hub.isAllowed('telegram', user.id)) {
      const notice = this.hub.strangerNotice('telegram', user.id);
      if (notice) await out.send(notice);
      return;
    }
    const input: ChannelCommandInput = { channel: 'telegram', user, conversation, text: command.text };
    await this.hub.handle(input, out, this.capabilities, {
      howToAddress: 'use the command menu (`/sessions`), tag me in a group, or DM me.',
      // A /command from the menu is a command even in a stream.
      explicit: command.explicit || raw.trimStart().startsWith('/'),
    });
  }

  /** `/status@bot args` → `status args`; strip a leading `@bot` mention. */
  normalize(text: string, entities: TgMessage['entities'] & object): { text: string; mentioned: boolean } {
    let mentioned = false;
    let t = text.trim();
    const bot = this.username.toLowerCase();
    const cmd = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?\b/i.exec(t);
    if (cmd) {
      if (cmd[2] && cmd[2].toLowerCase() !== bot) return { text: '', mentioned: false };
      return { text: `${cmd[1]}${t.slice(cmd[0].length)}`, mentioned: true };
    }
    for (const e of entities) {
      if (e.type !== 'mention') continue;
      const handle = text.slice(e.offset + 1, e.offset + e.length).toLowerCase();
      if (handle === bot) mentioned = true;
    }
    if (mentioned) t = cleanCommandText(t, [new RegExp(`@${this.username}\\b`, 'gi')]);
    return { text: cleanCommandText(t), mentioned };
  }

  private async download(fileId: string): Promise<Buffer> {
    const file = (await this.api('getFile', { file_id: fileId })) as { file_path?: string };
    if (!file.file_path) throw new Error('Telegram returned no file path for the voice message');
    const res = await fetch(`${this.apiBase}/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`Downloading the voice message failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
