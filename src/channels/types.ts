/**
 * Channels — Discord, Telegram, Slack, WhatsApp as a way to reach the bridge
 * (docs/44-channels.md).
 *
 * A channel is an adapter that turns one platform's events into the same
 * three things: a command addressed to Squeaky (a mention, a DM, a slash
 * command), a voice call, or a voice note. Everything after that is shared —
 * the command line (commands.ts), the per-conversation default session
 * (bindings.ts), the voice-call engine (voiceCall.ts).
 *
 * Every adapter declares every capability: `true` when it implements it, or
 * `false` with the reason the platform does not allow it. Nothing is assumed.
 */

import type { ChannelOutbound } from './hub.js';

export type ChannelId = 'discord' | 'telegram' | 'slack' | 'whatsapp';

export const CHANNEL_IDS: readonly ChannelId[] = ['discord', 'telegram', 'slack', 'whatsapp'];

export interface ChannelCapability {
  supported: boolean;
  /** How it works, or why the platform does not allow it. */
  note: string;
}

export interface ChannelCapabilities {
  /** `@Squeaky …` in a group / server channel. */
  mentions: ChannelCapability;
  /** Direct messages to the bot. */
  directMessages: ChannelCapability;
  /** Real-time voice: the bot joins a call and talks. */
  voiceCalls: ChannelCapability;
  /** Voice messages: transcribed as a turn, replies spoken back as a voice message. */
  voiceNotes: ChannelCapability;
  /** A status message the bot keeps editing (sessions, agent state). */
  liveStatus: ChannelCapability;
}

/** Who sent a command, as the platform identifies them. */
export interface ChannelUser {
  id: string;
  name: string;
}

/** Where a reply goes, and what the default session is keyed on. */
export interface ChannelConversation {
  /** Platform id of the channel / chat / DM. */
  id: string;
  /** "#general", "DM with Ana" — for status lines and logs. */
  label: string;
  isDirect: boolean;
}

/** A message the adapter decided is addressed to Squeaky, mention stripped. */
export interface ChannelCommandInput {
  channel: ChannelId;
  user: ChannelUser;
  conversation: ChannelConversation;
  text: string;
}

/**
 * What a call command asks the adapter for: `call` (the configured voice
 * channel, else the user's private room), `join` (the room the user is in),
 * `leave`, `here` (the room the user is in becomes the configured one).
 */
export type ChannelVoiceAction = 'join' | 'leave' | 'call' | 'here';

/** What a command answers. Adapters render `text` as plain or markdown text. */
export interface ChannelReply {
  text: string;
  /** Ask the adapter to start / stop a voice call for this user. */
  voice?: { action: ChannelVoiceAction };
}

export interface ChannelStatus {
  id: ChannelId;
  displayName: string;
  enabled: boolean;
  /** Token present and the adapter is connected. */
  state: 'off' | 'missing_token' | 'connecting' | 'connected' | 'error';
  detail?: string;
  capabilities: ChannelCapabilities;
  /** Active voice calls on this channel. */
  calls: number;
}

export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly displayName: string;
  readonly capabilities: ChannelCapabilities;
  /** Environment variables holding the credentials. */
  readonly tokenEnvVars: readonly string[];
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * A way to post into one of its conversations by id (the message channel,
   * for session logs), or null when it cannot reach it.
   */
  outboundFor?(conversationId: string): ChannelOutbound | null;
  status(): Omit<ChannelStatus, 'id' | 'displayName' | 'enabled' | 'capabilities'>;
}
