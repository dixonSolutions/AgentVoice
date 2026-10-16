/**
 * Discord — the one platform where a bot can take a real voice call.
 *
 * Commands: the `/av` slash command, `@Squeakr …` in a server channel, or
 * anything in a DM. No privileged intent is needed for those; reading the
 * `!av` prefix in servers needs Message Content enabled in the developer
 * portal. Voice: `join` brings the bot into the voice channel you are in and
 * the call continues this conversation's default session (`default <n>`);
 * what is said is mirrored into the text channel. See docs/44-channels.md.
 *
 * discord.js and @discordjs/voice are optional dependencies, loaded here only.
 */

import type * as DiscordNs from 'discord.js';
import type { ChatInputCommandInteraction, Client, Guild, GuildMember, Message, VoiceBasedChannel } from 'discord.js';
import type * as VoiceNs from '@discordjs/voice';
import { readFileSync } from 'node:fs';
import { childLogger } from '../../log.js';
import { appIconPath } from '../packageRoot.js';
import type { ChannelAttachment, OutboundFile } from '../attachments.js';
import { chunkText } from '../format.js';
import { voiceDefaultKey } from '../../control/sessions.js';
import { cleanCommandText } from '../text.js';
import type { ChannelHub, ChannelOutbound } from '../hub.js';
import { VoiceCall } from '../voiceCall.js';
import { howToTalk } from '../callTurns.js';
import type { ChannelAdapter, ChannelCapabilities, ChannelCommandInput, ChannelStatus, ChannelVoiceAction } from '../types.js';
import { DiscordCall } from './discordVoice.js';

const log = childLogger('channels:discord');

const MAX_TEXT = 2000;
const HOW_TO_ADDRESS =
  'tag me (`@Squeakr sessions`), use `/av sessions`, DM me, or write in my message channel (`channel here` sets it). `chat <message>` talks to the agent; `stream on` keeps talking.';
/** Every private voice room starts with this, so it is recognised after a restart too. */
const ROOM_PREFIX = '🎙️ Squeakr · ';
/**
 * What the invite asks for: View Channels, Send Messages, Read Message History,
 * Connect, Speak — plus Manage Channels and Manage Roles, to make each user's
 * private voice room (`call`) and keep everyone else out of it.
 */
export const DISCORD_INVITE_PERMISSIONS = 1024 + 2048 + 65536 + 1048576 + 2097152 + 16 + 268435456;

type DiscordJs = typeof DiscordNs;
type SentMessage = { id: string; edit(content: string): Promise<unknown> };
type SendableChannel = {
  send(content: string | { content?: string; files?: unknown[]; flags?: number }): Promise<SentMessage>;
};

export const DISCORD_CAPABILITIES: ChannelCapabilities = {
  mentions: { supported: true, note: '`@Squeakr status`, or the `/av` slash command.' },
  directMessages: { supported: true, note: 'Anything you DM the bot is a command.' },
  voiceCalls: {
    supported: true,
    note:
      '`call` (from a DM too) opens your private voice room — only you and the bot — and the bot picks up when you walk in; `join` calls in the voice channel you are in. Bots cannot join DM calls, so the private room is the DM call. End-to-end encrypted calls included.',
  },
  voiceNotes: {
    supported: true,
    note: 'Voice messages are transcribed as turns; with `stream on --rep=voice` the agent answers with voice messages.',
  },
  liveStatus: { supported: true, note: '`watch` keeps editing one status message.' },
};

export class DiscordAdapter implements ChannelAdapter {
  readonly id = 'discord' as const;
  readonly displayName = 'Discord';
  readonly capabilities = DISCORD_CAPABILITIES;
  readonly tokenEnvVars = ['DISCORD_BOT_TOKEN'] as const;

  private client: Client | null = null;
  private state: ChannelStatus['state'] = 'off';
  private detail: string | undefined;
  private readonly calls = new Map<string, DiscordCall>();
  private d: DiscordJs | null = null;
  /** Private voice room id → the user it belongs to. */
  private readonly rooms = new Map<string, string>();
  /** Where to talk when the owner walks into their room: the DM `call` was typed in. */
  private readonly pendingCalls = new Map<string, { out: ChannelOutbound; input: ChannelCommandInput }>();

  constructor(
    private readonly hub: ChannelHub,
    private readonly token: string,
  ) {}

  status() {
    return { state: this.state, ...(this.detail ? { detail: this.detail } : {}), calls: this.calls.size };
  }

  async start(): Promise<void> {
    this.state = 'connecting';
    let d: DiscordJs;
    try {
      d = await import('discord.js');
    } catch {
      this.state = 'error';
      this.detail = 'discord.js is not installed — run: npm install discord.js @discordjs/voice opusscript';
      throw new Error(this.detail);
    }
    // Untagged messages in a server channel (the message channel, the `!av`
    // prefix) carry no text without Message Content — a privileged intent,
    // switched on in the developer portal. Ask for it; without it, connect
    // anyway and say what is missing.
    try {
      await this.connect(d, true);
    } catch (err) {
      if (!/disallowed intents/i.test(err instanceof Error ? err.message : String(err))) throw err;
      log.warn('Message Content intent is off in the developer portal — untagged messages in the message channel cannot be read');
      await this.connect(d, false);
      this.contentWithheld = true;
    }
  }

  /** Untagged server messages arrive without text (Message Content intent off in the portal). */
  private contentWithheld = false;

  private async connect(d: DiscordJs, readContent: boolean): Promise<void> {
    this.state = 'connecting';
    const client = new d.Client({
      intents: [
        d.GatewayIntentBits.Guilds,
        d.GatewayIntentBits.GuildVoiceStates,
        d.GatewayIntentBits.GuildMessages,
        d.GatewayIntentBits.DirectMessages,
        ...(readContent ? [d.GatewayIntentBits.MessageContent] : []),
      ],
      partials: [d.Partials.Channel],
    });
    this.client = client;
    this.d = d;

    client.once(d.Events.ClientReady, async (ready) => {
      this.state = 'connected';
      this.detail = this.contentWithheld
        ? `${ready.user.tag} — Message Content intent off: untagged messages in the message channel cannot be read (developer portal → Bot → Privileged Gateway Intents)`
        : ready.user.tag;
      log.info({ bot: ready.user.tag, guilds: ready.guilds.cache.size }, 'discord connected');
      try {
        await ready.application.commands.set([
          new d.SlashCommandBuilder()
            .setName('av')
            .setDescription('Squeakr: status, sessions, use, default, join, leave, say …')
            .addStringOption((o) => o.setName('command').setDescription('e.g. "sessions", "default 2", "join"').setRequired(false))
            .toJSON(),
        ]);
      } catch (err) {
        log.warn({ err }, 'registering the /av slash command failed');
      }
      await this.brand(ready).catch((err: unknown) => log.warn({ err }, 'setting the Squeakr avatar failed'));
      await this.welcomeDms(ready).catch((err: unknown) => log.warn({ err }, 'sending welcome DMs failed'));
      await this.pickUpWaiting(ready).catch((err: unknown) => log.warn({ err }, 'picking up waiting callers failed'));
    });
    client.on(d.Events.MessageCreate, (message) => {
      void this.onMessage(d, message).catch((err: unknown) => log.warn({ err }, 'discord message handling failed'));
    });
    client.on(d.Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== 'av') return;
      void this.onSlash(interaction).catch((err: unknown) => log.warn({ err }, 'discord slash command failed'));
    });
    client.on(d.Events.VoiceStateUpdate, (before, after) => {
      // Leave when the last allowlisted human walks out.
      const call = before.channelId ? this.calls.get(before.guild.id) : undefined;
      if (call && call.channelId === before.channelId && before.channel && before.channelId !== after.channelId) {
        const humans = before.channel.members.filter((m) => !m.user.bot && this.hub.isAllowed('discord', m.id));
        if (humans.size === 0) void call.leave();
      }
      // "Calling" the bot: an allowlisted member steps into a voice channel.
      const member = after.member;
      if (!after.channelId || after.channelId === before.channelId || !member || member.user.bot) return;
      // The configured voice channel and their private room always ring, auto-join or not.
      if (after.channel && this.rings(after.channel, member.id) && this.hub.isAllowed('discord', member.id)) {
        if (this.calls.get(after.guild.id)?.channelId === after.channelId) return;
        const pending = this.pendingCalls.get(after.channelId);
        this.pendingCalls.delete(after.channelId);
        const chat = after.channel as unknown as SendableChannel;
        const out = pending?.out ?? this.messageChannelOut() ?? this.outbound(chat);
        const input = pending?.input ?? this.inputOf(member.id, member.displayName, after.channelId, false, after.channel, 'call');
        void this.voiceAction('join', member, after.guild.id, out, input).catch((err: unknown) =>
          log.warn({ err }, 'joining the private room failed'),
        );
        return;
      }
      if (!(this.hub.channelSettings('discord') as { autoJoin?: boolean }).autoJoin) return;
      if (!this.hub.isAllowed('discord', member.id) || this.calls.has(after.guild.id)) return;
      const chat = after.channel as unknown as SendableChannel | null;
      const out = chat && 'send' in (chat as object) ? this.outbound(chat) : { send: async () => null };
      const input = this.inputOf(member.id, member.displayName, after.channelId, false, after.channel, 'join');
      void this.voiceAction('join', member, after.guild.id, out, input).catch((err: unknown) =>
        log.warn({ err }, 'auto-join failed'),
      );
    });
    client.on(d.Events.Error, (err) => {
      this.detail = err.message;
      log.warn({ err }, 'discord client error');
    });

    try {
      await client.login(this.token);
    } catch (err) {
      this.state = 'error';
      this.detail = err instanceof Error ? err.message : String(err);
      await client.destroy().catch(() => undefined);
      throw err;
    }
  }

  async stop(): Promise<void> {
    await Promise.all([...this.calls.values()].map((c) => c.leave()));
    await this.client?.destroy();
    this.client = null;
    this.state = 'off';
  }

  /**
   * The Squeakr logo as the bot's avatar and the application's icon — only
   * while they are still Discord's defaults, so a custom picture is never
   * replaced (and Discord's avatar rate limit never hit on every restart).
   */
  private async brand(ready: Client<true>): Promise<void> {
    const icon = appIconPath();
    if (!icon) return;
    const png = readFileSync(icon);
    if (!ready.user.avatar) {
      await ready.user.setAvatar(png);
      log.info('bot avatar set to the Squeakr logo');
    }
    const app = await ready.application.fetch();
    if (!app.icon) {
      await app.edit({ icon: png });
      log.info('application icon set to the Squeakr logo');
    }
  }

  /**
   * A DM with each allowlisted member, opened by the bot with a welcome the
   * first time — so "Squeakr" sits in their Direct Messages, where commands
   * need no tag. Never repeated once the DM has any message in it.
   */
  private async welcomeDms(ready: Client<true>): Promise<void> {
    const settings = this.hub.channelSettings('discord') as { welcomeDm?: boolean };
    if (settings.welcomeDm === false) return;
    for (const id of this.hub.channelSettings('discord').allowUsers) {
      try {
        const user = await ready.users.fetch(id);
        const dm = await user.createDM();
        const last = await dm.messages.fetch({ limit: 1 });
        if (last.size > 0) continue;
        await dm.send(
          [
            `👋 **Squeakr** — this DM is yours. Commands need no tag here: try \`help\`, \`sessions\`, \`status\`.`,
            `Talk to the agent with \`chat <message>\` (attach images, video or a voice message), or \`stream on --voice --rep=voice\` to swap voice notes until \`stream break\`. For a call, send \`call\` — I pick up in the voice channel set for me (\`voice here\`), or a private room for just us two.`,
            `Calls listen the way the app does (Voice settings): ${howToTalk(VoiceCall.turnSettings()) || 'everything you say is a request.'}`,
          ].join('\n'),
        );
        log.info({ user: id }, 'welcome DM sent');
      } catch (err) {
        log.warn({ err, user: id }, 'could not open a DM with an allowlisted member');
      }
    }
  }

  /**
   * Someone already sitting in the configured voice channel or their private
   * room when the bridge starts (it restarted mid-call) is a call waiting —
   * pick it up.
   */
  private async pickUpWaiting(ready: Client<true>): Promise<void> {
    for (const guild of ready.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        if (!channel.isVoiceBased() || this.calls.has(guild.id)) continue;
        const member = channel.members.find((m) => !m.user.bot && this.hub.isAllowed('discord', m.id) && this.rings(channel, m.id));
        if (!member) continue;
        const input = this.inputOf(member.id, member.displayName, channel.id, false, channel, 'call');
        await this.voiceAction('join', member, guild.id, this.messageChannelOut() ?? this.outbound(channel as unknown as SendableChannel), input);
      }
    }
  }

  /** Does walking into this room call the bot? The configured voice channel, or the member's private room. */
  private rings(channel: VoiceBasedChannel, memberId: string): boolean {
    return channel.id === this.hub.channelSettings('discord').voiceChannel || this.roomOwner(channel) === memberId;
  }

  /** Post into a conversation by id (the message channel, for session logs). */
  outboundFor(conversationId: string): ChannelOutbound | null {
    const channel = this.client?.channels.cache.get(conversationId);
    return channel && 'send' in channel ? this.outbound(channel as unknown as SendableChannel) : null;
  }

  /** The configured message channel, when set and reachable — where calls are written up. */
  private messageChannelOut(): ChannelOutbound | null {
    const id = this.hub.channelSettings('discord').messageChannel;
    return id ? this.outboundFor(id) : null;
  }

  private outbound(channel: SendableChannel): ChannelOutbound {
    const sent = new Map<string, { edit(content: string): Promise<unknown> }>();
    return {
      send: async (text) => {
        let last: string | null = null;
        for (const part of chunkText(text, MAX_TEXT)) {
          const msg = await channel.send(part);
          sent.set(msg.id, msg);
          last = msg.id;
        }
        return last;
      },
      edit: async (id, text) => {
        await sent.get(id)?.edit(text.slice(0, MAX_TEXT));
      },
      // A real Discord voice message: the voice-message flag, duration and waveform.
      sendVoice: async (ogg, seconds, waveform) => {
        const d = this.d!;
        const file = new d.AttachmentBuilder(ogg, { name: 'voice-message.ogg' })
          .setDuration(Math.max(1, Math.round(seconds)))
          .setWaveform(waveform ?? Buffer.alloc(64, 24).toString('base64'));
        try {
          await channel.send({ files: [file], flags: d.MessageFlags.IsVoiceMessage });
        } catch (err) {
          // Some channels refuse voice messages (permissions): post it as an audio file.
          log.debug({ err }, 'voice message refused — sending the audio as a file');
          await channel.send({ files: [new d.AttachmentBuilder(ogg, { name: 'reply.ogg' })] });
        }
      },
      sendFiles: async (files: OutboundFile[], caption?: string) => {
        const d = this.d!;
        // Ten files per message, as Discord allows.
        for (let i = 0; i < files.length; i += 10) {
          const batch = files.slice(i, i + 10);
          const text = [i === 0 ? caption : undefined, ...batch.map((f) => f.caption)].filter(Boolean).join('\n').slice(0, MAX_TEXT);
          await channel.send({
            ...(text ? { content: text } : {}),
            files: batch.map((f) => new d.AttachmentBuilder(f.data, { name: f.name })),
          });
        }
      },
    };
  }

  /** A message's attachments, for the attachment bridge (downloaded only if it becomes a turn). */
  private attachmentsOf(d: DiscordJs, message: Message): ChannelAttachment[] {
    const voiceMessage = message.flags.has(d.MessageFlags.IsVoiceMessage);
    return [...message.attachments.values()].map((a) => ({
      name: a.name,
      contentType: a.contentType,
      size: a.size,
      voice: voiceMessage || (a.waveform !== null && (a.contentType ?? '').startsWith('audio/')),
      fetch: async () => {
        const res = await fetch(a.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      },
    }));
  }

  private async onMessage(d: DiscordJs, message: Message): Promise<void> {
    if (message.author.bot || !this.client?.user) return;
    const isDirect = message.channel.type === d.ChannelType.DM;
    const me = this.client.user.id;
    // Tagging a bot in a server often inserts its managed *role* instead of the user.
    const botRole = message.guild?.members.me?.roles.botRole?.id ?? null;
    const mentioned = message.mentions.users.has(me) || (botRole !== null && message.mentions.roles.has(botRole));
    const tags: RegExp[] = [new RegExp(`<@!?${me}>`, 'g')];
    if (botRole) tags.push(new RegExp(`<@&${botRole}>`, 'g'));
    const attachments = this.attachmentsOf(d, message);
    // No text, no file and no tag: content withheld (no Message Content intent) — nothing to act on.
    if (!message.content.trim() && !attachments.length && !isDirect && !mentioned) return;
    const text = cleanCommandText(message.content, tags);
    const command = this.hub.addressed('discord', text, { isDirect, mentioned, conversationId: message.channelId });
    if (command === null) return;
    if (!('send' in message.channel)) return;
    const out = this.outbound(message.channel as unknown as SendableChannel);
    if (!this.hub.isAllowed('discord', message.author.id)) {
      const notice = this.hub.strangerNotice('discord', message.author.id);
      if (notice) await message.reply(notice);
      return;
    }
    const input = {
      ...this.inputOf(message.author.id, message.member?.displayName ?? message.author.username, message.channelId, isDirect, message.channel, command.text),
      attachments,
    };
    const result = await this.hub.handle(input, out, this.capabilities, { howToAddress: HOW_TO_ADDRESS, explicit: command.explicit });
    if (result.voice) await this.voiceAction(result.voice.action, message.member ?? null, message.guildId, out, input);
  }

  private async onSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    const text = cleanCommandText(interaction.options.getString('command') ?? 'help');
    if (!this.hub.isAllowed('discord', interaction.user.id)) {
      await interaction.reply({
        content: this.hub.strangerNotice('discord', interaction.user.id) ?? 'Not on the allowlist.',
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply();
    let first = true;
    const channel = interaction.channel as unknown as SendableChannel | null;
    const fallback = channel ? this.outbound(channel) : null;
    // The slash reply is the first message; later ones (relayed replies) go to the channel.
    const out: ChannelOutbound = {
      send: async (content) => {
        if (first) {
          first = false;
          const msg = await interaction.editReply(content.slice(0, MAX_TEXT) || '✓');
          return msg.id;
        }
        return fallback ? fallback.send(content) : (await interaction.followUp(content.slice(0, MAX_TEXT))).id;
      },
      edit: async (id, content) => {
        await interaction.webhook.editMessage(id, content.slice(0, MAX_TEXT)).catch(() => undefined);
      },
    };
    const isDirect = !interaction.guildId;
    const member = (interaction.member as GuildMember | null) ?? null;
    const input = this.inputOf(interaction.user.id, member?.displayName ?? interaction.user.username, interaction.channelId, isDirect, interaction.channel, text);
    const result = await this.hub.command(input, out, this.capabilities, { howToAddress: HOW_TO_ADDRESS });
    if (first) await interaction.editReply('✓');
    if (result.voice) await this.voiceAction(result.voice.action, member, interaction.guildId, out, input);
  }

  /**
   * What the agent is doing during a call, as one message in the text channel
   * that keeps being edited (the last few tool calls and status changes) —
   * a running log, not a stream of posts.
   */
  private activityLog(out: ChannelOutbound): { push(line: string): void; close(): void } {
    const lines: string[] = [];
    let messageId: string | null = null;
    let posting: Promise<void> | null = null;
    let timer: NodeJS.Timeout | null = null;
    const render = () => `📋 **Agent activity**\n${lines.slice(-12).join('\n')}`;
    const flush = () => {
      timer = null;
      if (posting) {
        timer = setTimeout(flush, 500);
        return;
      }
      posting = (messageId && out.edit ? out.edit(messageId, render()) : out.send(render()).then((id) => void (messageId = id)))
        .catch((err: unknown) => log.debug({ err }, 'activity log update failed'))
        .finally(() => {
          posting = null;
        });
    };
    return {
      push: (line) => {
        lines.push(`\`${new Date().toLocaleTimeString([], { hour12: false })}\` ${line}`);
        timer ??= setTimeout(flush, 1500);
      },
      close: () => {
        if (timer) {
          clearTimeout(timer);
          flush();
        }
      },
    };
  }

  private inputOf(userId: string, userName: string, channelId: string, isDirect: boolean, channel: unknown, text: string): ChannelCommandInput {
    const name = (channel as { name?: string } | null)?.name;
    return {
      channel: 'discord',
      user: { id: userId, name: userName },
      conversation: { id: channelId, label: isDirect ? `DM with ${userName}` : `#${name ?? channelId}`, isDirect },
      text,
    };
  }

  /** The user a private voice room belongs to, or null for any other channel. */
  private roomOwner(channel: VoiceBasedChannel): string | null {
    const known = this.rooms.get(channel.id);
    if (known) return known;
    // Rooms made before the Squeakr rename carry the old prefix.
    if (!(channel.name.startsWith(ROOM_PREFIX) || channel.name.startsWith('🎙️ AgentVoice · ')) || !this.d) return null;
    const viewChannel = this.d.PermissionFlagsBits.ViewChannel;
    const owner = channel.permissionOverwrites.cache.find(
      (o) => o.type === this.d!.OverwriteType.Member && o.id !== this.client?.user?.id && o.allow.has(viewChannel),
    );
    if (owner) this.rooms.set(channel.id, owner.id);
    return owner?.id ?? null;
  }

  /** The server to put the private room in: where `call` was typed, else the first one we share. */
  private async sharedGuild(userId: string, guildId: string | null): Promise<{ guild: Guild; member: GuildMember } | null> {
    const guilds = [...(this.client?.guilds.cache.values() ?? [])];
    if (guildId) guilds.sort((a, b) => Number(b.id === guildId) - Number(a.id === guildId));
    for (const guild of guilds) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) return { guild, member };
    }
    return null;
  }

  /** Find or make the user's private voice room: hidden from everyone but them and the bot. */
  private async privateRoom(guild: Guild, member: GuildMember): Promise<VoiceBasedChannel> {
    const d = this.d!;
    const existing = guild.channels.cache.find(
      (c): c is VoiceBasedChannel => c.type === d.ChannelType.GuildVoice && this.roomOwner(c as VoiceBasedChannel) === member.id,
    );
    if (existing) return existing;
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const talk = [d.PermissionFlagsBits.ViewChannel, d.PermissionFlagsBits.Connect, d.PermissionFlagsBits.Speak];
    const room = await guild.channels.create({
      name: `${ROOM_PREFIX}${member.displayName}`.slice(0, 100),
      type: d.ChannelType.GuildVoice,
      reason: `Squeakr private call for ${member.user.tag}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [d.PermissionFlagsBits.ViewChannel] },
        { id: member.id, type: d.OverwriteType.Member, allow: talk },
        { id: me.id, type: d.OverwriteType.Member, allow: [...talk, d.PermissionFlagsBits.SendMessages] },
      ],
    });
    this.rooms.set(room.id, member.id);
    log.info({ guild: guild.id, room: room.id, user: member.id }, 'private voice room created');
    return room;
  }

  /**
   * `call` — Discord does not let bots into DM calls, so the DM call is a
   * private voice room in a server we share. The bot picks up when the user
   * walks in, and mirrors the call into the conversation `call` came from.
   */
  private async privateCall(userId: string, guildId: string | null, out: ChannelOutbound, input: ChannelCommandInput): Promise<void> {
    const shared = await this.sharedGuild(userId, guildId);
    if (!shared) {
      await out.send(`We share no server yet, and calls need one — invite me: ${this.inviteUrl()}`);
      return;
    }
    const { guild, member } = shared;
    let room: VoiceBasedChannel;
    try {
      room = await this.privateRoom(guild, member);
    } catch (err) {
      log.warn({ err, guild: guild.id }, 'private voice room failed');
      await out.send(
        `⚠️ I could not open your private voice room in **${guild.name}** (${err instanceof Error ? err.message : String(err)}). ` +
          `I need **Manage Channels** and **Manage Roles** there — re-invite me: ${this.inviteUrl()}`,
      );
      return;
    }
    if (member.voice.channelId === room.id) {
      await this.voiceAction('join', member, guild.id, out, input);
      return;
    }
    this.pendingCalls.set(room.id, { out, input });
    await out.send(
      `📞 Your private voice room is ready — only you and me can see it: https://discord.com/channels/${guild.id}/${room.id}\n` +
        `Walk in and I pick up. \`hangup\` ends the call.`,
    );
  }

  private inviteUrl(): string {
    const id = this.client?.application?.id ?? this.client?.user?.id ?? '';
    return `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot%20applications.commands&permissions=${DISCORD_INVITE_PERMISSIONS}`;
  }

  /** The call to hang up from a DM: the one in this user's private room, else the one they are in. */
  private async callOf(userId: string): Promise<DiscordCall | null> {
    for (const call of this.calls.values()) if (this.rooms.get(call.channelId) === userId) return call;
    for (const [guildId, call] of this.calls) {
      const member = await this.client?.guilds.cache.get(guildId)?.members.fetch(userId).catch(() => null);
      if (member?.voice.channelId === call.channelId) return call;
    }
    return null;
  }

  /** `voice here`: the voice channel the member is in becomes the one calls use. */
  private async setVoiceChannel(member: GuildMember | null, out: ChannelOutbound): Promise<void> {
    const room = member?.voice.channel;
    if (!room) {
      await out.send('Step into the voice channel calls should use, then `voice here` again.');
      return;
    }
    const res = await this.hub.runCli(['channel', 'set', 'discord', 'voiceChannel', room.id]);
    await out.send(res.ok ? `🎙️ Calls now happen in **${room.name}** — walk in and I pick up; \`call\` points you there.` : `⚠️ ${res.output}`);
    if (res.ok && !this.calls.has(room.guild.id)) await this.voiceAction('join', member, room.guild.id, out, this.inputOf(member.id, member.displayName, room.id, false, room, 'call'));
  }

  /** `call` with a voice channel configured: join the caller there, or point them to it. */
  private async configuredCall(roomId: string, userId: string, out: ChannelOutbound, input: ChannelCommandInput): Promise<boolean> {
    const room = await this.client?.channels.fetch(roomId).catch(() => null);
    if (!room || !room.isVoiceBased()) return false;
    const member = await room.guild.members.fetch(userId).catch(() => null);
    if (!member) return false;
    if (member.voice.channelId === room.id) {
      await this.voiceAction('join', member, room.guild.id, out, input);
      return true;
    }
    this.pendingCalls.set(room.id, { out, input });
    await out.send(`📞 Calls happen in **${room.name}**: https://discord.com/channels/${room.guild.id}/${room.id}\nWalk in and I pick up. \`hangup\` ends the call.`);
    return true;
  }

  private async voiceAction(
    action: ChannelVoiceAction,
    member: GuildMember | null,
    guildId: string | null,
    out: ChannelOutbound,
    input: ChannelCommandInput,
  ): Promise<void> {
    if (action === 'here') {
      await this.setVoiceChannel(member, out);
      return;
    }
    if (action === 'call') {
      const configured = this.hub.channelSettings('discord').voiceChannel;
      if (configured && (await this.configuredCall(configured, input.user.id, out, input))) return;
      await this.privateCall(input.user.id, guildId, out, input);
      return;
    }
    if (action === 'leave' && !guildId) {
      const call = await this.callOf(input.user.id);
      if (!call) await out.send('We are not in a call.');
      else {
        await call.leave();
        await out.send('👋 Hung up.');
      }
      return;
    }
    if (!guildId || !member) {
      await out.send('Voice calls happen in a server voice channel — send `call` for a private one.');
      return;
    }
    const existing = this.calls.get(guildId);
    if (action === 'leave') {
      if (!existing) await out.send('I am not in a call here.');
      else {
        await existing.leave();
        await out.send('👋 Left the call.');
      }
      return;
    }
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      await out.send('Join a voice channel first, then `join` again — or send `call` for a private room.');
      return;
    }
    if (existing?.channelId === voiceChannel.id) {
      await out.send(`Already in **${voiceChannel.name}**.`);
      return;
    }
    const unavailable = VoiceCall.unavailableReason();
    if (unavailable) {
      await out.send(`⚠️ ${unavailable}`);
      return;
    }
    if (!(this.hub.channelSettings('discord') as { voice?: boolean }).voice) {
      await out.send('Voice calls are turned off for Discord (`channels.discord.voice`).');
      return;
    }
    let voice: typeof VoiceNs;
    try {
      voice = await import('@discordjs/voice');
    } catch {
      await out.send('⚠️ @discordjs/voice is not installed on the host — `npm install @discordjs/voice opusscript`.');
      return;
    }
    await existing?.leave();
    // Which session the call continues: the voice channel's own `default`,
    // else the caller's `voice default`, else the `default` of where `join` was typed.
    const pinned =
      this.hub.useBinding('discord', voiceChannel.id) ??
      this.hub.useBinding('discord', voiceDefaultKey(member.id)) ??
      (input.conversation.id !== voiceChannel.id ? this.hub.useBinding('discord', input.conversation.id) : null);
    const guild = member.guild;
    // The phone's voice settings decide when speech is a request (callTurns.ts).
    const how = howToTalk(VoiceCall.turnSettings());
    const greeting = `Squeakr here. ${pinned ? `Continuing ${pinned}.` : 'Go ahead.'}${how ? ` ${how}` : ''}`;
    // What is said, and what the agent does, is written up in the message channel when there is one.
    const messageChannel = this.messageChannelOut();
    const lines = messageChannel ?? out;
    const agentLinesElsewhere = Boolean(messageChannel) && this.hub.channelSettings('discord').logs;
    const activity = this.activityLog(lines);
    const call = new DiscordCall({
      voice,
      guildId,
      channelId: voiceChannel.id,
      channelName: voiceChannel.name,
      adapterCreator: guild.voiceAdapterCreator as never,
      isAllowed: (id) => this.hub.isAllowed('discord', id),
      nameOf: (id) => guild.members.cache.get(id)?.displayName ?? id,
      onLine: (line) => {
        // The agent's lines already reach the message channel (session logs, or as a listener there).
        if (line.who === 'agent' && agentLinesElsewhere) return;
        void lines.send(line.who === 'user' ? `🎙️ **${line.speaker}**: ${line.text}` : line.text).catch(() => undefined);
      },
      onNotice: (text) => void lines.send(`⚠️ ${text}`).catch(() => undefined),
      onActivity: activity.push,
      greeting,
      onEnded: (reason) => {
        activity.close();
        unregister();
        if (this.calls.get(guildId) === call) this.calls.delete(guildId);
        void lines.send(reason ? `📴 **Stream broken** — ${reason}` : `📴 Call in **${voiceChannel.name}** ended.`).catch(() => undefined);
      },
    });
    let unregister = () => undefined as void;
    try {
      await call.join();
    } catch (err) {
      await out.send(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.calls.set(guildId, call);
    unregister = this.hub.registerCall({ channel: 'discord', label: voiceChannel.name, userId: member.id, stop: () => call.leave() });
    await out.send(
      `🔊 In **${voiceChannel.name}** — talk to me.${pinned ? ` Continuing **${pinned}**.` : ''}` +
        `${how ? ` ${how}` : ''} \`hangup\` ends it.`,
    );
  }
}
