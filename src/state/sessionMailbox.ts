/**
 * Per-session mailbox — the baseline way a voice message reaches a running
 * agent (docs/37 §2, #56).
 *
 * `inject` never delivered anything: it wrote to `active.handle.stdin`, but
 * agents are spawned `stdio: ['ignore','pipe','pipe']`, so `AgentHandle` has no
 * stdin at all, and a `-p <prompt>` run would not read new input mid-run even
 * if it did. Every call returned `delivered: false`.
 *
 * A mailbox works with the grain of what actually exists: the agent-voice MCP
 * server is registered for all four CLIs, every worker calls its tools, and a
 * tool result can carry anything. Messages queue here and ride out on the next
 * AgentVoice tool result the target makes — or on an explicit
 * `check_messages()` call. Delivery is at the next tool call, which is honest
 * and bounded, rather than "best-effort" and never.
 *
 * Sessions started outside the bridge only receive mailbox messages if their
 * agent-voice rule tells them to call `check_messages()`, and only when the
 * project has opted in — see docs/37 §4.
 */

import { randomUUID } from 'node:crypto';
import { childLogger } from '../log.js';

const log = childLogger('session-mailbox');

export interface MailboxMessage {
  id: string;
  /** Free text from the user, relayed verbatim. */
  text: string;
  /** Who sent it — 'voice' for a spoken relay, 'desk' from the IDE. */
  source: 'voice' | 'desk' | 'api';
  queuedAt: string;
  deliveredAt: string | null;
}

/** Bounded so a session nobody is reading cannot grow without limit. */
const MAX_PER_SESSION = 20;

const boxes = new Map<string, MailboxMessage[]>();

/** Queue a message for a session handle. Returns the queued message. */
export function postMessage(
  sessionKey: string,
  text: string,
  source: MailboxMessage['source'] = 'voice',
): MailboxMessage {
  const message: MailboxMessage = {
    id: randomUUID(),
    text,
    source,
    queuedAt: new Date().toISOString(),
    deliveredAt: null,
  };
  const box = boxes.get(sessionKey) ?? [];
  box.push(message);
  if (box.length > MAX_PER_SESSION) box.shift();
  boxes.set(sessionKey, box);
  log.info({ sessionKey, id: message.id, len: text.length }, 'message queued for session');
  return message;
}

/** How many messages are waiting, without consuming them. */
export function pendingCount(sessionKey: string): number {
  return boxes.get(sessionKey)?.filter((m) => m.deliveredAt === null).length ?? 0;
}

/** Peek without consuming — used to decide whether to piggyback. */
export function peekMessages(sessionKey: string): readonly MailboxMessage[] {
  return (boxes.get(sessionKey) ?? []).filter((m) => m.deliveredAt === null);
}

/**
 * Take everything waiting for a session and mark it delivered.
 *
 * Consuming on read is deliberate: a message handed to the agent twice reads
 * as the user repeating themselves, which is worse than one that arrives late.
 */
export function collectMessages(sessionKey: string): MailboxMessage[] {
  const box = boxes.get(sessionKey);
  if (!box) return [];
  const now = new Date().toISOString();
  const undelivered = box.filter((m) => m.deliveredAt === null);
  for (const message of undelivered) message.deliveredAt = now;
  if (undelivered.length > 0) {
    log.info({ sessionKey, count: undelivered.length }, 'mailbox collected');
  }
  return undelivered;
}

/** Drop a session's mailbox — the session ended. */
export function clearMailbox(sessionKey: string): void {
  boxes.delete(sessionKey);
}

/** Every session key with something waiting, for the directory listing. */
export function sessionsWithMail(): string[] {
  const out: string[] = [];
  for (const [key, box] of boxes) {
    if (box.some((m) => m.deliveredAt === null)) out.push(key);
  }
  return out;
}

/** Test hook. */
export function resetMailboxes(): void {
  boxes.clear();
}
