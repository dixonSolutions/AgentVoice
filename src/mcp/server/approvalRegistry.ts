/**
 * Approval Registry — stores pending agent-to-user requests as deferred promises.
 *
 * When Cursor's agent calls `request_user_input` or `submit_plan_for_approval`, the
 * MCP tool handler registers a deferred promise here. The tool call blocks (long-poll)
 * until the PWA user answers and POSTs back via the control WebSocket
 * `approval_response` message, which resolves the promise and unblocks the tool call.
 *
 * A new voice/text turn can also resolve pending waits early with
 * `interrupted_by_voice_turn` so Cursor sees the utterance as tool output immediately.
 *
 * Two request types share the same registry:
 *   - user_input  : free-text / yes-no / choice questions
 *   - plan        : multi-step plan accept / reject / modify
 */

import { randomUUID } from 'node:crypto';
import { childLogger } from '../../log.js';
import type { TtsInterruptContext } from '../../voice/ttsInterrupt.js';

const log = childLogger('approval-registry');

// ── Types ─────────────────────────────────────────────────────────────────

export type InputType = 'yesno' | 'choice' | 'freetext';

export interface UserInputRequest {
  kind: 'user_input';
  request_id: string;
  question: string;
  input_type: InputType;
  options?: string[];
}

export interface PlanApprovalRequest {
  kind: 'plan_approval';
  request_id: string;
  title: string;
  steps: string[];
  estimated_impact?: string;
}

export type ApprovalRequest = UserInputRequest | PlanApprovalRequest;

export interface UserInputResponse {
  kind: 'user_input';
  answer: string;
}

export interface PlanApprovalResponse {
  kind: 'plan_approval';
  decision: 'approved' | 'rejected' | 'modified';
  notes?: string;
}

/** Voice/text turn arrived while the agent was blocked on an approval tool. */
export interface InterruptedByVoiceTurnResponse {
  kind: 'interrupted_by_voice_turn';
  user_turn: string;
  is_interrupt: boolean;
  received_at: string;
  tts_interrupt?: TtsInterruptContext;
}

export type ApprovalResponse =
  | UserInputResponse
  | PlanApprovalResponse
  | InterruptedByVoiceTurnResponse;

export interface VoiceTurnInterruptPayload {
  user_turn: string;
  is_interrupt: boolean;
  received_at: string;
  tts_interrupt?: TtsInterruptContext;
}

interface Deferred {
  resolve: (value: ApprovalResponse) => void;
  reject: (reason: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// ── Registry ──────────────────────────────────────────────────────────────

const pending = new Map<string, Deferred>();
const pendingPayloads = new Map<string, ApprovalRequest>();

/**
 * Register a new pending request. Returns the `request_id` and a Promise that
 * resolves when the user responds, or rejects on timeout.
 */
export function registerRequest(
  requestFactory: (request_id: string) => ApprovalRequest,
  timeoutMs: number,
): { request_id: string; promise: Promise<ApprovalResponse> } {
  const request_id = randomUUID();
  const payload = requestFactory(request_id);
  pendingPayloads.set(request_id, payload);

  const promise = new Promise<ApprovalResponse>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      if (pending.has(request_id)) {
        pending.delete(request_id);
        pendingPayloads.delete(request_id);
        log.warn({ request_id }, 'approval request timed out');
        reject(new Error(`User did not respond within ${Math.round(timeoutMs / 1000)}s`));
      }
    }, timeoutMs);

    pending.set(request_id, { resolve, reject, timeoutHandle });
  });

  return { request_id, promise };
}

/**
 * Resolve a pending request with the user's response.
 * Called when the PWA sends an `approval_response` WS message.
 * Returns true if the request_id was found and resolved.
 */
export function resolveRequest(request_id: string, response: ApprovalResponse): boolean {
  const deferred = pending.get(request_id);
  if (!deferred) {
    log.warn({ request_id }, 'resolveRequest: no pending request for id');
    return false;
  }
  clearTimeout(deferred.timeoutHandle);
  pending.delete(request_id);
  pendingPayloads.delete(request_id);
  deferred.resolve(response);
  log.info({ request_id, kind: response.kind }, 'approval request resolved');
  return true;
}

/** Cancel a pending request (e.g. on WS disconnect). */
export function cancelRequest(request_id: string, reason = 'Cancelled'): boolean {
  const deferred = pending.get(request_id);
  if (!deferred) return false;
  clearTimeout(deferred.timeoutHandle);
  pending.delete(request_id);
  pendingPayloads.delete(request_id);
  deferred.reject(new Error(reason));
  return true;
}

/** Cancel all pending requests (e.g. on server shutdown). */
export function cancelAllRequests(reason = 'Bridge shutting down'): void {
  for (const [id] of pending) {
    cancelRequest(id, reason);
  }
}

/**
 * Resolve every pending approval/input wait with a voice-turn interrupt.
 * Used when the user speaks/types while Cursor is blocked in those MCP tools —
 * the tool returns immediately with the utterance as output (Cursor injects it
 * like any other tool result).
 *
 * Returns the aborted request payloads (for UI dismiss notifications).
 */
export function interruptAllPendingWithVoiceTurn(
  payload: VoiceTurnInterruptPayload,
): ApprovalRequest[] {
  if (pending.size === 0) return [];

  const aborted: ApprovalRequest[] = [];
  const response: InterruptedByVoiceTurnResponse = {
    kind: 'interrupted_by_voice_turn',
    user_turn: payload.user_turn,
    is_interrupt: payload.is_interrupt,
    received_at: payload.received_at,
    tts_interrupt: payload.tts_interrupt,
  };

  for (const [id, deferred] of [...pending.entries()]) {
    const req = pendingPayloads.get(id);
    clearTimeout(deferred.timeoutHandle);
    pending.delete(id);
    pendingPayloads.delete(id);
    deferred.resolve(response);
    if (req) aborted.push(req);
    log.info(
      { request_id: id, kind: req?.kind, text: payload.user_turn.slice(0, 80) },
      'approval request interrupted by voice turn',
    );
  }

  return aborted;
}

export function pendingCount(): number {
  return pending.size;
}

/** Pending approval payloads for clients reconnecting after background/kill. */
export function getPendingApprovals(): ApprovalRequest[] {
  return [...pendingPayloads.values()];
}
