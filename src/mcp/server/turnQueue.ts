/**
 * Voice turn queue — bridges incoming STT transcripts to Cursor's `next_voice_turn()` polls.
 *
 * Architecture: MCP is a pull protocol. The bridge cannot push voice turns to Cursor;
 * instead, incoming turns are enqueued here and Cursor calls `next_voice_turn()` to dequeue.
 *
 * Long-poll pattern: if no turn is ready, `dequeue()` suspends until one arrives or the
 * timeout elapses. This keeps latency low (Cursor hears the turn immediately) without
 * busy-polling.
 *
 * When Cursor is blocked in `request_user_input` / `submit_plan_for_approval` (no
 * `next_voice_turn` waiter), enqueue aborts those waits and delivers the utterance as
 * that tool's result — the same inject-as-tool-output path Cursor uses for other tools.
 *
 * See docs/16-mcp-server-cursor-as-brain.md § 8.1 / § 8.4.
 */

import { childLogger } from '../../log.js';
import type { TtsInterruptContext } from '../../voice/ttsInterrupt.js';
import {
  interruptAllPendingWithVoiceTurn,
  type ApprovalRequest,
} from './approvalRegistry.js';

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
  | { kind: 'approval_interrupt'; aborted: ApprovalRequest[] }
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
  /** Fired when a turn is buffered because Cursor is not currently in next_voice_turn(). */
  private onQueuedWithoutWaiter: ((queueLen: number) => void) | null = null;
  /** Fired when pending approval/input waits were resolved by this turn. */
  private onApprovalsInterrupted:
    | ((aborted: ApprovalRequest[], turn: VoiceTurn) => void)
    | null = null;

  setQueuedWithoutWaiterHandler(fn: ((queueLen: number) => void) | null): void {
    this.onQueuedWithoutWaiter = fn;
  }

  setApprovalsInterruptedHandler(
    fn: ((aborted: ApprovalRequest[], turn: VoiceTurn) => void) | null,
  ): void {
    this.onApprovalsInterrupted = fn;
  }

  /**
   * Push a transcribed turn from the PWA into the queue.
   * If a waiter is already blocking on `dequeue()`, it is woken immediately.
   * Else if approval/input tools are waiting, they are resolved with this turn
   * (not queued — delivered as MCP tool output).
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

    // No next_voice_turn waiter — inject into blocking approval/input tools if any.
    const aborted = interruptAllPendingWithVoiceTurn({
      user_turn: turn.text,
      is_interrupt: turn.isInterrupt,
      received_at: turn.receivedAt,
      tts_interrupt: turn.ttsInterrupt,
    });
    if (aborted.length > 0) {
      log.info(
        { aborted: aborted.length, text: turn.text.slice(0, 80) },
        'turn delivered by interrupting approval wait(s)',
      );
      this.onApprovalsInterrupted?.(aborted, turn);
      return { kind: 'approval_interrupt', aborted };
    }

    this.queue.push(turn);
    log.debug({ queueLen: this.queue.length }, 'turn queued (no waiter)');
    // Voice agent is mid-tool (not polling) — surface pending so status checks notice.
    this.onQueuedWithoutWaiter?.(this.queue.length);
    return { kind: 'queued', queueLen: this.queue.length };
  }

  /**
   * Dequeue the next voice turn, waiting up to `timeoutMs` ms.
   * Returns `null` on timeout (Cursor should call again).
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

  /** Number of turns currently buffered (not yet consumed by Cursor). */
  get size(): number {
    return this.queue.length;
  }

  /** Number of Cursor polls currently suspended waiting for a turn. */
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
