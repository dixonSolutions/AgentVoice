/**
 * `squeakr agent | projects | project | sessions | use | new | say | config | default`
 * — run the voice agent's side of a running bridge from a terminal.
 *
 * Every chat channel runs these same commands (channels/commands.ts parses a
 * message into argv and runs this CLI), so there is one implementation and a
 * terminal and a chat read the same answers. The answers come from
 * `/api/control/*` (control/routes.ts); wording is control/format.ts.
 *
 * `--channel <id> --conversation <id> --user <id>` say which chat a command
 * came from: `default` pins per conversation (or, with `--user`, per person —
 * their voice calls), `sessions` marks what is pinned, `say` applies it.
 * SQUEAKR_MARKDOWN=1 writes **bold** and `code` marks instead of colour —
 * what a chat renders.
 */

import type { ChannelBinding } from '../../channels/bindings.js';
import { formatSessions, formatStatus, MARKDOWN, styled, type Style } from '../../control/format.js';
import type { BridgeStatus, ConfigKeyInfo, ControlCommand, SessionRow } from '../../control/types.js';
import { UsageError, type Parsed } from '../args.js';
import { bridgeApi, findBridge } from '../bridge.js';
import { resolveHome } from '../home.js';
import { bold, cyan, fail, say } from '../out.js';

export const CONTROL_VALUE_FLAGS = ['channel', 'conversation', 'user'];

const TERMINAL: Style = { bold, code: cyan };

function style(): Style {
  return process.env['SQUEAKR_MARKDOWN'] === '1' ? MARKDOWN : TERMINAL;
}

/** Where a command came from — none of these when it is typed in a terminal. */
interface Origin {
  channel?: string;
  conversation?: string;
  user?: string;
}

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export async function controlCommand(command: ControlCommand, parsed: Parsed): Promise<number> {
  const home = resolveHome();
  const origin: Origin = {
    ...(parsed.values.get('channel') ? { channel: parsed.values.get('channel')! } : {}),
    ...(parsed.values.get('conversation') ? { conversation: parsed.values.get('conversation')! } : {}),
    ...(parsed.values.get('user') ? { user: parsed.values.get('user')! } : {}),
  };
  const [first = '', ...more] = parsed.positionals;
  const text = parsed.positionals.join(' ').trim();
  const out = (line: string) => say(styled(line, style()));

  const bridge = await findBridge(home);
  const endpoint = bridge.answering?.endpoint;
  if (!endpoint) {
    fail('the bridge is not running — start it first (squeakr start)');
    return 1;
  }
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await bridgeApi<T>(home, endpoint, path, 60_000, body === undefined ? {} : { method: 'POST', body });
    if (!res.ok) throw new Error(res.error.replace(/^HTTP 400 — /, ''));
    return res.body;
  };

  try {
    switch (command) {
      case 'agent': {
        if (first === 'stop') {
          const r = await api<{ stopped: boolean }>('/api/control/stop', {});
          out(r.stopped ? 'Stopped the voice agent.' : 'The voice agent is not running.');
          return 0;
        }
        if (first && first !== 'status') throw new UsageError('agent [status|stop]');
        const r = await api<{ status: BridgeStatus; binding: ChannelBinding | null }>(
          `/api/control/status${query({ channel: origin.channel, conversation: origin.conversation })}`,
        );
        out(formatStatus(r.status, r.binding));
        return 0;
      }

      case 'projects': {
        const r = await api<{ projects: { name: string; active: boolean }[] }>('/api/control/projects');
        out(r.projects.length ? r.projects.map((p) => `${p.active ? '▶' : '•'} ${p.name}`).join('\n') : 'No projects registered — `squeakr add <path>` on the host.');
        return 0;
      }

      case 'project': {
        if (!text) {
          const r = await api<{ status: BridgeStatus }>('/api/control/status');
          out(`Active project: **${r.status.activeProject ?? 'none'}**`);
          return 0;
        }
        const r = await api<{ project: string }>('/api/control/project', { name: text });
        out(`Active project is now **${r.project}**.`);
        return 0;
      }

      case 'sessions': {
        const r = await api<{ rows: SessionRow[]; binding: ChannelBinding | null; voiceBinding: ChannelBinding | null }>(
          `/api/control/sessions${query({ project: text || undefined, channel: origin.channel, conversation: origin.conversation, user: origin.user })}`,
        );
        out(formatSessions(r.rows, r.binding, r.voiceBinding));
        return 0;
      }

      case 'use': {
        if (!text) throw new UsageError('use <n|name|id> — `sessions` lists them');
        out((await api<{ message: string }>('/api/control/use', { query: text })).message);
        return 0;
      }

      case 'new': {
        out((await api<{ message: string }>('/api/control/new', { ...(text ? { project: text } : {}), ...origin })).message);
        return 0;
      }

      case 'say': {
        if (!text) throw new UsageError('say <text>');
        const r = await api<{ pinned: string | null }>('/api/control/say', { text, ...origin });
        out(`💬 Sent${r.pinned ? ` to **${r.pinned}**` : ''}${origin.channel ? ' — replies will appear here.' : '.'}`);
        return 0;
      }

      case 'config': {
        if (!first) {
          const r = await api<{ keys: Array<ConfigKeyInfo & { value: string }> }>('/api/control/config');
          out(r.keys.map((k) => `\`${k.key}\` = ${k.value}${k.choices ? `  (${k.choices.join(' | ')})` : ''} — ${k.help}`).join('\n'));
          return 0;
        }
        if (!more.length) {
          const r = await api<{ keys: Array<ConfigKeyInfo & { value: string }> }>('/api/control/config');
          const k = r.keys.find((x) => x.key === first);
          if (!k) throw new Error(`Unknown setting \`${first}\`. \`config\` lists them.`);
          out(`\`${k.key}\` = ${k.value}`);
          return 0;
        }
        out((await api<{ message: string }>('/api/control/config', { key: first, value: more.join(' ') })).message);
        return 0;
      }

      case 'default': {
        if (!origin.channel || (!origin.conversation && !origin.user)) {
          throw new UsageError('default needs --channel and --conversation (or --user for a voice default)');
        }
        const voice = Boolean(origin.user && !origin.conversation);
        if (!text) {
          const r = await api<{ binding: ChannelBinding | null }>(`/api/control/default${query({ ...origin })}`);
          const b = r.binding;
          if (voice) out(`Your calls continue **${b ? b.label ?? b.sessionId ?? b.project : 'whatever is active'}**. \`voice default <n>\` changes it.`);
          else if (b) out(`This conversation continues **${b.label ?? b.sessionId ?? 'the latest session'}** on ${b.project}. \`default none\` unpins it.`);
          else out('No default session here — `say` and calls started here use whatever the bridge has active. `default <n>` pins one.');
          return 0;
        }
        out((await api<{ message: string }>('/api/control/default', { ...origin, target: text })).message);
        return 0;
      }
    }
  } catch (err) {
    if (err instanceof UsageError) throw err;
    fail(styled(err instanceof Error ? err.message : String(err), style()));
    return 1;
  }
}
