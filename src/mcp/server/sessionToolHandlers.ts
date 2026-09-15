/**
 * Session directory tools — see and write into every running agent session
 * (docs/37, #56 and #57).
 *
 * `inject` is rebuilt on top of these. Its old implementation wrote to
 * `active.handle.stdin`, which does not exist (agents are spawned
 * `stdio: ['ignore','pipe','pipe']`), only ever matched the singleton worker,
 * and returned `delivered: false` every single time. The replacement picks a
 * delivery method that actually works for the target and reports which one it
 * used, so the voice agent can tell the user the truth.
 */

import { childLogger } from '../../log.js';
import { writeAudit } from '../../state/db.js';
import { createHash } from 'node:crypto';
import {
  listSessions as directoryList,
  resolveSession,
  isSessionLive,
  type SessionEntry,
  type SessionKind,
  type DeliveryMethod,
} from '../../state/sessionDirectory.js';
import { postMessage, collectMessages, pendingCount } from '../../state/sessionMailbox.js';
import { voiceTurnQueue } from './turnQueue.js';
import { getActiveVoiceAgent } from '../../executor/voiceAgent.js';

const log = childLogger('mcp:sessionTools');

export interface ListSessionsArgs {
  scope?: 'all' | 'running' | 'bridge' | 'external' | 'recent';
  project?: string;
}

export interface ListSessionsResult {
  sessions: SessionEntry[];
  /** Grouped exactly as the phone shows them (docs/37 §3). */
  groups: {
    running_bridge: SessionEntry[];
    running_external: SessionEntry[];
    recent: SessionEntry[];
  };
  message?: string;
}

const SCOPES: Record<NonNullable<ListSessionsArgs['scope']>, SessionKind[]> = {
  all: ['voice', 'worker', 'recent', 'external'],
  running: ['voice', 'worker', 'external'],
  bridge: ['voice', 'worker'],
  external: ['external'],
  recent: ['recent'],
};

export function handleListSessions(args: ListSessionsArgs = {}): ListSessionsResult {
  const scope = SCOPES[args.scope ?? 'all'];
  const sessions = directoryList({ scope, project: args.project ?? null });
  return {
    sessions,
    groups: {
      running_bridge: sessions.filter((s) => s.kind === 'voice' || s.kind === 'worker'),
      running_external: sessions.filter((s) => s.kind === 'external'),
      recent: sessions.filter((s) => s.kind === 'recent'),
    },
    ...(sessions.length === 0
      ? { message: 'No agent sessions found for the registered projects.' }
      : {}),
  };
}

export interface SendToSessionArgs {
  /** A handle, a spoken name ("auth worker"), or an ordinal ("the second one"). */
  handle: string;
  message: string;
  /**
   * The user has confirmed this send. Required for anything that is not a
   * bridge session with live or mailbox delivery.
   */
  confirm?: boolean;
  project?: string;
}

export interface SendToSessionResult {
  ok: boolean;
  /** What actually happened — never a bare "sent". */
  delivery: DeliveryMethod | 'refused' | 'mailbox_pending';
  target?: {
    handle: string;
    name: string;
    kind: SessionKind;
    project: string;
    provider: string;
  };
  /** Set when the name matched more than one session. */
  candidates?: Array<{ handle: string; name: string; kind: SessionKind }>;
  message: string;
  needs_confirmation?: boolean;
}

/**
 * Deliver a message to a session.
 *
 * Confirmation rules (docs/37 §3): optional for bridge workers reached live or
 * by mailbox, because the user just asked for it and the target is ours;
 * always required for external sessions, forks and anything that has to stop
 * and resume a thread — the same gate `stop_agent` uses.
 */
export function handleSendToSession(args: SendToSessionArgs): SendToSessionResult {
  const text = args.message.trim();
  if (!text) {
    return { ok: false, delivery: 'refused', message: 'Nothing to send — the message was empty.' };
  }

  const { entry, matches } = resolveSession(args.handle, { project: args.project ?? null });
  if (!entry) {
    if (matches.length > 1) {
      return {
        ok: false,
        delivery: 'refused',
        candidates: matches.map((m) => ({ handle: m.handle, name: m.name, kind: m.kind })),
        message:
          `"${args.handle}" matches ${matches.length} sessions. ` +
          'Read the names back to the user and ask which one they mean.',
      };
    }
    return {
      ok: false,
      delivery: 'refused',
      message: `No session matches "${args.handle}". Call list_sessions() to see what is running.`,
    };
  }

  const target = {
    handle: entry.handle,
    name: entry.name,
    kind: entry.kind,
    project: entry.project,
    provider: entry.providerName,
  };

  if (entry.requiresConfirmation && !args.confirm) {
    return {
      ok: false,
      delivery: 'refused',
      needs_confirmation: true,
      target,
      message:
        `Read this back to the user before sending: "${text}" to ${entry.name} ` +
        `(${entry.providerName}, ${entry.project}), delivered by ${describeDelivery(entry.delivery)}. ` +
        'Call again with confirm: true once they agree.',
    };
  }

  const result = deliver(entry, text);
  writeAudit({
    tool: 'send_to_session',
    project: entry.project,
    // The message itself is never stored: it can contain anything the user said.
    args_hash: createHash('sha256').update(text).digest('hex').slice(0, 16),
    result: result.ok ? 'ok' : 'rejected',
    reason: `${entry.kind}:${result.delivery}${args.confirm ? ' (confirmed)' : ''}`,
  });
  return { ...result, target };
}

function describeDelivery(method: DeliveryMethod): string {
  switch (method) {
    case 'live':
      return 'handing it straight to the running agent';
    case 'mailbox':
      return 'leaving it in its mailbox for its next tool call';
    case 'queued_next_turn':
      return 'queueing it for the next turn';
    case 'fork':
      return 'branching the conversation so the live one is not disturbed';
    case 'resume':
      return 'continuing that conversation in a new run';
    case 'read_only':
      return 'nothing — that session cannot be written to';
  }
}

function deliver(entry: SessionEntry, text: string): SendToSessionResult {
  switch (entry.delivery) {
    case 'live': {
      // The voice agent's live channel is the turn queue it already polls.
      const voice = getActiveVoiceAgent();
      if (voice && entry.handle === voice.runId) {
        voiceTurnQueue.enqueue(text);
        log.info({ handle: entry.handle }, 'message handed to the voice turn queue');
        return { ok: true, delivery: 'live', message: `Handed to ${entry.name} now.` };
      }
      // A live row whose process we cannot reach falls back rather than lying.
      postMessage(entry.handle, text);
      return {
        ok: true,
        delivery: 'mailbox_pending',
        message: `Left for ${entry.name} — it will pick it up on its next tool call.`,
      };
    }

    case 'mailbox': {
      postMessage(entry.handle, text);
      return {
        ok: true,
        delivery: 'mailbox_pending',
        message:
          `Left in ${entry.name}'s mailbox (${pendingCount(entry.handle)} waiting). ` +
          'It arrives on its next AgentVoice tool call, not instantly.',
      };
    }

    case 'fork':
    case 'resume': {
      /**
       * Resuming a session id that a live process still owns corrupts its
       * transcript, so a thread with a live owner is forked instead — and if
       * the provider cannot fork, it is refused rather than risked.
       */
      const live = entry.sessionId ? isSessionLive(entry.sessionId) : false;
      if (live && entry.delivery !== 'fork') {
        return {
          ok: false,
          delivery: 'refused',
          message:
            `${entry.name} is open in another process right now, and ${entry.providerName} ` +
            'cannot branch a conversation. Writing to it would corrupt the transcript. ' +
            'Ask the user to finish there, or start a new session instead.',
        };
      }
      postMessage(entry.handle, text);
      return {
        ok: true,
        delivery: entry.delivery,
        message:
          entry.delivery === 'fork'
            ? `Queued as a new branch of ${entry.name} — it starts when you spawn it.`
            : `Queued for ${entry.name}; it runs when that conversation is resumed.`,
      };
    }

    case 'queued_next_turn': {
      postMessage(entry.handle, text);
      return {
        ok: true,
        delivery: 'queued_next_turn',
        message: `Queued for ${entry.name}'s next turn.`,
      };
    }

    case 'read_only':
      return {
        ok: false,
        delivery: 'refused',
        message:
          `${entry.name} cannot be written to: it was started outside AgentVoice and ` +
          `${entry.providerName} has no way to branch it. AgentVoice never types into ` +
          "someone's terminal.",
      };
  }
}

// ── check_messages ──────────────────────────────────────────────────────────

export interface CheckMessagesArgs {
  /** The calling session's own handle — its job id or voice run id. */
  session?: string;
}

export interface CheckMessagesResult {
  messages: Array<{ text: string; from: string; at: string }>;
  count: number;
  message: string;
}

export function handleCheckMessages(args: CheckMessagesArgs, fallbackKey: string): CheckMessagesResult {
  const key = args.session?.trim() || fallbackKey;
  const collected = collectMessages(key);
  return {
    messages: collected.map((m) => ({ text: m.text, from: m.source, at: m.queuedAt })),
    count: collected.length,
    message:
      collected.length === 0
        ? 'Nothing waiting.'
        : `${collected.length} message${collected.length === 1 ? '' : 's'} from the user — ` +
          'treat them as instructions that arrived mid-task.',
  };
}

// ── inject, rebuilt ─────────────────────────────────────────────────────────

export interface InjectArgs {
  id: string;
  message: string;
  confirm?: boolean;
}

/**
 * Backwards-compatible `inject`, now delivering for real.
 *
 * Kept as an alias because the tool name is in prompts and transcripts; it is
 * `send_to_session` under another name, and it now covers the worktree pool
 * and the voice agent instead of only matching the singleton.
 *
 * The confirmation gate is *not* pre-granted: bridge workers never needed it,
 * and external sessions, forks and stop-then-resume need it exactly as much
 * through the old tool name as the new one (docs/37 §3, §4).
 */
export function handleInject(args: InjectArgs): SendToSessionResult {
  return handleSendToSession({
    handle: args.id,
    message: args.message,
    confirm: args.confirm ?? false,
  });
}
