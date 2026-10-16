/**
 * `agentvoice channel` — Discord / Telegram / Slack / WhatsApp (docs/44).
 *
 *   agentvoice channel                     status of every channel
 *   agentvoice channel allow <id> <user>   let a platform user command the bridge
 *   agentvoice channel enable|disable <id>
 *   agentvoice channel set <id> <key> <value>
 *       messageChannel <conversation id|none>   the bot's own text channel / chat
 *       voiceChannel <room id|none>              where calls happen
 *       logs | voice | autoJoin | welcomeDm | voiceNotes | requireMention  on|off
 *
 * Talks to the running bridge when one answers (the change applies at once);
 * otherwise edits this home's config.json, picked up on the next start.
 */

import { writeFileSync } from 'node:fs';
import { bridgeApi, findBridge } from '../bridge.js';
import { readConfig, resolveHome } from '../home.js';
import { bold, dim, fail, green, say, yellow } from '../out.js';

const CHANNELS = ['discord', 'telegram', 'slack', 'whatsapp'] as const;
type Channel = (typeof CHANNELS)[number];

interface ChannelRow {
  id: Channel;
  displayName: string;
  enabled: boolean;
  state: string;
  detail?: string;
  calls: number;
  allowUsers: string[];
  missingEnv: string[];
  capabilities: Record<string, { supported: boolean }>;
}

/** `channel set` keys (any case) → the setting, and how its value is read. */
const SETTABLE: Record<string, { key: string; kind: 'id' | 'bool' }> = {
  messagechannel: { key: 'messageChannel', kind: 'id' },
  voicechannel: { key: 'voiceChannel', kind: 'id' },
  logs: { key: 'logs', kind: 'bool' },
  voice: { key: 'voice', kind: 'bool' },
  autojoin: { key: 'autoJoin', kind: 'bool' },
  welcomedm: { key: 'welcomeDm', kind: 'bool' },
  voicenotes: { key: 'voiceNotes', kind: 'bool' },
  requiremention: { key: 'requireMention', kind: 'bool' },
};

function settingValue(kind: 'id' | 'bool', raw: string, key: string): string | boolean | null {
  const v = raw.trim();
  if (kind === 'id') return ['none', 'off', 'clear', ''].includes(v.toLowerCase()) ? null : v;
  if (['on', 'true', 'yes', '1'].includes(v.toLowerCase())) return true;
  if (['off', 'false', 'no', '0'].includes(v.toLowerCase())) return false;
  throw new Error(`${key} is on or off`);
}

function asChannel(value: string | undefined): Channel {
  const id = (value ?? '').toLowerCase() as Channel;
  if (!CHANNELS.includes(id)) throw new Error(`channel must be one of: ${CHANNELS.join(', ')}`);
  return id;
}

/** Edit config.json in place when no bridge is running. */
function editOffline(home: string, edit: (channels: Record<string, Record<string, unknown>>) => void): void {
  const cfg = readConfig(home);
  if (!cfg.exists || !cfg.config) throw new Error(cfg.error ?? `no config.json at ${cfg.path} — run agentvoice setup first`);
  const raw = cfg.config as unknown as { settings?: Record<string, unknown> };
  raw.settings ??= {};
  const channels = (raw.settings['channels'] ??= {}) as Record<string, Record<string, unknown>>;
  edit(channels);
  writeFileSync(cfg.path, `${JSON.stringify(raw, null, 2)}\n`);
}

export async function channelCommand(positionals: string[]): Promise<number> {
  const home = resolveHome();
  const [action = 'status', ...args] = positionals;
  const bridge = await findBridge(home);
  const endpoint = bridge.answering?.endpoint ?? null;

  try {
    if (action === 'status' || action === 'list') {
      if (!endpoint) {
        fail('the bridge is not running — start it to see channel status (agentvoice start)');
        return 1;
      }
      const res = await bridgeApi<{ channels: ChannelRow[]; commandPrefix: string }>(home, endpoint, '/api/channels');
      if (!res.ok) throw new Error(res.error);
      for (const c of res.body.channels) {
        const state =
          c.state === 'connected' ? green('connected') : c.state === 'off' ? dim('off') : yellow(c.state.replace('_', ' '));
        const can = Object.entries(c.capabilities)
          .filter(([, v]) => v.supported)
          .map(([k]) => k)
          .join(', ');
        say(`${bold(c.displayName.padEnd(9))} ${state}${c.calls ? ` · ${c.calls} call(s)` : ''}${c.detail ? dim(` — ${c.detail}`) : ''}`);
        say(dim(`          allowed: ${c.allowUsers.length ? c.allowUsers.join(', ') : 'nobody yet'} · can: ${can}`));
      }
      say(dim(`\n  Prefix in group chats: ${res.body.commandPrefix} · docs/44-channels.md`));
      return 0;
    }

    if (action === 'allow') {
      const id = asChannel(args[0]);
      const user = (args[1] ?? '').trim();
      if (!user) throw new Error('usage: agentvoice channel allow <channel> <user id>');
      if (endpoint) {
        const res = await bridgeApi(home, endpoint, `/api/channels/${id}/allow`, 15_000, { method: 'POST', body: { userId: user } });
        if (!res.ok) throw new Error(res.error);
      } else {
        editOffline(home, (channels) => {
          const entry = (channels[id] ??= {});
          const list = Array.isArray(entry['allowUsers']) ? (entry['allowUsers'] as string[]) : [];
          if (!list.includes(user)) list.push(user);
          entry['allowUsers'] = list;
        });
      }
      say(`${green('✓')} ${user} may now command the bridge on ${id}${endpoint ? '' : dim(' (applies when the bridge starts)')}`);
      return 0;
    }

    if (action === 'enable' || action === 'disable') {
      const id = asChannel(args[0]);
      const enabled = action === 'enable';
      if (endpoint) {
        const res = await bridgeApi<{ channel: ChannelRow }>(home, endpoint, `/api/channels/${id}`, 30_000, {
          method: 'PATCH',
          body: { enabled },
        });
        if (!res.ok) throw new Error(res.error);
        const c = res.body.channel;
        say(`${green('✓')} ${c.displayName} ${enabled ? 'enabled' : 'disabled'} — ${c.state}${c.detail ? ` (${c.detail})` : ''}`);
        if (enabled && c.missingEnv.length) say(yellow(`  set ${c.missingEnv.join(', ')} in ${home}/.env, then restart`));
      } else {
        editOffline(home, (channels) => {
          (channels[id] ??= {})['enabled'] = enabled;
        });
        say(`${green('✓')} ${id} ${enabled ? 'enabled' : 'disabled'} ${dim('(applies when the bridge starts)')}`);
      }
      return 0;
    }

    if (action === 'set') {
      const id = asChannel(args[0]);
      const spec = SETTABLE[(args[1] ?? '').toLowerCase().replace(/[-_]/g, '')];
      if (!spec) throw new Error(`usage: agentvoice channel set <channel> <${Object.values(SETTABLE).map((x) => x.key).join('|')}> <value>`);
      const value = settingValue(spec.kind, args.slice(2).join(' '), spec.key);
      if (endpoint) {
        const res = await bridgeApi(home, endpoint, `/api/channels/${id}`, 30_000, { method: 'PATCH', body: { [spec.key]: value } });
        if (!res.ok) throw new Error(res.error);
      } else {
        editOffline(home, (channels) => {
          (channels[id] ??= {})[spec.key] = value;
        });
      }
      const shown = value === null ? 'none' : value === true ? 'on' : value === false ? 'off' : value;
      say(`${green('✓')} ${id} ${spec.key} → ${shown}${endpoint ? '' : dim(' (applies when the bridge starts)')}`);
      return 0;
    }

    throw new Error(`unknown channel action "${action}" — status, allow, set, enable or disable`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
