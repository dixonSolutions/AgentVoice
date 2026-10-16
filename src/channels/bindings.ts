/**
 * The default session of a channel conversation.
 *
 * `@Squeakr default <session>` in a Discord channel (or a Telegram chat,
 * a Slack channel, a WhatsApp DM) pins which agent conversation that place
 * talks to: calling the bot there, or `say`-ing something to it, continues
 * that session instead of whatever the phone last used — and a new call does
 * not start a fresh thread.
 *
 * Applying a binding is exactly what the phone's session picker does: make the
 * project active and set its resume id (routes/agentSessions.ts `/select`).
 */

import { getDb } from '../state/db.js';
import type { ChannelId } from './types.js';

export interface ChannelBinding {
  channel: ChannelId;
  conversation: string;
  project: string;
  /** Agent CLI the session belongs to; null = "this project, whatever is current". */
  provider: string | null;
  sessionId: string | null;
  /** Spoken name at the time it was pinned ("auth worker"). */
  label: string | null;
  updatedAt: string;
}

export interface BindingStore {
  get(channel: ChannelId, conversation: string): ChannelBinding | null;
  set(binding: Omit<ChannelBinding, 'updatedAt'>): ChannelBinding;
  clear(channel: ChannelId, conversation: string): boolean;
  list(channel?: ChannelId): ChannelBinding[];
}

interface Row {
  channel: string;
  conversation: string;
  project: string;
  provider: string | null;
  session_id: string | null;
  label: string | null;
  updated_at: string;
}

const toBinding = (r: Row): ChannelBinding => ({
  channel: r.channel as ChannelId,
  conversation: r.conversation,
  project: r.project,
  provider: r.provider,
  sessionId: r.session_id,
  label: r.label,
  updatedAt: r.updated_at,
});

export const dbBindingStore: BindingStore = {
  get(channel, conversation) {
    const row = getDb()
      .prepare('SELECT * FROM channel_binding WHERE channel = ? AND conversation = ?')
      .get(channel, conversation) as Row | undefined;
    return row ? toBinding(row) : null;
  },
  set(b) {
    getDb()
      .prepare(
        `INSERT INTO channel_binding (channel, conversation, project, provider, session_id, label, updated_at)
         VALUES (@channel, @conversation, @project, @provider, @sessionId, @label, datetime('now'))
         ON CONFLICT(channel, conversation) DO UPDATE SET
           project = excluded.project, provider = excluded.provider,
           session_id = excluded.session_id, label = excluded.label, updated_at = excluded.updated_at`,
      )
      .run(b);
    return dbBindingStore.get(b.channel, b.conversation)!;
  },
  clear(channel, conversation) {
    return getDb().prepare('DELETE FROM channel_binding WHERE channel = ? AND conversation = ?').run(channel, conversation)
      .changes > 0;
  },
  list(channel) {
    const rows = (
      channel
        ? getDb().prepare('SELECT * FROM channel_binding WHERE channel = ? ORDER BY updated_at DESC').all(channel)
        : getDb().prepare('SELECT * FROM channel_binding ORDER BY updated_at DESC').all()
    ) as Row[];
    return rows.map(toBinding);
  },
};

/** For tests and for a bridge without a database. */
export function memoryBindingStore(): BindingStore {
  const map = new Map<string, ChannelBinding>();
  const key = (c: string, v: string) => `${c}\u0000${v}`;
  return {
    get: (c, v) => map.get(key(c, v)) ?? null,
    set(b) {
      const full = { ...b, updatedAt: new Date().toISOString() };
      map.set(key(b.channel, b.conversation), full);
      return full;
    },
    clear: (c, v) => map.delete(key(c, v)),
    list: (c) => [...map.values()].filter((b) => !c || b.channel === c),
  };
}
