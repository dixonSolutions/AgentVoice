/**
 * AgentVoice's own interrupt hook.
 *
 * The problem: MCP is a pull protocol. While the agent is inside *any*
 * long-running AgentVoice tool it is not calling `next_voice_turn()`, so a
 * user who speaks mid-work is invisible until the agent happens to poll again.
 *
 * The old fix reached into the approval registry specifically and hijacked
 * whatever `request_user_input` / `submit_plan_for_approval` call happened to
 * be pending. That only covered two tools, and it conflated "the user answered
 * your question" with "the user said something new".
 *
 * This module is the single hook instead. Every AgentVoice tool that can block
 * registers here, and one incoming user turn is delivered through whichever of
 * OUR tools the agent is currently sitting in. Two policies:
 *
 *   resolve  — the wait is *about* the user (a question, an approval card).
 *              A new utterance makes it moot, so the tool returns immediately
 *              carrying the utterance.
 *   annotate — the wait is *work* (a research call, a status poll). Nothing is
 *              aborted; the turn rides along on the tool's normal result so the
 *              agent learns about it the moment the work lands.
 *
 * This is pure MCP-protocol behaviour with no CLI-specific assumptions, so it
 * behaves identically for Cursor, Codex and Claude Code — unlike anything that
 * depends on a particular CLI's stream or flags.
 */

import { randomUUID } from 'node:crypto';
import { childLogger } from '../../log.js';
import type { TtsInterruptContext } from '../../voice/ttsInterrupt.js';

const log = childLogger('mcp:server:pendingWaits');

export type WaitPolicy = 'resolve' | 'annotate';

export interface VoiceTurnInterruptPayload {
  user_turn: string;
  is_interrupt: boolean;
  received_at: string;
  tts_interrupt?: TtsInterruptContext;
}

/** Shape merged into a tool result when a turn arrives mid-call. */
export interface VoiceTurnAnnotation {
  /** True when the user spoke while this tool was still running. */
  interrupted: true;
  user_turn: string;
  is_interrupt: boolean;
  received_at: string;
  tts_interrupt?: TtsInterruptContext;
}

export interface PendingWait {
  id: string;
  /** MCP tool name, for logs and UI. */
  tool: string;
  policy: WaitPolicy;
  startedAt: number;
  /** Opaque payload the owner attached (e.g. the approval card to dismiss). */
  meta?: unknown;
}

interface WaitRecord extends PendingWait {
  resolve: (value: VoiceTurnAnnotation) => void;
  /** Set for annotate-policy waits when a turn lands mid-call. */
  annotation: VoiceTurnAnnotation | null;
}

const waits = new Map<string, WaitRecord>();

function toAnnotation(payload: VoiceTurnInterruptPayload): VoiceTurnAnnotation {
  return {
    interrupted: true,
    user_turn: payload.user_turn,
    is_interrupt: payload.is_interrupt,
    received_at: payload.received_at,
    ...(payload.tts_interrupt ? { tts_interrupt: payload.tts_interrupt } : {}),
  };
}

/**
 * Register a `resolve`-policy wait.
 * The returned promise settles only if a user turn arrives; the caller races it
 * against its own completion.
 */
export function registerResolveWait(opts: {
  tool: string;
  meta?: unknown;
}): { id: string; interrupted: Promise<VoiceTurnAnnotation> } {
  const id = randomUUID();
  const interrupted = new Promise<VoiceTurnAnnotation>((resolve) => {
    waits.set(id, {
      id,
      tool: opts.tool,
      policy: 'resolve',
      startedAt: Date.now(),
      meta: opts.meta,
      resolve,
      annotation: null,
    });
  });
  return { id, interrupted };
}

/** Stop tracking a wait (its tool finished normally, or was cancelled). */
export function releaseWait(id: string): VoiceTurnAnnotation | null {
  const record = waits.get(id);
  if (!record) return null;
  waits.delete(id);
  return record.annotation;
}

/**
 * Run a long-running AgentVoice tool under `annotate` policy.
 *
 * The work always completes. If the user spoke while it ran, the annotation is
 * merged into the result so the agent sees the new request in the very same
 * tool output — no stop, no lost work, no waiting for the next poll.
 */
export async function withVoiceInterrupt<T extends object>(
  tool: string,
  run: () => Promise<T>,
): Promise<T & Partial<VoiceTurnAnnotation>> {
  const id = randomUUID();
  waits.set(id, {
    id,
    tool,
    policy: 'annotate',
    startedAt: Date.now(),
    resolve: () => {},
    annotation: null,
  });

  try {
    const result = await run();
    const annotation = releaseWait(id);
    if (!annotation) return result;
    log.info({ tool, text: annotation.user_turn.slice(0, 80) }, 'user turn attached to tool result');
    return { ...result, ...annotation };
  } catch (err) {
    releaseWait(id);
    throw err;
  }
}

/**
 * Deliver a user turn through whichever AgentVoice tool is currently blocking.
 * Returns the resolve-policy waits that were cut short (empty when the turn was
 * only annotated onto in-flight work, or when nothing was pending).
 */
export function interruptPendingWaits(payload: VoiceTurnInterruptPayload): {
  aborted: PendingWait[];
  annotated: PendingWait[];
} {
  if (waits.size === 0) return { aborted: [], annotated: [] };

  const annotation = toAnnotation(payload);
  const aborted: PendingWait[] = [];
  const annotated: PendingWait[] = [];

  for (const [id, record] of [...waits.entries()]) {
    if (record.policy === 'resolve') {
      waits.delete(id);
      record.resolve(annotation);
      aborted.push(record);
      log.info({ tool: record.tool, request_id: id }, 'wait resolved by user turn');
    } else {
      // Keep only the newest turn — the agent dequeues the rest itself.
      record.annotation = annotation;
      annotated.push(record);
    }
  }

  return { aborted, annotated };
}
