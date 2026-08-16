/**
 * Voice turn queue — bridges incoming STT transcripts to the agent's
 * `next_voice_turn()` polls.
 *
 * Architecture: MCP is a pull protocol. The bridge cannot push voice turns to
 * the agent; incoming turns are enqueued here and the agent calls
 * `next_voice_turn()` to dequeue.
 *
 * Long-poll pattern: if no turn is ready, `dequeue()` suspends until one
 * arrives or the timeout elapses. Latency stays low without busy-polling.
 *
 * Delivery order for one incoming turn:
 *   1. a waiting `next_voice_turn()` poll, else
 *   2. AgentVoice's interrupt hook (server/pendingWaits.ts) — whichever of OUR
 *      tools the agent is currently blocked in, else
 *   3. the buffer, for the agent's next poll.
 *
 * Step 2 is protocol-level, so it works identically on Cursor, Codex and
 * Claude Code — nothing here depends on a particular CLI.
 *
 * See docs/16-mcp-server-agent-as-brain.md § 8.1 / § 8.4.
 */

import { childLogger } from '../../log.js';
import type { TtsInterruptContext } from '../../voice/ttsInterrupt.js';
import { interruptPendingWaits, type PendingWait } from './pendingWaits.js';

const log = childLogger('mcp:server:turnQueue');

export interface VoiceTurn {
  text: string;
  /** ISO timestamp of when the turn arrived. */
  receivedAt: string;
  /** Whether this turn should interrupt any in-progress work (e.g. "cancel", "stop"). */
  isInterrupt: boolean;
  /** What the user actually heard via TTS before barge-in, if any. */
  ttsInterrupt?: TtsInterruptContext;
}

export interface EnqueueVoiceTurnOptions {
  isInterrupt?: boolean;
  ttsInterrupt?: TtsInterruptContext;
}

export type EnqueueDelivery =
  | { kind: 'waiter' }
  /** Delivered through a blocking AgentVoice tool instead of a poll. */
  | { kind: 'tool_interrupt'; aborted: PendingWait[]; annotated: PendingWait[] }
  | { kind: 'queued'; queueLen: number };

interface PendingWaiter {
  resolve: (turn: VoiceTurn | null) => void;
  timer: NodeJS.Timeout;
}

const INTERRUPT_PHRASES = [
  /^(?:please\s+)?(?:stop|cancel|abort|quit)\b/i,
  /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:stop|cancel|abort|quit)\b/i,
];

function detectInterrupt(text: string): boolean {
  return INTERRUPT_PHRASES.some((re) => re.test(text));
}

/**
 * A single shared queue for the default session.
 * Extend to a Map<sessionKey, VoiceTurnQueue> if multi-session is needed.
 */
class VoiceTurnQueue {
  private readonly queue: VoiceTurn[] = [];
  private readonly waiters: PendingWaiter[] = [];
  private interruptFlag = false;
  private interruptFlagAt = 0;
  /** Fired when a turn is buffered because the agent is not in next_voice_turn(). */
  private onQueuedWithoutWaiter: ((queueLen: number) => void) | null = null;
  /** Fired when in-flight AgentVoice tool calls received this turn. */
  private onToolsInterrupted:
    | ((delivery: { aborted: PendingWait[]; annotated: PendingWait[] }, turn: VoiceTurn) => void)
    | null = null;

  setQueuedWithoutWaiterHandler(fn: ((queueLen: number) => void) | null): void {
    this.onQueuedWithoutWaiter = fn;
  }

  setToolsInterruptedHandler(
    fn:
      | ((delivery: { aborted: PendingWait[]; annotated: PendingWait[] }, turn: VoiceTurn) => void)
      | null,
  ): void {
    this.onToolsInterrupted = fn;
  }

  /**
   * Push a transcribed turn from the PWA into the queue.
   * If a waiter is already blocking on `dequeue()`, it is woken immediately.
   * Else if any AgentVoice tool call is in flight, the turn is delivered
   * through it (resolving user-facing waits, riding along on working ones) —
   * running work is never stopped just because the user spoke.
   * Otherwise the turn is buffered for a later `next_voice_turn()`.
   */
  enqueue(text: string, options?: EnqueueVoiceTurnOptions): EnqueueDelivery {
    const phraseInterrupt = detectInterrupt(text);
    const isInterrupt = Boolean(options?.isInterrupt) || phraseInterrupt;
    if (isInterrupt) {
      this.interruptFlag = true;
      this.interruptFlagAt = Date.now();
      log.info(
        {
          text: text.slice(0, 80),
          ttsBargeIn: Boolean(options?.ttsInterrupt),
        },
        'interrupt turn enqueued',
      );
    }

    const turn: VoiceTurn = {
      text,
      receivedAt: new Date().toISOString(),
      isInterrupt,
      ttsInterrupt: options?.ttsInterrupt,
    };

    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(turn);
      log.debug({ text: text.slice(0, 80) }, 'turn delivered to waiting poll');
      return { kind: 'waiter' };
    }

    // No next_voice_turn waiter — hand the turn to whichever AgentVoice tool
    // the agent is sitting in right now.
    const delivery = interruptPendingWaits({
      user_turn: turn.text,
      is_interrupt: turn.isInterrupt,
      received_at: turn.receivedAt,
      tts_interrupt: turn.ttsInterrupt,
    });
    if (delivery.aborted.length > 0 || delivery.annotated.length > 0) {
      log.info(
        {
          aborted: delivery.aborted.map((w) => w.tool),
          annotated: delivery.annotated.map((w) => w.tool),
          text: turn.text.slice(0, 80),
        },
        'turn delivered through in-flight AgentVoice tool(s)',
      );
      this.onToolsInterrupted?.(delivery, turn);
      // Annotated tools keep working; the turn still needs to be dequeueable if
      // the agent polls before that work finishes.
      if (delivery.aborted.length === 0) {
        this.queue.push(turn);
        this.onQueuedWithoutWaiter?.(this.queue.length);
      }
      return { kind: 'tool_interrupt', ...delivery };
    }

    this.queue.push(turn);
    log.debug({ queueLen: this.queue.length }, 'turn queued (no waiter)');
    // Voice agent is mid-tool (not polling) — surface pending so status checks notice.
    this.onQueuedWithoutWaiter?.(this.queue.length);
    return { kind: 'queued', queueLen: this.queue.length };
  }

  /**
   * Dequeue the next voice turn, waiting up to `timeoutMs` ms.
   * Returns `null` on timeout (the agent should call again).
   */
  dequeue(timeoutMs = 30_000): Promise<VoiceTurn | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }

    return new Promise<VoiceTurn | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      this.waiters.push({ resolve, timer });
    });
  }

  /** Check and reset recent user authorization for a destructive stop action. */
  checkAndClearInterrupt(): boolean {
    const v = this.interruptFlag && Date.now() - this.interruptFlagAt <= 120_000;
    this.interruptFlag = false;
    this.interruptFlagAt = 0;
    return v;
  }

  /** Number of turns currently buffered (not yet consumed by the agent). */
  get size(): number {
    return this.queue.length;
  }

  /** Number of agent polls currently suspended waiting for a turn. */
  get waitersCount(): number {
    return this.waiters.length;
  }

  /** Drain buffered turns and cancel waiters (tests / shutdown). */
  clear(): void {
    this.queue.length = 0;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.interruptFlag = false;
    this.interruptFlagAt = 0;
  }
}

export const voiceTurnQueue = new VoiceTurnQueue();
