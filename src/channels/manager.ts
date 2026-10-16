/**
 * Starts and stops the configured channels, and serves `/api/channels`.
 *
 * A channel runs when it is enabled in `settings.channels.<id>` and its
 * credentials are in the environment (`.env`). A channel that fails to start
 * is reported in its status and never takes the bridge down with it.
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';
import { readConfigFile, writeConfigFile } from '../state/configFile.js';
import { DiscordAdapter, DISCORD_CAPABILITIES } from './adapters/discord.js';
import { SlackAdapter, SLACK_CAPABILITIES } from './adapters/slack.js';
import { TelegramAdapter, TELEGRAM_CAPABILITIES } from './adapters/telegram.js';
import { WhatsAppAdapter, WHATSAPP_CAPABILITIES } from './adapters/whatsapp.js';
import { createBridgeOps, injectApi } from '../control/ops.js';
import { registerControlRoutes } from '../control/routes.js';
import { ChannelHub } from './hub.js';
import { CHANNEL_IDS, type ChannelAdapter, type ChannelCapabilities, type ChannelId, type ChannelStatus } from './types.js';

const log = childLogger('channels');

const DISPLAY: Record<ChannelId, { name: string; capabilities: ChannelCapabilities; env: readonly string[] }> = {
  discord: { name: 'Discord', capabilities: DISCORD_CAPABILITIES, env: ['DISCORD_BOT_TOKEN'] },
  telegram: { name: 'Telegram', capabilities: TELEGRAM_CAPABILITIES, env: ['TELEGRAM_BOT_TOKEN'] },
  slack: { name: 'Slack', capabilities: SLACK_CAPABILITIES, env: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] },
  whatsapp: {
    name: 'WhatsApp',
    capabilities: WHATSAPP_CAPABILITIES,
    env: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET'],
  },
};

function envOf(name: string): string {
  return (process.env[name] ?? '').trim();
}

export class ChannelManager {
  private readonly adapters = new Map<ChannelId, ChannelAdapter>();
  private readonly errors = new Map<ChannelId, string>();
  /** Pending reconnects after a network failure, and how many in a row. */
  private readonly retries = new Map<ChannelId, { timer: NodeJS.Timeout; attempt: number }>();
  readonly hub: ChannelHub;

  constructor(private readonly app: FastifyInstance) {
    this.hub = new ChannelHub({ ops: createBridgeOps(injectApi(app)) });
  }

  private missing(id: ChannelId): string[] {
    return DISPLAY[id].env.filter((name) => !envOf(name));
  }

  private build(id: ChannelId): ChannelAdapter {
    switch (id) {
      case 'discord':
        return new DiscordAdapter(this.hub, envOf('DISCORD_BOT_TOKEN'));
      case 'telegram':
        return new TelegramAdapter(this.hub, envOf('TELEGRAM_BOT_TOKEN'), envOf('TELEGRAM_API_BASE') || undefined);
      case 'slack':
        return new SlackAdapter(this.hub, envOf('SLACK_BOT_TOKEN'), envOf('SLACK_APP_TOKEN'), envOf('SLACK_API_BASE') || undefined);
      case 'whatsapp':
        return new WhatsAppAdapter(
          this.hub,
          {
            accessToken: envOf('WHATSAPP_ACCESS_TOKEN'),
            phoneNumberId: envOf('WHATSAPP_PHONE_NUMBER_ID'),
            verifyToken: envOf('WHATSAPP_VERIFY_TOKEN'),
            appSecret: envOf('WHATSAPP_APP_SECRET'),
          },
          envOf('WHATSAPP_API_BASE') || undefined,
        );
    }
  }

  /** Start every enabled channel that has its credentials. */
  async startAll(): Promise<void> {
    await Promise.all(CHANNEL_IDS.map((id) => this.restart(id)));
  }

  /** (Re)start one channel after its settings changed. */
  async restart(id: ChannelId, attempt = 0): Promise<void> {
    const pending = this.retries.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.retries.delete(id);
    }
    const running = this.adapters.get(id);
    if (running) {
      this.adapters.delete(id);
      this.hub.setOutbound(id, null);
      await running.stop().catch((err: unknown) => log.warn({ err, channel: id }, 'channel stop failed'));
    }
    this.errors.delete(id);
    if (!getConfig().settings.channels[id].enabled || this.missing(id).length) return;
    const adapter = this.build(id);
    this.adapters.set(id, adapter);
    try {
      await adapter.start();
      if (adapter.outboundFor) this.hub.setOutbound(id, (conversation) => adapter.outboundFor!(conversation));
      log.info({ channel: id }, 'channel started');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.errors.set(id, message);
      log.warn({ channel: id, err: message }, 'channel failed to start');
      // A network blip at boot (DNS not up yet, a dropped connection) must not
      // leave the channel off until someone restarts it: try again, backing off.
      if (/EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|socket hang up/i.test(message)) {
        const delay = Math.min(60_000, 5_000 * 2 ** attempt);
        log.info({ channel: id, inMs: delay }, 'channel will retry');
        const timer = setTimeout(() => void this.restart(id, attempt + 1), delay);
        timer.unref?.();
        this.retries.set(id, { timer, attempt });
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const r of this.retries.values()) clearTimeout(r.timer);
    this.retries.clear();
    this.hub.close();
    await Promise.all([...this.adapters.values()].map((a) => a.stop().catch(() => undefined)));
    this.adapters.clear();
  }

  /** The WhatsApp adapter, when it is the one running (for the webhook). */
  whatsapp(): WhatsAppAdapter | null {
    const a = this.adapters.get('whatsapp');
    return a instanceof WhatsAppAdapter ? a : null;
  }

  status(): Array<
    ChannelStatus & {
      missingEnv: string[];
      allowUsers: string[];
      requireMention: boolean;
      messageChannel: string | null;
      voiceChannel: string | null;
    }
  > {
    const settings = getConfig().settings.channels;
    return CHANNEL_IDS.map((id) => {
      const meta = DISPLAY[id];
      const adapter = this.adapters.get(id);
      const missingEnv = this.missing(id);
      const enabled = settings[id].enabled;
      const base = adapter?.status() ?? {
        state: (!enabled ? 'off' : missingEnv.length ? 'missing_token' : 'error') as ChannelStatus['state'],
        calls: 0,
      };
      const detail = this.errors.get(id) ?? base.detail ?? (enabled && missingEnv.length ? `Set ${missingEnv.join(', ')} in .env` : undefined);
      return {
        id,
        displayName: meta.name,
        enabled,
        ...base,
        ...(this.errors.has(id) ? { state: 'error' as const } : {}),
        ...(detail ? { detail } : {}),
        capabilities: meta.capabilities,
        missingEnv,
        allowUsers: settings[id].allowUsers,
        requireMention: settings[id].requireMention,
        messageChannel: settings[id].messageChannel,
        voiceChannel: settings[id].voiceChannel,
      };
    });
  }
}

const ChannelPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowUsers: z.array(z.string().trim().min(1)).max(100).optional(),
    requireMention: z.boolean().optional(),
    messageChannel: z.string().trim().min(1).nullable().optional(),
    voiceChannel: z.string().trim().min(1).nullable().optional(),
    logs: z.boolean().optional(),
    voice: z.boolean().optional(),
    autoJoin: z.boolean().optional(),
    welcomeDm: z.boolean().optional(),
    voiceNotes: z.boolean().optional(),
  })
  .strict();

let manager: ChannelManager | null = null;

export function getChannelManager(): ChannelManager | null {
  return manager;
}

/**
 * `/api/channels` (app-token auth like every /api route) and the WhatsApp
 * webhook (Meta-signature auth). Channels start once the server listens.
 */
export function registerChannelRoutes(app: FastifyInstance): ChannelManager {
  const m = new ChannelManager(app);
  manager = m;
  // The agent's control commands — the CLI's, and so every chat's (channels/commands.ts).
  registerControlRoutes(app);
  new WhatsAppAdapter(m.hub, { accessToken: '', phoneNumberId: '', verifyToken: '', appSecret: '' }).register(app, () => m.whatsapp());

  app.get('/api/channels', async () => ({
    channels: m.status(),
    commandPrefix: getConfig().settings.channels.commandPrefix,
    bindings: m.hub.bindings.list(),
  }));

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/channels/:id', async (req, reply) => {
    const id = req.params.id as ChannelId;
    if (!CHANNEL_IDS.includes(id)) return reply.code(404).send({ error: `No channel "${req.params.id}"` });
    const parsed = ChannelPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const cfg = readConfigFile();
    const current = cfg.settings.channels[id] as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      current[key] = value;
    }
    writeConfigFile(cfg);
    // Only turning a channel on or off needs a reconnect. Everything else —
    // allowlist, mention gating, voice, auto-join — is read live; restarting
    // for it cut the bot off mid-reply when the change came from that channel.
    if (parsed.data.enabled !== undefined) await m.restart(id);
    return { channel: m.status().find((c) => c.id === id) };
  });

  app.post<{ Params: { id: string }; Body: { userId?: unknown } }>('/api/channels/:id/allow', async (req, reply) => {
    const id = req.params.id as ChannelId;
    if (!CHANNEL_IDS.includes(id)) return reply.code(404).send({ error: `No channel "${req.params.id}"` });
    const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
    if (!userId) return reply.code(400).send({ error: 'userId is required' });
    const cfg = readConfigFile();
    const list = cfg.settings.channels[id].allowUsers;
    if (!list.includes(userId)) list.push(userId);
    writeConfigFile(cfg);
    return { channel: id, allowUsers: getConfig().settings.channels[id].allowUsers };
  });

  return m;
}
