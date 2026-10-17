/**
 * How control answers read — in a terminal (`squeaky sessions`) and in a
 * chat (the same command, run with SQUEAKY_MARKDOWN=1). Text comes in with
 * `**bold**` and `` `code` `` marks; `Style` renders them for where it goes.
 */

import type { ChannelBinding } from '../channels/bindings.js';
import type { BridgeStatus, SessionRow } from './types.js';

export interface Style {
  bold(text: string): string;
  code(text: string): string;
}

export const MARKDOWN: Style = { bold: (t) => `**${t}**`, code: (t) => `\`${t}\`` };

/** Render `**bold**` and `` `code` `` marks in `text` with `style`. */
export function styled(text: string, style: Style): string {
  if (style === MARKDOWN) return text;
  return text.replace(/\*\*([^*]+)\*\*/g, (_, t: string) => style.bold(t)).replace(/`([^`]+)`/g, (_, t: string) => style.code(t));
}

export function ago(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function formatSessions(rows: SessionRow[], binding: ChannelBinding | null, voiceBinding: ChannelBinding | null = null): string {
  if (!rows.length) return 'No sessions yet — say something to start one.';
  const lines = rows.slice(0, 15).map((s, i) => {
    const pinned = binding?.sessionId && s.sessionId === binding.sessionId ? ' 📌' : '';
    const voice = voiceBinding?.sessionId && s.sessionId === voiceBinding.sessionId ? ' 🎙️' : '';
    const when = ago(s.lastActivityAt);
    const meta = [s.providerName, s.project, s.status, when].filter(Boolean).join(' · ');
    const about = s.summary ? ` — ${s.summary.slice(0, 80)}` : '';
    return `${i + 1}. **${s.name}** (${s.kind}) ${meta}${about}${pinned}${voice}`;
  });
  const more = rows.length > 15 ? `\n…and ${rows.length - 15} more` : '';
  return `${lines.join('\n')}${more}\n\`use <n>\` continues one · \`default <n>\` pins it here · \`voice default <n>\` for your calls`;
}

export function formatStatus(s: BridgeStatus, binding: ChannelBinding | null): string {
  const agent = s.agentRunning
    ? `${s.agentName} is running${s.agentSessionId ? ` (session ${s.agentSessionId.slice(0, 8)})` : ''}`
    : `${s.agentName} is idle`;
  const pinned = binding
    ? `\nThis conversation's default: **${binding.label ?? binding.sessionId?.slice(0, 8) ?? 'latest'}** on ${binding.project}`
    : '';
  return (
    [
      `**${agent}** · project: ${s.activeProject ?? 'none selected'}`,
      `Listening: ${s.listener} · speech in: ${s.stt ?? 'none'} · out: ${s.tts ?? 'none'} · workflow: ${s.workflow}`,
    ].join('\n') + pinned
  );
}
