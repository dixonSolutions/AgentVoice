/**
 * Picking and pinning sessions — shared by `/api/control` (the CLI, and so
 * every chat) and the channel adapters, which apply a conversation's pinned
 * session before a call or a turn.
 */

import type { BindingStore, ChannelBinding } from '../channels/bindings.js';
import type { ChannelId } from '../channels/types.js';
import type { BridgeOps, SessionRow } from './types.js';

/** The binding that holds one person's voice-call default (Discord: `voice default`). */
export function voiceDefaultKey(userId: string): string {
  return `voice-user:${userId}`;
}

/** Pick one session from what the user typed: a list number, a spoken name, or an id prefix. */
export function pickSession(rows: SessionRow[], query: string): { row: SessionRow | null; matches: SessionRow[] } {
  const q = query.trim().toLowerCase();
  const n = Number(q.replace(/^#/, ''));
  if (Number.isInteger(n) && n >= 1 && n <= rows.length) return { row: rows[n - 1]!, matches: [rows[n - 1]!] };
  const exact = rows.filter((r) => r.name.toLowerCase() === q || r.handle.toLowerCase() === q);
  if (exact.length === 1) return { row: exact[0]!, matches: exact };
  const partial = rows.filter((r) => r.name.toLowerCase().includes(q) || (r.sessionId ?? '').toLowerCase().startsWith(q));
  return { row: partial.length === 1 ? partial[0]! : null, matches: partial };
}

export function ambiguity(query: string, matches: SessionRow[]): string {
  if (!matches.length) return `No session matches "${query}". \`sessions\` lists them.`;
  return `"${query}" matches ${matches.length}: ${matches
    .slice(0, 5)
    .map((m) => `**${m.name}** (${m.project})`)
    .join(', ')} — use the number from \`sessions\`.`;
}

/** `use <n|name|id>` — continue that session on the next turn. */
export function useSession(ops: BridgeOps, query: string): string {
  const { row, matches } = pickSession(ops.sessions(), query);
  if (!row) throw new Error(ambiguity(query, matches));
  if (!row.sessionId) throw new Error(`**${row.name}** has no conversation id yet — it cannot be continued.`);
  ops.setProject(row.project);
  return ops.selectSession(row.project, row.sessionId);
}

/**
 * Make the bridge continue a pinned session: its project becomes active and,
 * when a session is pinned, that session is the one resumed.
 */
export function applyBinding(binding: ChannelBinding | null, ops: BridgeOps): string | null {
  if (!binding) return null;
  ops.setProject(binding.project);
  if (binding.sessionId) ops.selectSession(binding.project, binding.sessionId);
  return binding.label ?? binding.project;
}

/**
 * `default …` and `voice default …`: pin a session (or a project's latest)
 * under `key` — a conversation id, or `voiceDefaultKey(user)`. `what` names
 * it in the answer ("this conversation", "your voice calls").
 */
export function pinDefault(
  ops: BridgeOps,
  bindings: BindingStore,
  channel: ChannelId,
  key: string,
  arg: string,
  what: string,
): string {
  const plural = what.startsWith('your');
  if (['none', 'off', 'clear'].includes(arg.toLowerCase())) {
    bindings.clear(channel, key);
    return `Default session cleared for ${what}.`;
  }
  const project = ops.projects().find((p) => p.name.toLowerCase() === arg.toLowerCase());
  if (project) {
    bindings.set({ channel, conversation: key, project: project.name, provider: null, sessionId: null, label: `latest on ${project.name}` });
    return `${what[0]!.toUpperCase()}${what.slice(1)} now continue${plural ? '' : 's'} the latest session on **${project.name}**.`;
  }
  const { row, matches } = pickSession(ops.sessions(), arg);
  if (!row) throw new Error(ambiguity(arg, matches));
  if (!row.sessionId) throw new Error(`**${row.name}** has no conversation id yet — it cannot be pinned.`);
  bindings.set({ channel, conversation: key, project: row.project, provider: row.providerName, sessionId: row.sessionId, label: row.name });
  return `📌 **${row.name}** (${row.project}) is now the session ${what} continue${plural ? '' : 's'}.`;
}
